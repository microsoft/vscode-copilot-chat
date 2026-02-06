/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService, ILogger } from '../../../../platform/log/common/logService';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../../common/contributions';
import { registerAddFileReferenceCommand, registerDiffCommands } from './commands';
import { initDiffState, setupDiffContextTracking } from './diffState';
import { initInProcHttpServer, startInProcHttpServer } from './inProcHttpServer';
import { cleanupStaleLockFiles, createLockFile } from './lockFile';
import { registerReadonlyContentProvider } from './readonlyContentProvider';
import { registerTools } from './tools';
import { registerSelectionChangedNotification, registerDiagnosticsChangedNotification } from './tools/push';

export class CopilotCLIContrib extends Disposable implements IExtensionContribution {
	readonly id = 'copilotCLI';

	constructor(
		@IInstantiationService _instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
	) {
		super();

		const logger = logService.createSubLogger('CopilotCLI');

		// Initialize modules with logger
		initDiffState(logger);
		initInProcHttpServer(logger);

		// Register commands
		this._register(registerAddFileReferenceCommand(logger));
		for (const d of registerDiffCommands(logger)) {
			this._register(d);
		}
		for (const d of setupDiffContextTracking()) {
			this._register(d);
		}
		this._register(registerReadonlyContentProvider());

		// Clean up any stale lockfiles from previous sessions
		const cleanedCount = cleanupStaleLockFiles(logger);
		if (cleanedCount > 0) {
			logger.info(`Cleaned up ${cleanedCount} stale lock file(s).`);
		}

		// Start the MCP server
		this._startMcpServer(logger);
	}

	private async _startMcpServer(logger: ILogger): Promise<void> {
		try {
			const { disposable, serverUri, headers } = await startInProcHttpServer({
				id: 'vscode-copilot-cli',
				serverLabel: 'VS Code Copilot CLI',
				serverVersion: '0.0.1',
				registerTools: server => {
					registerTools(server, logger);
				},
				registerPushNotifications: () => {
					for (const d of registerSelectionChangedNotification(logger)) {
						this._register(d);
					}
					for (const d of registerDiagnosticsChangedNotification(logger)) {
						this._register(d);
					}
				},
			});

			const lockFile = await createLockFile(serverUri, headers, logger);
			logger.info(`MCP server started. Lock file: ${lockFile.path}`);
			logger.info(`Server URI: ${serverUri.toString()}`);

			// Update lock file when workspace folders change
			this._register(vscode.workspace.onDidChangeWorkspaceFolders(() => {
				lockFile.update();
				logger.info('Workspace folders changed, lock file updated.');
			}));

			this._register(disposable);
			this._register({ dispose: () => lockFile.remove() });
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error(`Failed to start MCP server: ${errMsg}`);
		}
	}
}
