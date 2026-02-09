/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { GrowthChatSessionItemProvider } from './growthChatSessionItemProvider';

/**
 * Content provider for growth/educational chat sessions.
 *
 * Returns a session with a request turn in history and uses
 * `activeResponseCallback` to stream the response (markdown + confirmation).
 * The callback keeps the response active (not completed) so VS Code's
 * `confirmationAdjustedTimestamp` detects the unresolved confirmation and
 * sets `_modelState` to `NeedsInput`. A delayed refresh then causes the
 * sidebar to re-query items, at which point `handleSessionModelOverrides`
 * overrides the session status to `NeedsInput`.
 */
export class GrowthChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly _itemProvider: GrowthChatSessionItemProvider,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._logService.info('[GrowthContentProvider] constructor');
	}

	public async provideChatSessionContent(resource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		this._logService.info(`[GrowthContentProvider] provideChatSessionContent called, resource=${resource.toString()}`);

		// Only serve growth content for the known growth-tip session.
		// Untitled sessions (created when the user presses "new chat" or
		// navigates away) should get empty history so they don't re-show
		// the growth content and trap the user in a loop.
		const sessionId = resource.path.slice(1); // strip leading '/'
		if (sessionId !== GrowthChatSessionItemProvider.sessionId) {
			this._logService.info(`[GrowthContentProvider] unknown session "${sessionId}", returning empty history`);
			return { history: [], requestHandler: undefined, activeResponseCallback: undefined };
		}

		const sessionType = GrowthChatSessionItemProvider.sessionType;

		// History contains only the request turn. The response is streamed
		// via activeResponseCallback so that it stays active (not completed)
		// and VS Code can detect the pending confirmation.
		const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = [
			new vscode.ChatRequestTurn2(
				'Try Copilot',        // prompt
				undefined,            // command
				[],                   // references
				sessionType,          // participant
				[],                   // toolReferences
				undefined,            // editedFileEvents
				undefined,            // id
			),
		];

		const itemProvider = this._itemProvider;
		const logService = this._logService;

		const activeResponseCallback = async (stream: vscode.ChatResponseStream, cbToken: vscode.CancellationToken) => {
			logService.info('[GrowthContentProvider] activeResponseCallback fired');

			stream.markdown('GitHub Copilot is now enabled. Try for free?\n');

			stream.confirmation(
				'GitHub Copilot is now enabled. Try for free?',
				'GitHub Copilot is now enabled. Try for free?',
				{ action: 'tryCopilot' },
				['Try for free'],
			);

			logService.info('[GrowthContentProvider] activeResponseCallback — sent markdown + confirmation, scheduling refresh');

			// After a delay, trigger a sidebar refresh so handleSessionModelOverrides
			// detects the NeedsInput model state and overrides the session status.
			setTimeout(() => {
				logService.info('[GrowthContentProvider] setTimeout fired — calling itemProvider.refresh()');
				itemProvider.refresh();
			}, 500);

			// Keep the response alive (don't resolve the promise) so the
			// confirmation stays in an active/uncompleted response. This is
			// critical: if we resolve immediately, $handleProgressComplete
			// will delete the queued progress chunks before the main thread
			// initializes the session. Resolve only on cancellation.
			await new Promise<void>(resolve => {
				if (cbToken.isCancellationRequested) {
					logService.info('[GrowthContentProvider] activeResponseCallback — token already cancelled, resolving');
					resolve();
					return;
				}
				cbToken.onCancellationRequested(() => {
					logService.info('[GrowthContentProvider] activeResponseCallback — token cancelled, resolving');
					resolve();
				});
			});

			logService.info('[GrowthContentProvider] activeResponseCallback — done');
		};

		this._logService.info(`[GrowthContentProvider] returning ChatSession — history.length=${history.length}, activeResponseCallback=function`);
		return {
			history,
			requestHandler: undefined,
			activeResponseCallback,
		};
	}
}
