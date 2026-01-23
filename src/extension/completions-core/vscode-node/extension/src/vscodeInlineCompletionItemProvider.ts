/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CancellationToken,
	InlineCompletionContext,
	InlineCompletionEndOfLifeReason,
	InlineCompletionItemProvider,
	InlineCompletionList,
	InlineCompletionTriggerKind,
	PartialAcceptInfo,
	Position,
	TextDocument,
	workspace
} from 'vscode';
import { Disposable } from '../../../../../util/vs/base/common/lifecycle';
import { LineEdit } from '../../../../../util/vs/editor/common/core/edits/lineEdit';
import { TextEdit, TextReplacement } from '../../../../../util/vs/editor/common/core/edits/textEdit';
import { Range } from '../../../../../util/vs/editor/common/core/range';
import { LineBasedText } from '../../../../../util/vs/editor/common/core/text/abstractText';
import { IInstantiationService, ServicesAccessor } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { InlineEditLogger } from '../../../../inlineEdits/vscode-node/parts/inlineEditLogger';
import { GhostTextLogContext } from '../../../common/ghostTextContext';
import { ICompletionsTelemetryService } from '../../bridge/src/completionsTelemetryServiceBridge';
import { BuildInfo } from '../../lib/src/config';
import { CopilotConfigPrefix } from '../../lib/src/constants';
import { handleException } from '../../lib/src/defaultHandlers';
import { Logger } from '../../lib/src/logger';
import { isCompletionEnabledForDocument } from './config';
import { CopilotCompletionFeedbackTracker, sendCompletionFeedbackCommand } from './copilotCompletionFeedbackTracker';
import { ICompletionsExtensionStatus } from './extensionStatus';
import { GhostTextCompletionItem, GhostTextCompletionList, GhostTextProvider } from './ghostText/ghostTextProvider';

const logger = new Logger('inlineCompletionItemProvider');

function quickSuggestionsDisabled() {
	const qs = workspace.getConfiguration('editor.quickSuggestions');
	return qs.get('other') !== 'on' && qs.get('comments') !== 'on' && qs.get('strings') !== 'on';
}

export function exception(accessor: ServicesAccessor, error: unknown, origin: string, logger?: Logger) {
	if (error instanceof Error && error.name === 'Canceled') {
		// these are VS Code cancellations
		return;
	}
	if (error instanceof Error && error.name === 'CodeExpectedError') {
		// expected errors from VS Code
		return;
	}
	const telemetryService = accessor.get(ICompletionsTelemetryService);
	telemetryService.sendGHTelemetryException(error, 'codeUnification.completions.exception');
	handleException(accessor, error, origin, logger);
}

/** @public */
export class CopilotInlineCompletionItemProvider extends Disposable implements InlineCompletionItemProvider {
	private readonly copilotCompletionFeedbackTracker: CopilotCompletionFeedbackTracker;
	private readonly ghostTextProvider: GhostTextProvider;
	private readonly inlineEditLogger: InlineEditLogger;

