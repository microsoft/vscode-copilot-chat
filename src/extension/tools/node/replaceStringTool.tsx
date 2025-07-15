/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CHAT_MODEL } from '../../../platform/configuration/common/configurationService';
import { IEditSurvivalTrackerService, IEditSurvivalTrackingSession } from '../../../platform/editSurvivalTracking/common/editSurvivalTrackerService';
import { NotebookDocumentSnapshot } from '../../../platform/editing/common/notebookDocumentSnapshot';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { IAlternativeNotebookContentEditGenerator, NotebookEditGenerationTelemtryOptions, NotebookEditGenrationSource } from '../../../platform/notebook/common/alternativeContentEditGenerator';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService, multiplexProperties } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { removeLeadingFilepathComment } from '../../../util/common/markdown';
import { timeout } from '../../../util/vs/base/common/async';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseTextEditPart, EndOfLine, LanguageModelPromptTsxPart, LanguageModelToolResult, WorkspaceEdit } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { processFullRewriteNotebook } from '../../prompts/node/codeMapper/codeMapper';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { ActionType } from './applyPatch/parser';
import { CorrectedEditResult, healReplaceStringParams } from './editFileHealing';
import { EditFileResult } from './editFileToolResult';
import { EditError, NoMatchError, applyEdit } from './editFileToolUtils';
import { sendEditNotebookTelemetry } from './editNotebookTool';
import { assertFileOkForTool, resolveToolInputPath } from './toolUtils';

export interface IReplaceStringToolParams {
	explanation: string;
	filePath: string;
	oldString: string;
	newString: string;
}

