/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ChatEndpoint } from '../../../platform/endpoint/node/chatEndpoint';
import { NextCursorLinePrediction } from '../../../platform/inlineEdits/common/dataTypes/nextCursorLinePrediction';
import * as xtabPromptOptions from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { parseLintOptionString } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { StatelessNextEditTelemetryBuilder } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { ILogger } from '../../../platform/log/common/logService';
import { OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { backwardCompatSetting } from '../../../util/common/backwardCompatSetting';
import { ErrorUtils } from '../../../util/common/errors';
import { Result } from '../../../util/common/result';
import { TokenizerType } from '../../../util/common/tokenizer';
import { assertNever } from '../../../util/vs/base/common/assert';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LintErrors } from '../common/lintErrors';
import { constructTaggedFile, getUserPrompt, PromptPieces } from '../common/promptCrafting';
import { constructMessages } from './xtabUtils';

export class XtabNextCursorPredictor {

	private isDisabled: boolean;

	constructor(
		private readonly computeTokens: (text: string) => number,
		@IInstantiationService private readonly instaService: IInstantiationService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IExperimentationService private readonly expService: IExperimentationService,
		@ILanguageDiagnosticsService private readonly langDiagService: ILanguageDiagnosticsService,
	) {
		this.isDisabled = false;
	}

	public determineEnablement(): NextCursorLinePrediction | undefined {
		if (this.isDisabled) {
			return undefined;
		}

		// the cast is for backward compatibility with older experiments
		const originalNextCursorLinePrediction = this.configService.getExperimentBasedConfig(ConfigKey.InlineEditsNextCursorPredictionEnabled, this.expService) as (NextCursorLinePrediction | boolean | undefined);

		switch (originalNextCursorLinePrediction) {
			case true:
				return NextCursorLinePrediction.OnlyWithEdit;

			case false:
			case undefined:
				return undefined;

			// for backward compatibility
			case NextCursorLinePrediction.OnlyWithEdit:
			case NextCursorLinePrediction.Jump:
				return NextCursorLinePrediction.OnlyWithEdit;

			default:
				assertNever(originalNextCursorLinePrediction);
		}
	}


	public async predictNextCursorPosition(promptPieces: PromptPieces, parentTracer: ILogger, telemetryBuilder: StatelessNextEditTelemetryBuilder | undefined, cancellationToken: CancellationToken): Promise<Result</* zero-based line number */ number, Error>> {

		const tracer = parentTracer.createSubLogger('predictNextCursorPosition');

		const systemMessage = `Your task is to predict the next line number in the current file where the developer is most likely to make their next edit, using the provided context. If you don't think anywhere is a good next line jump target, just output the current line number of the cursor. Make sure to just output the line number and nothing else (no explanation, reasoning, etc.).`;

		const maxTokens = this.configService.getExperimentBasedConfig(ConfigKey.Advanced.InlineEditsNextCursorPredictionCurrentFileMaxTokens, this.expService);

		const currentFileContentR = constructTaggedFile(
			promptPieces.currentDocument,
			promptPieces.editWindowLinesRange,
			promptPieces.areaAroundEditWindowLinesRange,
			{
				...promptPieces.opts,
				currentFile: {
					...promptPieces.opts.currentFile,
					maxTokens,
					includeTags: false,
				}
			},
			this.computeTokens,
			{
				includeLineNumbers: {
					areaAroundCodeToEdit: xtabPromptOptions.IncludeLineNumbersOption.None,
					currentFileContent: xtabPromptOptions.IncludeLineNumbersOption.WithSpaceAfter
				}
			}
		);

		if (currentFileContentR.isError()) {
			tracer.trace(`Failed to construct tagged file: ${currentFileContentR.err}`);
			return Result.fromString(currentFileContentR.err);
		}

		const { clippedTaggedCurrentDoc, areaAroundCodeToEdit } = currentFileContentR.val;

		// Get lint diagnostics if enabled for cursor prediction
		const lintOptions = this.determineLintOptions();
		const lintErrors = new LintErrors(promptPieces.activeDoc.id, promptPieces.currentDocument, this.langDiagService);

		const includeLineNumbersInRecentSnippets = backwardCompatSetting<boolean, xtabPromptOptions.IncludeLineNumbersOption>(
			this.configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsNextCursorPredictionRecentSnippetsIncludeLineNumbers, this.expService),
			(oldValue) => {
				if (typeof oldValue === 'boolean') {
					return oldValue ? xtabPromptOptions.IncludeLineNumbersOption.WithSpaceAfter : xtabPromptOptions.IncludeLineNumbersOption.None;
				}
				return oldValue;
			}
		);