	public onDidChange = undefined;
	public handleListEndOfLifetime: InlineCompletionItemProvider['handleListEndOfLifetime'] = undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICompletionsTelemetryService private readonly telemetryService: ICompletionsTelemetryService,
		@ICompletionsExtensionStatus private readonly extensionStatusService: ICompletionsExtensionStatus,
	) {
		super();
		this.copilotCompletionFeedbackTracker = this._register(this.instantiationService.createInstance(CopilotCompletionFeedbackTracker));
		this.ghostTextProvider = this.instantiationService.createInstance(GhostTextProvider);
		this.inlineEditLogger = this.instantiationService.createInstance(InlineEditLogger);
	}

	async provideInlineCompletionItems(
		doc: TextDocument,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken
	): Promise<GhostTextCompletionList | undefined> {
		const logContext = new GhostTextContext(doc.uri.toString(), doc.version, context);
		try {
			return await this._provideInlineCompletionItems(doc, position, context, logContext, token);
		} catch (e) {
			logContext.setError(e);
			this.telemetryService.sendGHTelemetryException(e, 'codeUnification.completions.exception');
		} finally {
			this.inlineEditLogger.add(logContext);
		}
	}

	private async _provideInlineCompletionItems(
		doc: TextDocument,
		position: Position,
		context: InlineCompletionContext,
		logContext: GhostTextLogContext,
		token: CancellationToken
	): Promise<GhostTextCompletionList | undefined> {
		if (context.triggerKind === InlineCompletionTriggerKind.Automatic) {
			if (!this.instantiationService.invokeFunction(isCompletionEnabledForDocument, doc)) {
				return;
			}
			if (this.extensionStatusService.kind === 'Error') {
				return;
			}
		}
		const copilotConfig = workspace.getConfiguration(CopilotConfigPrefix);
		// Constraining the generated inline completion to match selectedCompletionInfo sandbags Copilot pretty hard, as
		// typically it's just the first entry in the list alphabetically.  But if we generate a result that doesn't
		// match it, VS Code won't show it to the user unless the completion dropdown is dismissed. Historically we've
		// chosen to favor completion quality, but this option allows opting into or out of generating a completion that
		// VS Code will actually show.
		if (!copilotConfig.get('respectSelectedCompletionInfo', quickSuggestionsDisabled() || BuildInfo.isPreRelease())) {
			context = { ...context, selectedCompletionInfo: undefined };
		}

		try {
			let items = await this.ghostTextProvider.provideInlineCompletionItems(doc, position, context, logContext, token);

			if (!items) {
				if (token.isCancellationRequested) {
					logContext.setIsSkipped();
				}
				return undefined;
			}

			// If the language client provides a list of items, we want to add the send feedback command to it.
			if (Array.isArray(items)) {
				items = { items };
			}

			this.logSuggestion(logContext, doc, items);

			return {
				...items,
				commands: [sendCompletionFeedbackCommand],
			};
		} catch (e) {
			this.instantiationService.invokeFunction(exception, e, '._provideInlineCompletionItems', logger);
			logContext.setError(e);
		}
	}

	handleDidShowCompletionItem(item: GhostTextCompletionItem) {
		try {
			this.copilotCompletionFeedbackTracker.trackItem(item);
			return this.ghostTextProvider.handleDidShowCompletionItem(item);
		} catch (e) {
			this.instantiationService.invokeFunction(exception, e, '.handleDidShowCompletionItem', logger);
		}
	}

	handleDidPartiallyAcceptCompletionItem(
		item: GhostTextCompletionItem,
		acceptedLengthOrInfo: number | PartialAcceptInfo
	) {
		try {
			return this.ghostTextProvider.handleDidPartiallyAcceptCompletionItem(item, acceptedLengthOrInfo);
		} catch (e) {
			this.instantiationService.invokeFunction(exception, e, '.handleDidPartiallyAcceptCompletionItem', logger);
		}
	}

	handleEndOfLifetime(completionItem: GhostTextCompletionItem, reason: InlineCompletionEndOfLifeReason) {
		try {
			return this.ghostTextProvider.handleEndOfLifetime(completionItem, reason);
		} catch (e) {
			this.instantiationService.invokeFunction(exception, e, '.handleEndOfLifetime', logger);
		}
	}

	private logSuggestion(
		logContext: GhostTextLogContext,
		doc: TextDocument,
		items: InlineCompletionList
	) {
		if (items.items.length === 0) {
			logContext.markAsNoSuggestions();
			logContext.addLog('No inline completion items provided');
			return;
		}
		const firstItem = items.items[0];
		if (!firstItem.range) {
			logContext.addLog('Inline completion item has no range');
			return;
		}
		if (typeof firstItem.insertText !== 'string') {
			logContext.addLog('Inline completion item has non-string insertText');
			return;
		}

		const text = new LineBasedText(lineNumber => doc.lineAt(lineNumber - 1).text, doc.lineCount);

		const lineEdit = LineEdit.fromTextEdit(
			new TextEdit(
				[new TextReplacement(
					new Range(firstItem.range.start.line + 1, firstItem.range.start.character + 1, firstItem.range.end.line + 1, firstItem.range.end.character + 1),
					firstItem.insertText,
				)],
			),
			text
		);

		const patch = lineEdit.humanReadablePatch(text.getLines());

		logContext.setResult(patch);
	}
}