export class ReplaceStringTool implements ICopilotTool<IReplaceStringToolParams> {
	public static toolName = ToolName.ReplaceString;

	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IPromptPathRepresentationService protected readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IWorkspaceService protected readonly workspaceService: IWorkspaceService,
		@IToolsService protected readonly toolsService: IToolsService,
		@INotebookService protected readonly notebookService: INotebookService,
		@IFileSystemService protected readonly fileSystemService: IFileSystemService,
		@IAlternativeNotebookContentService private readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@IAlternativeNotebookContentEditGenerator private readonly alternativeNotebookEditGenerator: IAlternativeNotebookContentEditGenerator,
		@IEditSurvivalTrackerService private readonly _editSurvivalTrackerService: IEditSurvivalTrackerService,
		@ILanguageDiagnosticsService private readonly languageDiagnosticsService: ILanguageDiagnosticsService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IExperimentationService private readonly experimentationService: IExperimentationService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IReplaceStringToolParams>, token: vscode.CancellationToken) {
		const uri = resolveToolInputPath(options.input.filePath, this.promptPathRepresentationService);
		try {
			await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri));
		} catch (error) {
			this.sendReplaceTelemetry('invalidFile', options, undefined, undefined, undefined);
			throw error;
		}

		// Validate parameters
		if (!options.input.filePath || options.input.oldString === undefined || options.input.newString === undefined || !this._promptContext?.stream) {
			this.sendReplaceTelemetry('invalidStrings', options, undefined, undefined, undefined);
			throw new Error('Invalid input');
		}

		const isNotebook = this.notebookService.hasSupportedNotebooks(uri);
		const document = isNotebook ?
			await this.workspaceService.openNotebookDocumentAndSnapshot(uri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model)) :
			await this.workspaceService.openTextDocumentAndSnapshot(uri);

		const existingDiagnostics = this.languageDiagnosticsService.getDiagnostics(document.uri);

		// String replacement mode
		if (options.input.oldString !== undefined && options.input.newString !== undefined) {

			// Track edit survival
			let editSurvivalTracker: IEditSurvivalTrackingSession | undefined;
			let responseStream = this._promptContext.stream;
			if (document && document instanceof TextDocumentSnapshot) { // Only for existing text documents
				const tracker = editSurvivalTracker = this._editSurvivalTrackerService.initialize(document.document);
				responseStream = ChatResponseStreamImpl.spy(this._promptContext.stream, (part) => {
					if (part instanceof ChatResponseTextEditPart) {
						tracker.collectAIEdits(part.edits);
					}
				});
			}

			const didHealRef = { didHeal: false };
			try {
				const { workspaceEdit, updatedFile } = await this.generateEdit(uri, document, options, didHealRef, token);

				this._promptContext.stream.markdown('\n```\n');
				this._promptContext.stream.codeblockUri(uri, true);

				if (document instanceof NotebookDocumentSnapshot) {
					const telemetryOptions: NotebookEditGenerationTelemtryOptions = {
						model: options.model ? this.endpointProvider.getChatEndpoint(options.model).then(m => m.name) : undefined,
						requestId: this._promptContext.requestId,
						source: NotebookEditGenrationSource.stringReplace,
					};
					this._promptContext.stream.notebookEdit(document.uri, []);
					await processFullRewriteNotebook(document.document, updatedFile, this._promptContext.stream, this.alternativeNotebookEditGenerator, telemetryOptions, token);
					this._promptContext.stream.notebookEdit(document.uri, true);
					sendEditNotebookTelemetry(this.telemetryService, this.endpointProvider, 'stringReplace', document.uri, this._promptContext.requestId, options.model ?? this._promptContext.request?.model);
				} else {
					for (const [uri, edit] of workspaceEdit.entries()) {
						responseStream.textEdit(uri, edit);
					}
					responseStream.textEdit(uri, true);

					timeout(2000).then(() => {
						// The tool can't wait for edits to be applied, so just wait before starting the survival tracker.
						// TODO@roblourens see if this improves the survival metric, find a better fix.
						editSurvivalTracker?.startReporter(res => {
							/* __GDPR__
								"codeMapper.trackEditSurvival" : {
									"owner": "aeschli",
									"comment": "Tracks how much percent of the AI edits survived after 5 minutes of accepting",
									"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
									"requestSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source from where the request was made" },
									"mapper": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The code mapper used: One of 'fast', 'fast-lora', 'full' and 'patch'" },
									"survivalRateFourGram": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The rate between 0 and 1 of how much of the AI edit is still present in the document." },
									"survivalRateNoRevert": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The rate between 0 and 1 of how much of the ranges the AI touched ended up being reverted." },
									"didBranchChange": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Indicates if the branch changed in the meantime. If the branch changed (value is 1), this event should probably be ignored." },
									"timeDelayMs": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The time delay between the user accepting the edit and measuring the survival rate." }
								}
							*/
							res.telemetryService.sendMSFTTelemetryEvent('codeMapper.trackEditSurvival', { requestId: this._promptContext?.requestId, requestSource: 'agent', mapper: 'stringReplaceTool' }, {
								survivalRateFourGram: res.fourGram,
								survivalRateNoRevert: res.noRevert,
								timeDelayMs: res.timeDelayMs,
								didBranchChange: res.didBranchChange ? 1 : 0,
							});
						});
					});
				}

				this._promptContext.stream.markdown('\n```\n');

				void this.sendReplaceTelemetry('success', options, document.getText(), isNotebook, didHealRef.didHeal);
				return new LanguageModelToolResult([
					new LanguageModelPromptTsxPart(
						await renderPromptElementJSON(
							this.instantiationService,
							EditFileResult,
							{ files: [{ operation: ActionType.UPDATE, uri, isNotebook, existingDiagnostics }], diagnosticsTimeout: 2000, toolName: ToolName.ReplaceString, requestId: options.chatRequestId, model: options.model },
							// If we are not called with tokenization options, have _some_ fake tokenizer
							// otherwise we end up returning the entire document
							options.tokenizationOptions ?? {
								tokenBudget: 1000,
								countTokens: (t) => Promise.resolve(t.length * 3 / 4)
							},
							token,
						),
					)
				]);

			} catch (error) {
				// Enhanced error message with more helpful details
				let errorMessage = 'String replacement failed: ';
				let outcome: string;

				if (error instanceof NoMatchError) {
					outcome = options.input.oldString.includes('{…}') ?
						'oldStringHasSummarizationMarker' :
						options.input.oldString.includes('/*...*/') ?
							'oldStringHasSummarizationMarkerSemanticSearch' :
							error.kindForTelemetry;
					errorMessage += `${error.message}`;
				} else if (error instanceof EditError) {
					outcome = error.kindForTelemetry;
					errorMessage += error.message;
				} else {
					outcome = 'other';
					errorMessage += `${error.message}`;
				}

				void this.sendReplaceTelemetry(outcome, options, document.getText(), isNotebook, didHealRef.didHeal);

				// No edit, so no need to wait for diagnostics
				const diagnosticsTimeout = 0;
				return new LanguageModelToolResult([
					new LanguageModelPromptTsxPart(
						await renderPromptElementJSON(
							this.instantiationService,
							EditFileResult,
							{ files: [{ operation: ActionType.UPDATE, uri, isNotebook, existingDiagnostics, error: errorMessage }], diagnosticsTimeout, toolName: ToolName.ReplaceString, requestId: options.chatRequestId, model: options.model },
							options.tokenizationOptions ?? {
								tokenBudget: 1000,
								countTokens: (t) => Promise.resolve(t.length * 3 / 4)
							},
							token,
						),
					)
				]);
			}
		}
	}

	private async generateEdit(uri: URI, document: TextDocumentSnapshot | NotebookDocumentSnapshot, options: vscode.LanguageModelToolInvocationOptions<IReplaceStringToolParams>, didHealRef: { didHeal: boolean }, token: vscode.CancellationToken) {
		const filePath = this.promptPathRepresentationService.getFilePath(document.uri);
		const eol = document instanceof TextDocumentSnapshot && document.eol === EndOfLine.CRLF ? '\r\n' : '\n';
		const oldString = removeLeadingFilepathComment(options.input.oldString, document.languageId, filePath).replace(/\r?\n/g, eol);
		const newString = removeLeadingFilepathComment(options.input.newString, document.languageId, filePath).replace(/\r?\n/g, eol);

		// Apply the edit using the improved applyEdit function that uses VS Code APIs
		const workspaceEdit = new WorkspaceEdit();
		let updatedFile: string;
		try {
			const result = await applyEdit(
				uri,
				oldString,
				newString,
				workspaceEdit,
				this.workspaceService,
				this.notebookService,
				this.alternativeNotebookContent,
				this._promptContext?.request?.model
			);
			updatedFile = result.updatedFile;
		} catch (e) {
			if (!(e instanceof NoMatchError)) {
				throw e;
			}

			if (this.experimentationService.getTreatmentVariable<boolean>('vscode', 'copilotchat.disableReplaceStringHealing') === true) {
				throw e; // failsafe for next release.
			}

			didHealRef.didHeal = true;

			let healed: CorrectedEditResult;
			try {
				healed = await healReplaceStringParams(
					document.getText(),
					{
						explanation: options.input.explanation,
						filePath: filePath,
						oldString,
						newString,
					},
					eol,
					await this.endpointProvider.getChatEndpoint(CHAT_MODEL.GPT4OMINI),
					token
				);
			} catch (e2) {
				this.sendHealingTelemetry(options, String(e2), undefined);
				throw e; // original error
			}

			try {
				const result = await applyEdit(
					uri,
					healed.params.oldString,
					healed.params.newString,
					workspaceEdit,
					this.workspaceService,
					this.notebookService,
					this.alternativeNotebookContent,
					this._promptContext?.request?.model
				);
				updatedFile = result.updatedFile;
			} catch (e2) {
				this.sendHealingTelemetry(options, undefined, String(e2));
				throw e; // original error
			}
		}

		return { workspaceEdit, updatedFile };
	}

	private async sendReplaceTelemetry(outcome: string, options: vscode.LanguageModelToolInvocationOptions<IReplaceStringToolParams>, file: string | undefined, isNotebookDocument: boolean | undefined, didHeal: boolean | undefined) {
		const model = await this.modelForTelemetry(options);
		const isNotebook = isNotebookDocument ? 1 : (isNotebookDocument === false ? 0 : -1);
		/* __GDPR__
			"replaceStringToolInvoked" : {
				"owner": "roblourens",
				"comment": "The replace_string tool was invoked",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"interactionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current interaction." },
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the invocation was successful, or a failure reason" },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook, 1 = yes, 0 = no, other = unknown." },
				"didHeal": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook, 1 = yes, 0 = no, other = unknown." }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('replaceStringToolInvoked',
			{
				requestId: options.chatRequestId,
				interactionId: options.chatRequestId,
				outcome,
				model
			}, { isNotebook, didHeal: didHeal === undefined ? -1 : (didHeal ? 1 : 0) }
		);

		this.telemetryService.sendEnhancedGHTelemetryEvent('replaceStringTool', multiplexProperties({
			headerRequestId: options.chatRequestId,
			baseModel: model,
			messageText: file,
			completionTextJson: JSON.stringify(options.input),
			postProcessingOutcome: outcome,
		}), { isNotebook });
	}

	private async sendHealingTelemetry(options: vscode.LanguageModelToolInvocationOptions<IReplaceStringToolParams>, healError: string | undefined, applicationError: string | undefined) {
		/* __GDPR__
			"replaceStringHealingStat" : {
				"owner": "roblourens",
				"comment": "The replace_string tool was invoked",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"interactionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current interaction." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the invocation was successful, or a failure reason" },
				"healError": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Any error that happened during healing" },
				"applicationError": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Any error that happened after application" },
				"success": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook, 1 = yes, 0 = no, other = unknown." }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('replaceStringHealingStat',
			{
				requestId: options.chatRequestId,
				interactionId: options.chatRequestId,
				model: await this.modelForTelemetry(options),
				healError,
				applicationError,
			}, { success: healError === undefined && applicationError === undefined ? 1 : 0 }
		);
	}

	private async modelForTelemetry(options: vscode.LanguageModelToolInvocationOptions<IReplaceStringToolParams>) {
		return options.model && (await this.endpointProvider.getChatEndpoint(options.model)).model;
	}

	async resolveInput(input: IReplaceStringToolParams, promptContext: IBuildPromptContext): Promise<IReplaceStringToolParams> {
		this._promptContext = promptContext; // TODO@joyceerhl @roblourens HACK: Avoid types in the input being serialized and not deserialized when they go through invokeTool
		return input;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IReplaceStringToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			presentation: 'hidden'
		};
	}
}

ToolRegistry.registerTool(ReplaceStringTool);