		const newPromptPieces = new PromptPieces(
			promptPieces.currentDocument,
			promptPieces.editWindowLinesRange,
			promptPieces.areaAroundEditWindowLinesRange,
			promptPieces.activeDoc,
			promptPieces.xtabHistory,
			clippedTaggedCurrentDoc.lines,
			areaAroundCodeToEdit,
			promptPieces.langCtx,
			promptPieces.aggressivenessLevel,
			lintErrors,
			this.computeTokens,
			{
				...promptPieces.opts,
				includePostScript: false,
				lintOptions,
				recentlyViewedDocuments: {
					...promptPieces.opts.recentlyViewedDocuments,
					includeLineNumbers: includeLineNumbersInRecentSnippets,
				},
			},
		);

		const { prompt: userMessage } = getUserPrompt(newPromptPieces);

		const messages = constructMessages({
			systemMsg: systemMessage,
			userMsg: userMessage
		});

		telemetryBuilder?.setCursorJumpPrompt(messages);

		const modelName = this.configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsNextCursorPredictionModelName, this.expService);
		if (modelName === undefined) {
			tracer.trace('Model name for cursor prediction is not defined; skipping prediction');
			return Result.fromString('modelNameNotDefined');
		}
		telemetryBuilder?.setCursorJumpModelName(modelName);

		const url = this.configService.getConfig(ConfigKey.TeamInternal.InlineEditsNextCursorPredictionUrl);
		const secretKey = this.configService.getConfig(ConfigKey.TeamInternal.InlineEditsNextCursorPredictionApiKey);

		const endpoint = this.instaService.createInstance(ChatEndpoint, {
			id: modelName,
			name: 'nes.nextCursorPosition',
			urlOrRequestMetadata: url ? url : { type: RequestType.ProxyChatCompletions },
			model_picker_enabled: false,
			is_chat_default: false,
			is_chat_fallback: false,
			version: '',
			capabilities: {
				type: 'chat',
				family: '',
				tokenizer: TokenizerType.CL100K,
				limits: undefined,
				supports: {
					parallel_tool_calls: false,
					tool_calls: false,
					streaming: true,
					vision: false,
					prediction: false,
					thinking: false
				}
			},
		});

		const maxResponseTokens = this.configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsNextCursorPredictionMaxResponseTokens, this.expService);

		let requestOptions: OptionalChatRequestParams = {
			max_tokens: maxResponseTokens,
		};

		if (secretKey) {
			requestOptions = { ...requestOptions, secretKey };
		}

		const response = await endpoint.makeChatRequest2(
			{
				messages,
				debugName: 'nes.nextCursorPosition',
				finishedCb: undefined,
				location: ChatLocation.Other,
				requestOptions,
			},
			cancellationToken,
		);

		if (response.type !== ChatFetchResponseType.Success) {
			if (response.type === ChatFetchResponseType.NotFound) {
				tracer.trace('Next cursor position prediction endpoint not found; disabling predictor for current session.');
				this.isDisabled = true;
			}
			return Result.fromString(`fetchError:${response.type}`);
		}

		try {
			telemetryBuilder?.setCursorJumpResponse(response.value);
			const trimmed = response.value.trim();
			const lineNumber = parseInt(trimmed, 10);
			if (isNaN(lineNumber)) {
				return Result.fromString(`gotNaN`);
			}
			if (lineNumber < 0) {
				return Result.fromString(`negativeLineNumber`);
			}
			if (lineNumber < clippedTaggedCurrentDoc.keptRange.start || clippedTaggedCurrentDoc.keptRange.endExclusive <= lineNumber) {
				return Result.fromString(`modelNotSeenLineNumber`);
			}

			return Result.ok(lineNumber);
		} catch (err: unknown) {
			tracer.trace(`Failed to parse predicted line number from response '${response.value}': ${err}`);
			return Result.fromString(`failedToParseLine:"${response.value}". Error ${ErrorUtils.fromUnknown(err).message}`);
		}
	}

	private determineLintOptions(): xtabPromptOptions.LintOptions | undefined {
		const localLintOptions = this.configService.getConfig(ConfigKey.TeamInternal.InlineEditsNextCursorPredictionLintOptions);
		if (localLintOptions) {
			return localLintOptions;
		}

		const expLintOptions = this.configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsNextCursorPredictionLintOptionsString, this.expService);
		if (!expLintOptions) {
			return undefined;
		}

		return parseLintOptionString(expLintOptions);
	}
}

