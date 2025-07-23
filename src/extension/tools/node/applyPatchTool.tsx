/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptPiece, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { CHAT_MODEL, ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ObjectJsonSchema } from '../../../platform/configuration/common/jsonSchema';
import { StringTextDocumentWithLanguageId } from '../../../platform/editing/common/abstractText';
import { NotebookDocumentSnapshot } from '../../../platform/editing/common/notebookDocumentSnapshot';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IEditSurvivalTrackerService, IEditSurvivalTrackingSession } from '../../../platform/editSurvivalTracking/common/editSurvivalTrackerService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { IAlternativeNotebookContentEditGenerator, NotebookEditGenerationTelemtryOptions, NotebookEditGenrationSource } from '../../../platform/notebook/common/alternativeContentEditGenerator';
import { getDefaultLanguage } from '../../../platform/notebook/common/helpers';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService, multiplexProperties } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { removeLeadingFilepathComment } from '../../../util/common/markdown';
import { findNotebook } from '../../../util/common/notebooks';
import { mapFindFirst } from '../../../util/vs/base/common/arraysFind';
import { timeout } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { ResourceMap, ResourceSet } from '../../../util/vs/base/common/map';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseTextEditPart, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult, Position, Range, WorkspaceEdit } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ApplyPatchFormatInstructions } from '../../prompts/node/agent/agentInstructions';
import { PromptRenderer, renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { processFullRewriteNotebook } from '../../prompts/node/codeMapper/codeMapper';
import { CodeBlock } from '../../prompts/node/panel/safeElements';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { PATCH_PREFIX, PATCH_SUFFIX } from './applyPatch/parseApplyPatch';
import { ActionType, Commit, DiffError, FileChange, InvalidContextError, InvalidPatchFormatError, processPatch } from './applyPatch/parser';
import { EditFileResult, IEditedFile } from './editFileToolResult';
import { sendEditNotebookTelemetry } from './editNotebookTool';
import { assertFileOkForTool, resolveToolInputPath } from './toolUtils';

export const applyPatchWithNotebookSupportDescription: vscode.LanguageModelToolInformation = {
	name: ToolName.ApplyPatch,
	description: 'Edit text files. `apply_patch` allows you to execute a diff/patch against a text file, but the format of the diff specification is unique to this task, so pay careful attention to these instructions. To use the `apply_patch` command, you should pass a message of the following structure as \"input\":\n\n*** Begin Patch\n[YOUR_PATCH]\n*** End Patch\n\nWhere [YOUR_PATCH] is the actual content of your patch, specified in the following V4A diff format.\n\n*** [ACTION] File: [/absolute/path/to/file] -> ACTION can be one of Add, Update, or Delete.\nAn example of a message that you might pass as \"input\" to this function, in order to apply a patch, is shown below.\n\n*** Begin Patch\n*** Update File: /Users/someone/pygorithm/searching/binary_search.py\n@@class BaseClass\n@@    def search():\n-        pass\n+        raise NotImplementedError()\n\n@@class Subclass\n@@    def search():\n-        pass\n+        raise NotImplementedError()\n\n*** End Patch\nDo not use line numbers in this diff format.',
	tags: [],
	source: undefined,
	inputSchema: {
		"type": "object",
		"properties": {
			"input": {
				"type": "string",
				"description": "The edit patch to apply."
			},
			"explanation": {
				"type": "string",
				"description": "A short description of what the tool call is aiming to achieve."
			}
		},
		"required": [
			"input",
			"explanation"
		]
	} satisfies ObjectJsonSchema,
};

export interface IApplyPatchToolParams {
	input: string;
	explanation: string;
}

type DocText = Record</* URI */ string, { text: string; notebookUri?: URI }>;

export class ApplyPatchTool implements ICopilotTool<IApplyPatchToolParams> {
	public static toolName = ToolName.ApplyPatch;

	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IPromptPathRepresentationService protected readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IWorkspaceService protected readonly workspaceService: IWorkspaceService,
		@IToolsService protected readonly toolsService: IToolsService,
		@INotebookService protected readonly notebookService: INotebookService,
		@IFileSystemService protected readonly fileSystemService: IFileSystemService,
		@ILanguageDiagnosticsService protected readonly languageDiagnosticsService: ILanguageDiagnosticsService,
		@IEditSurvivalTrackerService private readonly _editSurvivalTrackerService: IEditSurvivalTrackerService,
		@IAlternativeNotebookContentService private readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@IAlternativeNotebookContentEditGenerator private readonly alternativeNotebookEditGenerator: IAlternativeNotebookContentEditGenerator,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) { }

	private getTrailingDocumentEmptyLineCount(document: vscode.TextDocument): number {
		let trailingEmptyLines = 0;
		for (let i = document.lineCount - 1; i >= 0; i--) {
			const line = document.lineAt(i);
			if (line.text.trim() === '') {
				trailingEmptyLines++;
			} else {
				break;
			}
		}
		return trailingEmptyLines;
	}

	private getTrailingArrayEmptyLineCount(lines: readonly string[]): number {
		let trailingEmptyLines = 0;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].trim() === '') {
				trailingEmptyLines++;
			} else {
				break;
			}
		}
		return trailingEmptyLines;
	}

	private async generateUpdateTextDocumentEdit(file: string, change: FileChange, workspaceEdit: WorkspaceEdit) {
		const uri = resolveToolInputPath(file, this.promptPathRepresentationService);
		const textDocument = await this.workspaceService.openTextDocument(uri);
		const newContent = removeLeadingFilepathComment(change.newContent ?? '', textDocument.languageId, file);

		const lines = newContent?.split('\n') ?? [];
		let path = uri;
		if (change.movePath) {
			const newPath = resolveToolInputPath(change.movePath, this.promptPathRepresentationService);
			workspaceEdit.renameFile(path, newPath, { overwrite: true });
			path = newPath;
		}
		workspaceEdit.replace(path, new Range(
			new Position(0, 0),
			new Position(lines.length, 0)
		), newContent);

		// Handle trailing newlines to match the original document
		const originalTrailing = this.getTrailingDocumentEmptyLineCount(textDocument);
		const newTrailing = this.getTrailingArrayEmptyLineCount(lines);

		for (let i = newTrailing; i < originalTrailing; i++) {
			workspaceEdit.insert(path, new Position(lines.length + i, 0), '\n');
		}

		// If new content is shorter than original, delete extra lines
		if (lines.length < textDocument.lineCount) {
			const newLineCount = lines.length + Math.max(originalTrailing - newTrailing, 0);
			const from = lines.length === 0 ? new Position(0, 0) : new Position(newLineCount, 0);
			workspaceEdit.delete(path, new Range(from, new Position(textDocument.lineCount, 0)));
		}

		return path;
	}

	private async getNotebookDocumentForEdit(file: string) {
		let uri = resolveToolInputPath(file, this.promptPathRepresentationService);
		uri = findNotebook(uri, this.workspaceService.notebookDocuments)?.uri || uri;
		const altDoc = await this.workspaceService.openNotebookDocumentAndSnapshot(uri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model));
		return { altDoc, uri };
	}

	private async generateUpdateNotebookDocumentEdit(altDoc: NotebookDocumentSnapshot, uri: URI, file: string, change: FileChange) {
		// Notebooks can have various formats, it could be JSON, XML, Jupytext (which is a format that depends on the code cell language).
		// Lets generate new content based on multiple formats.
		const cellLanguage = getDefaultLanguage(altDoc.document) || 'python';
		// The content thats smallest is size is the one we're after, as thats the one that would have the leading file path removed.
		const newContent = [
			removeLeadingFilepathComment(change.newContent ?? '', cellLanguage, file),
			removeLeadingFilepathComment(change.newContent ?? '', 'python', file),
			removeLeadingFilepathComment(change.newContent ?? '', 'xml', file),
			removeLeadingFilepathComment(change.newContent ?? '', 'json', file),
			removeLeadingFilepathComment(change.newContent ?? '', 'text', file),
		].reduce((a, b) => a.length < b.length ? a : b);

		const edits: (vscode.NotebookEdit | [vscode.Uri, vscode.TextEdit[]])[] = [];
		if (change.movePath) {
			const newPath = resolveToolInputPath(change.movePath, this.promptPathRepresentationService);
			// workspaceEdit.renameFile(path, newPath, { overwrite: true });
			// TODO@joyceerhl: this is a hack, it doesnt't work for regular text files either.
			uri = newPath;
		}

		const telemetryOptions: NotebookEditGenerationTelemtryOptions = {
			source: NotebookEditGenrationSource.applyPatch,
			requestId: this._promptContext?.requestId,
			model: this._promptContext?.request?.model ? this.endpointProvider.getChatEndpoint(this._promptContext?.request?.model).then(m => m.model) : undefined
		};
		await processFullRewriteNotebook(altDoc.document, newContent, {
			notebookEdit(_, notebookEdits) {
				edits.push(...(Array.isArray(notebookEdits) ? notebookEdits : [notebookEdits]));
			},
			textEdit(target, textEdits) {
				textEdits = Array.isArray(textEdits) ? textEdits : [textEdits];
				edits.push([target, textEdits]);
			},
		}, this.alternativeNotebookEditGenerator, telemetryOptions, CancellationToken.None);

		return { path: uri, edits };
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IApplyPatchToolParams>, token: vscode.CancellationToken) {
		if (!options.input.input || !this._promptContext?.stream) {
			this.sendApplyPatchTelemetry('invalidInput', options, undefined, false, undefined);
			throw new Error('Missing patch text or stream');
		}

		let commit: Commit | undefined;
		let healed: string | undefined;
		const docText: DocText = {};
		try {
			({ commit, healed } = await this.buildCommitWithHealing(options.input.input, docText, options.input.explanation, token));
		} catch (error) {
			if (error instanceof HealedError) {
				healed = error.healedPatch;
				error = error.originalError;
			}
			const notebookUri = mapFindFirst(Object.values(docText), v => v.notebookUri);

			if (error instanceof InvalidContextError) {
				this.sendApplyPatchTelemetry(error.kindForTelemetry, options, error.file, !!healed, !!notebookUri);
			} else if (error instanceof InvalidPatchFormatError) {
				this.sendApplyPatchTelemetry(error.kindForTelemetry, options, '', !!healed, !!notebookUri);
			} else {
				this.sendApplyPatchTelemetry('processPatchFailed', options, error.file, !!healed, !!notebookUri);
			}


			if (notebookUri) {
				// We have found issues with the patches generated by Model for XML, Jupytext
				// Possible there are other issues with other formats as well.
				return new LanguageModelToolResult([
					new LanguageModelTextPart('Applying patch failed with error: ' + error.message),
					new LanguageModelTextPart(`Use the ${ToolName.EditNotebook} tool to edit notebook files such as ${notebookUri}.`),
				]);

			} else {
				return new LanguageModelToolResult([
					new LanguageModelTextPart('Applying patch failed with error: ' + error.message),
				]);
			}
		}

		try {
			// Map to track edit survival sessions by document URI
			const editSurvivalTrackers = new ResourceMap<IEditSurvivalTrackingSession>();

			// Set up a response stream that will collect AI edits for telemetry
			let responseStream = this._promptContext.stream;
			if (this._promptContext.stream) {
				responseStream = ChatResponseStreamImpl.spy(this._promptContext.stream, (part) => {
					if (part instanceof ChatResponseTextEditPart && !this.notebookService.hasSupportedNotebooks(part.uri)) {
						const tracker = editSurvivalTrackers.get(part.uri);
						if (tracker) {
							tracker.collectAIEdits(part.edits);
						}
					}
				});
			}

			const resourceToOperation = new ResourceMap<ActionType>();
			const workspaceEdit = new WorkspaceEdit();
			const notebookEdits = new ResourceMap<(vscode.NotebookEdit | [vscode.Uri, vscode.TextEdit[]])[]>();
			for (const [file, changes] of Object.entries(commit.changes)) {
				let path = resolveToolInputPath(file, this.promptPathRepresentationService);
				await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, path));

				switch (changes.type) {
					case ActionType.ADD: {
						if (changes.newContent) {
							workspaceEdit.insert(path, new Position(0, 0), changes.newContent);
							resourceToOperation.set(path, ActionType.ADD);
						}
						break;
					}
					case ActionType.DELETE: {
						workspaceEdit.deleteFile(path);
						resourceToOperation.set(path, ActionType.DELETE);
						break;
					}
					case ActionType.UPDATE: {
						if (this.notebookService.hasSupportedNotebooks(resolveToolInputPath(file, this.promptPathRepresentationService))) {
							const { altDoc, uri } = await this.getNotebookDocumentForEdit(file);
							// We have found issues with the patches generated by Model for XML, Jupytext
							// Possible there are other issues with other formats as well.
							try {
								const result = await this.generateUpdateNotebookDocumentEdit(altDoc, uri, file, changes);
								notebookEdits.set(result.path, result.edits);
								path = result.path;
							} catch (error) {
								this.sendApplyPatchTelemetry('invalidNotebookEdit', options, altDoc.getText(), !!healed, true);
								return new LanguageModelToolResult([
									new LanguageModelTextPart('Applying patch failed with error: ' + error.message),
									new LanguageModelTextPart(`Use the ${ToolName.EditNotebook} tool to edit notebook files such as ${file}.`),
								]);
							}
						}
						else {
							path = await this.generateUpdateTextDocumentEdit(file, changes, workspaceEdit);
						}
						resourceToOperation.set(path, ActionType.UPDATE);
						break;
					}
				}
			}

			const files: IEditedFile[] = [];
			const handledNotebookUris = new ResourceSet();
			const editEntires = workspaceEdit.entries();
			if (notebookEdits.size > 0) {
				for (const uri of notebookEdits.keys()) {
					editEntires.push([uri, []]);
				}
			}
			for (let [uri, textEdit] of editEntires) {
				// Get the notebook URI if the document is a notebook or a notebook cell.
				const notebookUri = findNotebook(uri, this.workspaceService.notebookDocuments)?.uri ?? (this.notebookService.hasSupportedNotebooks(uri) ? uri : undefined);
				if (notebookUri) {
					if (handledNotebookUris.has(notebookUri)) {
						continue;
					}
					handledNotebookUris.add(notebookUri);
				}
				uri = notebookUri || uri;

				const existingDiagnostics = this.languageDiagnosticsService.getDiagnostics(uri);

				// Initialize edit survival tracking for text documents
				const document = notebookUri ?
					await this.workspaceService.openNotebookDocumentAndSnapshot(notebookUri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model)) :
					await this.workspaceService.openTextDocumentAndSnapshot(uri);
				if (document instanceof TextDocumentSnapshot) {
					const tracker = this._editSurvivalTrackerService.initialize(document.document);
					editSurvivalTrackers.set(uri, tracker);
				}

				if (notebookUri) {
					responseStream.notebookEdit(notebookUri, []);
					const edits = notebookEdits.get(notebookUri) || [];
					for (const edit of edits) {
						if (Array.isArray(edit)) {
							responseStream.textEdit(edit[0], edit[1]);
						} else {
							responseStream.notebookEdit(notebookUri, edit);
						}
					}
					responseStream.notebookEdit(notebookUri, true);
					sendEditNotebookTelemetry(this.telemetryService, this.endpointProvider, 'applyPatch', notebookUri, this._promptContext.requestId, options.model ?? this._promptContext.request?.model);
				} else {
					this._promptContext.stream.markdown('\n```\n');
					this._promptContext.stream.codeblockUri(notebookUri || uri, true);
					// TODO@joyceerhl hack: when an array of text edits for a single URI
					// are pushed in a single textEdit call, the edits are not applied
					const edits = Array.isArray(textEdit) ? textEdit : [textEdit];
					for (const textEdit of edits) {
						responseStream.textEdit(uri, textEdit);
					}
					responseStream.textEdit(uri, true);
					this._promptContext.stream.markdown('\n' + '```\n');
				}

				files.push({ uri, isNotebook: !!notebookUri, existingDiagnostics, operation: resourceToOperation.get(uri) ?? ActionType.UPDATE });
			}

			timeout(2000).then(() => {
				// The tool can't wait for edits to be applied, so just wait before starting the survival tracker.
				// TODO@roblourens see if this improves the survival metric, find a better fix.
				for (const tracker of editSurvivalTrackers.values()) {
					tracker.startReporter(res => {
						/* __GDPR__
							"applyPatch.trackEditSurvival" : {
								"owner": "joyceerhl",
								"comment": "Tracks how much percent of the AI edits survived after 5 minutes of accepting",
								"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
								"requestSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source from where the request was made" },
								"mapper": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The code mapper used strategy" },
								"survivalRateFourGram": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The rate between 0 and 1 of how much of the AI edit is still present in the document." },
								"survivalRateNoRevert": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The rate between 0 and 1 of how much of the ranges the AI touched ended up being reverted." },
								"didBranchChange": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Indicates if the branch changed in the meantime. If the branch changed (value is 1), this event should probably be ignored." },
								"timeDelayMs": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The time delay between the user accepting the edit and measuring the survival rate." }
							}
						*/
						res.telemetryService.sendMSFTTelemetryEvent('applyPatch.trackEditSurvival', { requestId: this._promptContext?.requestId, requestSource: 'agent', mapper: 'applyPatchTool' }, {
							survivalRateFourGram: res.fourGram,
							survivalRateNoRevert: res.noRevert,
							timeDelayMs: res.timeDelayMs,
							didBranchChange: res.didBranchChange ? 1 : 0,
						});
					});
				}
			});

			// Return the result
			const isNotebook = editEntires.length === 1 ? handledNotebookUris.size === 1 : undefined;
			this.sendApplyPatchTelemetry('success', options, undefined, !!healed, isNotebook);
			return new LanguageModelToolResult([
				new LanguageModelPromptTsxPart(
					await renderPromptElementJSON(
						this.instantiationService,
						EditFileResult,
						{ files, diagnosticsTimeout: 2000, toolName: ToolName.ApplyPatch, requestId: options.chatRequestId, model: options.model, healed },
						options.tokenizationOptions ?? {
							tokenBudget: 1000,
							countTokens: (t) => Promise.resolve(t.length * 3 / 4)
						},
						token,
					),
				)
			]);
		} catch (error) {
			const isNotebook = Object.values(docText).length === 1 ? (!!mapFindFirst(Object.values(docText), v => v.notebookUri)) : undefined;
			// TODO parser.ts could annotate DiffError with a telemetry detail if we want
			this.sendApplyPatchTelemetry('error', options, undefined, false, isNotebook);
			return new LanguageModelToolResult([
				new LanguageModelTextPart('Applying patch failed with error: ' + error.message),
			]);
		}
	}

	public alternativeDefinition(): vscode.LanguageModelToolInformation | undefined {
		if (this.configurationService.getExperimentBasedConfig<boolean>(ConfigKey.Internal.EnableApplyPatchForNotebooks, this.experimentationService)) {
			return applyPatchWithNotebookSupportDescription;
		}
	}

	/**
	 * Attempts to 'heal' a patch which we failed to apply by sending it a small
	 * cheap model (4o mini) to revise it. This is generally going to be cheaper
	 * than going to whatever big model the user has selected for it to try
	 * and do another turn.
	 */
	private async healCommit(patch: string, docs: DocText, explanation: string, token: CancellationToken) {
		const endpoint = await this.endpointProvider.getChatEndpoint(CHAT_MODEL.GPT4OMINI);
		const prompt = await PromptRenderer.create(
			this.instantiationService,
			endpoint,
			HealPatchPrompt,
			{
				patch,
				explanation,
				docs
			}
		).render(undefined, token);

		const fetchResult = await endpoint.makeChatRequest(
			'healApplyPatch',
			prompt.messages,
			undefined,
			token,
			ChatLocation.Other
		);

		if (fetchResult.type !== ChatFetchResponseType.Success) {
			return undefined;
		}

		const patchStart = fetchResult.value.lastIndexOf(PATCH_PREFIX);
		if (patchStart === -1) {
			return undefined;
		}

		const patchEnd = fetchResult.value.indexOf(PATCH_SUFFIX, patchStart);
		return patchEnd === -1 ? fetchResult.value.slice(patchStart) : fetchResult.value.slice(patchStart, patchEnd + PATCH_SUFFIX.length);
	}

	private async buildCommitWithHealing(patch: string, docText: DocText, explanation: string, token: CancellationToken): Promise<{ commit: Commit; healed?: string }> {
		try {
			return await this.buildCommit(patch, docText);
		} catch (error) {
			if (!(error instanceof DiffError)) {
				throw error;
			}

			let success = true;
			let healed: string | undefined;
			try {
				healed = await this.healCommit(patch, docText, explanation, token);

				if (!healed) {
					throw error;
				}

				const { commit } = await this.buildCommit(healed, docText);
				return { commit, healed };
			} catch (healedError) {
				success = false;
				if (healed) {
					throw new HealedError(error, healedError, healed);
				} else {
					throw error;
				}
			} finally {
				/* __GDPR__
					"applyPatchHealRate" : {
						"owner": "connor4312",
						"comment": "Records how correct the healing of a patch was",
						"success": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the input was healed" }
					}
				*/
				this.telemetryService.sendMSFTTelemetryEvent('applyPatchHealRate', {}, {
					success: success ? 1 : 0,
				});
			}
		}
	}

	private async buildCommit(patch: string, docText: DocText): Promise<{ commit: Commit }> {
		const commit = await processPatch(patch, async (uri) => {
			const vscodeUri = resolveToolInputPath(uri, this.promptPathRepresentationService);
			if (this.notebookService.hasSupportedNotebooks(vscodeUri)) {
				const notebookUri = findNotebook(vscodeUri, this.workspaceService.notebookDocuments)?.uri || vscodeUri;
				const altDoc = await this.workspaceService.openNotebookDocumentAndSnapshot(notebookUri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model));
				docText[vscodeUri.toString()] = { text: altDoc.getText(), notebookUri };
				return new StringTextDocumentWithLanguageId(altDoc.getText(), altDoc.languageId);
			} else {
				const textDocument = await this.workspaceService.openTextDocument(vscodeUri);
				docText[vscodeUri.toString()] = { text: textDocument.getText() };
				return textDocument;
			}
		});
		return { commit };
	}

	private async sendApplyPatchTelemetry(outcome: string, options: vscode.LanguageModelToolInvocationOptions<IApplyPatchToolParams>, file: string | undefined, healed: boolean, isNotebook: boolean | undefined) {
		const model = options.model && (await this.endpointProvider.getChatEndpoint(options.model)).model;

		/* __GDPR__
			"applyPatchToolInvoked" : {
				"owner": "roblourens",
				"comment": "The apply_patch tool was invoked",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"interactionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current interaction." },
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the invocation was successful, or a failure reason" },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"healed": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the input was healed" },
				"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the input was a notebook, 1 = yes, 0 = no, other = Unknown" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('applyPatchToolInvoked',
			{
				requestId: options.chatRequestId,
				interactionId: options.chatRequestId,
				outcome,
				model,
			},
			{
				healed: healed ? 1 : 0,
				isNotebook: isNotebook ? 1 : (isNotebook === false ? 0 : -1), // -1 means unknown
			},
		);

		this.telemetryService.sendEnhancedGHTelemetryEvent('applyPatchTool', multiplexProperties({
			headerRequestId: options.chatRequestId,
			baseModel: model,
			messageText: file,
			completionTextJson: options.input.input,
			postProcessingOutcome: outcome,
			healed: String(healed),
		}));
	}

	async resolveInput(input: IApplyPatchToolParams, promptContext: IBuildPromptContext): Promise<IApplyPatchToolParams> {
		this._promptContext = promptContext;
		return input;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IApplyPatchToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			presentation: 'hidden'
		};
	}
}

class HealedError extends Error {
	constructor(
		public readonly originalError: Error,
		public readonly errorWithHealing: Error,
		public readonly healedPatch: string,
	) {
		super(`Healed error: ${errorWithHealing}, original error: ${originalError}`);
	}
}

ToolRegistry.registerTool(ApplyPatchTool);

const applyPatchExample = `*** Begin Patch
*** Update File: /Users/someone/pygorithm/searching/binary_search.py
@@ class BaseClass
@@     def search():
         results = get_results()
-        results
+        return results
@@ class Subclass
@@     def search():
-        pass
+        raise NotImplementedError()
*** End Patch`;

class HealPatchPrompt extends PromptElement<{ patch: string; explanation: string; docs: DocText } & BasePromptElementProps, void> {
	override render(): PromptPiece | undefined {
		return <>
			<SystemMessage>
				You are an expert in file editing. The user has provided a patch that failed to apply because it references context that was not found precisely in the file. Your task is to fix the patch so it can be applied successfully.
				<Tag name='patchFormat'>
					The expected format for the patch is a diff format that modifications and include contextual lines around the changes. The patch should be formatted as follows:<br />
					<ApplyPatchFormatInstructions />
					The output MUST NOT actually include the string "[3 lines of pre-context]" or "[3 lines of post-context]" -- include the actual lines of context from the file. An example of a patch you might generate is shown below.<br />
					<br />
					```<br />
					{applyPatchExample}<br />
					```<br />
				</Tag>
				<Tag name='instructions'>
					1. Think carefully. Examine the provided patch, the included intent, the contents of the files it references.<br />
					2. Determine the locations in the files where the user intended the patch to be applied. Lines that don't begin with a plus "+" or "-" sign must be found verbatim in the original file, and ONLY lines to be added or removed should begin with a plus or minus sign respectively. It is very likely this rule is being broken by the invalid patch.<br />
					3. Generate the ENTIRE corrected patch. Do not omit anything.<br />
				</Tag>
			</SystemMessage>
			<UserMessage priority={1}>
				The goal of the patch is: {this.props.explanation}<br />
				<br />
				The patch I want to apply is:<br />
				<Tag name='invalidPatch'><br />
					{this.props.patch}<br />
				</Tag><br />
				<br />
				The referenced files are:<br />
				{Object.entries(this.props.docs).map(([file, { text }]) =>
					<CodeBlock code={text} uri={URI.parse(file)} priority={1} lineBasedPriority={true} />
				)}
			</UserMessage>
		</>;
	}
}
