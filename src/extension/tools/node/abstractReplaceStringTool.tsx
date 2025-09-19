/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CHAT_MODEL, IConfigurationService } from '../../../platform/configuration/common/configurationService';
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
import { Iterable } from '../../../util/vs/base/common/iterator';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseTextEditPart, EndOfLine, Position as ExtPosition, LanguageModelPromptTsxPart, LanguageModelToolResult, TextEdit } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { CellOrNotebookEdit, processFullRewriteNotebookEdits } from '../../prompts/node/codeMapper/codeMapper';
import { ToolName } from '../common/toolNames';
import { ICopilotTool } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { ActionType } from './applyPatch/parser';
import { CorrectedEditResult, healReplaceStringParams } from './editFileHealing';
import { EditFileResult, IEditedFile } from './editFileToolResult';
import { EditError, NoChangeError, NoMatchError, applyEdit, canExistingFileBeEdited, createEditConfirmation } from './editFileToolUtils';
import { sendEditNotebookTelemetry } from './editNotebookTool';
import { assertFileNotContentExcluded, resolveToolInputPath } from './toolUtils';

export interface IAbstractReplaceStringInput {
	filePath: string;
	oldString: string;
	newString: string;
}

export interface IPrepareEdit {
	document: NotebookDocumentSnapshot | TextDocumentSnapshot | undefined;
	uri: URI;
	didHeal: boolean;
	input: IAbstractReplaceStringInput;
	generatedEdit: { success: true; textEdits: vscode.TextEdit[]; notebookEdits?: CellOrNotebookEdit[] } | { success: false; errorMessage: string };
}


export abstract class AbstractReplaceStringTool<T extends { explanation: string }> implements ICopilotTool<T> {
	protected _promptContext: IBuildPromptContext | undefined;

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
		@ITelemetryService protected readonly telemetryService: ITelemetryService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
	) { }

	public abstract invoke(options: vscode.LanguageModelToolInvocationOptions<T>, token: vscode.CancellationToken): Promise<LanguageModelToolResult>;

	protected abstract toolName(): ToolName;

	protected abstract urisForInput(input: T): readonly URI[];

	protected async prepareEditsForFile(options: vscode.LanguageModelToolInvocationOptions<T>, input: IAbstractReplaceStringInput, token: vscode.CancellationToken): Promise<IPrepareEdit> {
		const uri = resolveToolInputPath(input.filePath, this.promptPathRepresentationService);
		try {
			await this.instantiationService.invokeFunction(accessor => assertFileNotContentExcluded(accessor, uri));
		} catch (error) {
			this.sendReplaceTelemetry('invalidFile', options, input, undefined, undefined, undefined);
			throw error;
		}

		// Validate parameters
		if (!input.filePath || input.oldString === undefined || input.newString === undefined || !this._promptContext) {
			this.sendReplaceTelemetry('invalidStrings', options, input, undefined, undefined, undefined);
			throw new Error('Invalid input');
		}

		// Sometimes the model replaces an empty string in a new file to create it. Allow that pattern.
		const exists = await this.instantiationService.invokeFunction(canExistingFileBeEdited, uri);
		if (!exists) {
			return {
				uri,
				didHeal: false,
				document: undefined,
				generatedEdit: input.oldString
					? { success: false, errorMessage: `File does not exist: ${input.filePath}. Use the ${ToolName.CreateFile} tool to create it, or correct your filepath.` }
					: { success: true, textEdits: [TextEdit.insert(new ExtPosition(0, 0), input.newString)] },
				input,
			};
		}

		const isNotebook = this.notebookService.hasSupportedNotebooks(uri);
		const document = isNotebook ?
			await this.workspaceService.openNotebookDocumentAndSnapshot(uri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model)) :
			await this.workspaceService.openTextDocumentAndSnapshot(uri);

		const didHealRef = { didHeal: false };
		try {
			if (input.oldString === input.newString) {
				throw new NoChangeError('Input and output are identical', input.filePath);
			}

			const { updatedFile, edits } = await this.generateEdit(uri, document, options, input, didHealRef, token);
			let notebookEdits: (vscode.NotebookEdit | [URI, vscode.TextEdit[]])[] | undefined;
			if (document instanceof NotebookDocumentSnapshot) {
				const telemetryOptions: NotebookEditGenerationTelemtryOptions = {
					model: options.model ? this.endpointProvider.getChatEndpoint(options.model).then(m => m.name) : undefined,
					requestId: this._promptContext.requestId,
					source: NotebookEditGenrationSource.stringReplace,
				};

				notebookEdits = await Iterable.asyncToArray(processFullRewriteNotebookEdits(document.document, updatedFile, this.alternativeNotebookEditGenerator, telemetryOptions, token));
				sendEditNotebookTelemetry(this.telemetryService, this.endpointProvider, 'stringReplace', document.uri, this._promptContext.requestId, options.model ?? this._promptContext.request?.model);
			}

			void this.sendReplaceTelemetry('success', options, input, document.getText(), isNotebook, didHealRef.didHeal);
			return { document, uri, input, didHeal: didHealRef.didHeal, generatedEdit: { success: true, textEdits: edits, notebookEdits } };
		} catch (error) {
			// Enhanced error message with more helpful details
			let errorMessage = 'String replacement failed: ';
			let outcome: string;

			if (error instanceof NoMatchError) {
				outcome = input.oldString.match(/Lines \d+-\d+ omitted/) ?
					'oldStringHasOmittedLines' :
					input.oldString.includes('{…}') ?
						'oldStringHasSummarizationMarker' :
						input.oldString.includes('/*...*/') ?
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

			void this.sendReplaceTelemetry(outcome, options, input, document.getText(), isNotebook, didHealRef.didHeal);

			return { document, uri, input, didHeal: didHealRef.didHeal, generatedEdit: { success: false, errorMessage } };
		}
	}

	protected async applyAllEdits(options: vscode.LanguageModelToolInvocationOptions<T>, edits: IPrepareEdit[], token: vscode.CancellationToken) {
		if (!this._promptContext?.stream) {
			throw new Error('no prompt context found');
		}

		const fileResults: IEditedFile[] = [];
		const existingDiagnosticMap = new ResourceMap<vscode.Diagnostic[]>();

		for (const { document, uri, generatedEdit } of edits) {
			if (document && !existingDiagnosticMap.has(document.uri)) {
				existingDiagnosticMap.set(document.uri, this.languageDiagnosticsService.getDiagnostics(document.uri));
			}
			const existingDiagnostics = document ? existingDiagnosticMap.get(document.uri)! : [];
			const isNotebook = this.notebookService.hasSupportedNotebooks(uri);

			if (!generatedEdit.success) {
				fileResults.push({ operation: ActionType.UPDATE, uri, isNotebook, existingDiagnostics, error: generatedEdit.errorMessage });
				continue;
			}

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

			this._promptContext.stream.markdown('\n```\n');
			this._promptContext.stream.codeblockUri(uri, true);

			if (generatedEdit.notebookEdits) {
				const uriToEdit = document?.uri ?? uri;
				this._promptContext.stream.notebookEdit(uriToEdit, []);
				for (const edit of generatedEdit.notebookEdits) {
					if (edit instanceof Array) {
						this._promptContext.stream.textEdit(edit[0], edit[1]);
					} else {
						this._promptContext.stream.notebookEdit(uriToEdit, edit);
					}
				}
				this._promptContext.stream.notebookEdit(uriToEdit, true);
			} else {
				for (const edit of generatedEdit.textEdits) {
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

				fileResults.push({ operation: ActionType.UPDATE, uri, isNotebook, existingDiagnostics });
			}

			this._promptContext.stream.markdown('\n```\n');
		}

		return new LanguageModelToolResult([
			new LanguageModelPromptTsxPart(
				await renderPromptElementJSON(
					this.instantiationService,
					EditFileResult,
					{ files: fileResults, diagnosticsTimeout: 2000, toolName: this.toolName(), requestId: options.chatRequestId, model: options.model },
					// If we are not called with tokenization options, have _some_ fake tokenizer
					// otherwise we end up returning the entire document
					options.tokenizationOptions ?? {
						tokenBudget: 5000,
						countTokens: (t) => Promise.resolve(t.length * 3 / 4)
					},
					token,
				),
			)
		]);
	}

	private async generateEdit(uri: URI, document: TextDocumentSnapshot | NotebookDocumentSnapshot, options: vscode.LanguageModelToolInvocationOptions<T>, input: IAbstractReplaceStringInput, didHealRef: { didHeal: boolean }, token: vscode.CancellationToken) {
		const filePath = this.promptPathRepresentationService.getFilePath(document.uri);
		const eol = document instanceof TextDocumentSnapshot && document.eol === EndOfLine.CRLF ? '\r\n' : '\n';
		const oldString = removeLeadingFilepathComment(input.oldString, document.languageId, filePath).replace(/\r?\n/g, eol);
		const newString = removeLeadingFilepathComment(input.newString, document.languageId, filePath).replace(/\r?\n/g, eol);

		// Apply the edit using the improved applyEdit function that uses VS Code APIs
		let updatedFile: string;
		let edits: vscode.TextEdit[] = [];
		try {
			const result = await applyEdit(
				uri,
				oldString,
				newString,
				this.workspaceService,
				this.notebookService,
				this.alternativeNotebookContent,
				this._promptContext?.request?.model
			);
			updatedFile = result.updatedFile;
			edits = result.edits;
		} catch (e) {
			if (!(e instanceof NoMatchError)) {
				throw e;
			}

			if (this.experimentationService.getTreatmentVariable<boolean>('copilotchat.disableReplaceStringHealing') === true) {
				throw e; // failsafe for next release.
			}

			didHealRef.didHeal = true;

			let healed: CorrectedEditResult;
			try {
				healed = await healReplaceStringParams(
					options.model,
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
				if (healed.params.oldString === healed.params.newString) {
					throw new NoChangeError('change was identical after healing', document.uri.fsPath);
				}
			} catch (e2) {
				this.sendHealingTelemetry(options, String(e2), undefined);
				throw e; // original error
			}

			try {
				const result = await applyEdit(
					uri,
					healed.params.oldString,
					healed.params.newString,
					this.workspaceService,
					this.notebookService,
					this.alternativeNotebookContent,
					this._promptContext?.request?.model
				);
				updatedFile = result.updatedFile;
				edits = result.edits;
			} catch (e2) {
				this.sendHealingTelemetry(options, undefined, String(e2));
				throw e; // original error
			}
		}

		return { edits, updatedFile };
	}

	private async sendReplaceTelemetry(outcome: string, options: vscode.LanguageModelToolInvocationOptions<T>, input: IAbstractReplaceStringInput, file: string | undefined, isNotebookDocument: boolean | undefined, didHeal: boolean | undefined) {
		const model = await this.modelForTelemetry(options);
		const isNotebook = isNotebookDocument ? 1 : (isNotebookDocument === false ? 0 : -1);
		const isMulti = this.toolName() === ToolName.MultiReplaceString ? 1 : 0;
		/* __GDPR__
			"replaceStringToolInvoked" : {
				"owner": "roblourens",
				"comment": "The replace_string tool was invoked",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"interactionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current interaction." },
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the invocation was successful, or a failure reason" },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook, 1 = yes, 0 = no, other = unknown." },
				"didHeal": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook, 1 = yes, 0 = no, other = unknown." },
				"isMulti": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a multi-replace operation, 1 = yes, 0 = no." }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('replaceStringToolInvoked',
			{
				requestId: options.chatRequestId,
				interactionId: options.chatRequestId,
				outcome,
				model
			}, { isNotebook, didHeal: didHeal === undefined ? -1 : (didHeal ? 1 : 0), isMulti }
		);

		this.telemetryService.sendEnhancedGHTelemetryEvent('replaceStringTool', multiplexProperties({
			headerRequestId: options.chatRequestId,
			baseModel: model,
			messageText: file,
			completionTextJson: JSON.stringify(input),
			postProcessingOutcome: outcome,
		}), { isNotebook });
	}

	private async sendHealingTelemetry(options: vscode.LanguageModelToolInvocationOptions<T>, healError: string | undefined, applicationError: string | undefined) {
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

	protected async modelForTelemetry(options: vscode.LanguageModelToolInvocationOptions<T>) {
		return options.model && (await this.endpointProvider.getChatEndpoint(options.model)).model;
	}

	async resolveInput(input: T, promptContext: IBuildPromptContext): Promise<T> {
		this._promptContext = promptContext; // TODO@joyceerhl @roblourens HACK: Avoid types in the input being serialized and not deserialized when they go through invokeTool
		return input;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<T>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return this.instantiationService.invokeFunction(
			createEditConfirmation,
			this.urisForInput(options.input),
			() => '```json\n' + JSON.stringify(options.input, null, 2) + '\n```',
		);
	}
}
