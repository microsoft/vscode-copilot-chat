/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps, PromptReference } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ObjectJsonSchema } from '../../../platform/configuration/common/jsonSchema';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { NotebookDocumentSnapshot } from '../../../platform/editing/common/notebookDocumentSnapshot';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { clamp } from '../../../util/vs/base/common/numbers';
import { dirname, extUriBiasedIgnorePathCase } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelToolResult, Location, MarkdownString, Range } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { CodeBlock } from '../../prompts/node/panel/safeElements';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { formatUriForFileWidget } from '../common/toolUtils';
import { assertFileNotContentExcluded, assertFileOkForTool, isFileExternalAndNeedsConfirmation, resolveToolInputPath } from './toolUtils';

export const readFileV2Description: vscode.LanguageModelToolInformation = {
	name: ToolName.ReadFile,
	description: 'Read the contents of a file. Line numbers are 1-indexed. This tool will truncate its output at 2000 lines and may be called repeatedly with offset and limit parameters to read larger files in chunks.',
	tags: ['vscode_codesearch'],
	source: undefined,
	inputSchema: {
		type: 'object',
		required: ['filePath'],
		properties: {
			filePath: {
				description: 'The absolute path of the file to read.',
				type: 'string'
			},
			offset: {
				description: 'Optional: the 1-based line number to start reading from. Only use this if the file is too large to read at once. If not specified, the file will be read from the beginning.',
				type: 'number'
			},
			limit: {
				description: 'Optional: the maximum number of lines to read. Only use this together with `offset` if the file is too large to read at once.',
				type: 'number'
			},
		}
	} satisfies ObjectJsonSchema,
};

export interface IReadFileParamsV1 {
	filePath: string;
	startLine: number;
	endLine: number;
}

export interface IReadFileParamsV2 {
	filePath: string;
	offset?: number;
	limit?: number;
}

const MAX_LINES_PER_READ = 2000;

export type ReadFileParams = IReadFileParamsV1 | IReadFileParamsV2;

const isParamsV2 = (params: ReadFileParams): params is IReadFileParamsV2 =>
	(params as IReadFileParamsV1).startLine === undefined;

interface IParamRanges {
	start: number;
	end: number;
	truncated: boolean;
}

const getParamRanges = (params: ReadFileParams, snapshot: NotebookDocumentSnapshot | TextDocumentSnapshot): IParamRanges => {
	let start: number;
	let end: number;
	let truncated = false;
	if (isParamsV2(params)) {
		// Check if offset is out of bounds before clamping
		if (params.offset !== undefined && params.offset > snapshot.lineCount) {
			throw new Error(`Invalid offset ${params.offset}: file only has ${snapshot.lineCount} line${snapshot.lineCount === 1 ? '' : 's'}. Line numbers are 1-indexed.`);
		}
		const limit = clamp(params.limit || Infinity, 1, MAX_LINES_PER_READ - 1);
		start = clamp(params.offset ?? 1, 1, snapshot.lineCount);
		end = clamp(start + limit, 1, snapshot.lineCount);
		// signal truncation if we applied a limit to the lines other than what the model requested
		truncated = limit !== params.limit && end < snapshot.lineCount;
	} else {
		start = clamp(params.startLine, 1, snapshot.lineCount);
		end = clamp(params.endLine, 1, snapshot.lineCount);
	}

	if (start > end) {
		[end, start] = [start, end];
	}

	return { start, end, truncated };
};

export class ReadFileTool implements ICopilotTool<ReadFileParams> {
	public static toolName = ToolName.ReadFile;
	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INotebookService private readonly notebookService: INotebookService,
		@IAlternativeNotebookContentService private readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ICustomInstructionsService private readonly customInstructionsService: ICustomInstructionsService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ReadFileParams>, token: vscode.CancellationToken) {
		let ranges: IParamRanges | undefined;
		let uri: URI | undefined;
		try {
			uri = resolveToolInputPath(options.input.filePath, this.promptPathRepresentationService);
			const documentSnapshot = await this.getSnapshot(uri);
			ranges = getParamRanges(options.input, documentSnapshot);

			void this.sendReadFileTelemetry('success', options, ranges, uri);
			return new LanguageModelToolResult([
				new LanguageModelPromptTsxPart(
					await renderPromptElementJSON(
						this.instantiationService,
						ReadFileResult,
						{ uri, startLine: ranges.start, endLine: ranges.end, truncated: ranges.truncated, snapshot: documentSnapshot, languageModel: this._promptContext?.request?.model },
						// If we are not called with tokenization options, have _some_ fake tokenizer
						// otherwise we end up returning the entire document on every readFile.
						options.tokenizationOptions ?? {
							tokenBudget: 600,
							countTokens: (t) => Promise.resolve(t.length * 3 / 4)
						},
						token,
					),
				)
			]);
		} catch (err) {
			void this.sendReadFileTelemetry('error', options, ranges || { start: 0, end: 0, truncated: false }, uri);
			throw err;
		}
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ReadFileParams>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
		const { input } = options;
		if (!input.filePath.length) {
			return;
		}

		let uri: URI | undefined;
		let documentSnapshot: NotebookDocumentSnapshot | TextDocumentSnapshot;
		try {
			uri = resolveToolInputPath(input.filePath, this.promptPathRepresentationService);

			// Check if file is external (outside workspace, not open in editor, etc.)
			const isExternal = await this.instantiationService.invokeFunction(
				accessor => isFileExternalAndNeedsConfirmation(accessor, uri!)
			);

			if (isExternal) {
				// Still check content exclusion (copilot ignore)
				await this.instantiationService.invokeFunction(
					accessor => assertFileNotContentExcluded(accessor, uri!)
				);

				const folderUri = dirname(uri);

				const message = this.workspaceService.getWorkspaceFolders().length === 1 ? new MarkdownString(l10n.t`${formatUriForFileWidget(uri)} is outside of the current folder in ${formatUriForFileWidget(folderUri)}.`) : new MarkdownString(l10n.t`${formatUriForFileWidget(uri)} is outside of the current workspace in ${formatUriForFileWidget(folderUri)}.`);

				// Return confirmation request for external file
				// The folder-based "allow this session" option is provided by the core confirmation contribution
				return {
					invocationMessage: new MarkdownString(l10n.t`Reading ${formatUriForFileWidget(uri)}`),
					pastTenseMessage: new MarkdownString(l10n.t`Read ${formatUriForFileWidget(uri)}`),
					confirmationMessages: {
						title: l10n.t`Allow reading external files?`,
						message,
					}
				};
			}

			await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri!));
			documentSnapshot = await this.getSnapshot(uri);
		} catch (err) {
			void this.sendReadFileTelemetry('invalidFile', options, { start: 0, end: 0, truncated: false }, uri);
			throw err;
		}

		const { start, end } = getParamRanges(input, documentSnapshot);

		// Refresh available extension prompt files only if reading a skill.md file (can be file or virtual URI)
		if (extUriBiasedIgnorePathCase.basename(uri).toLowerCase() === 'skill.md') {
			await this.customInstructionsService.refreshExtensionPromptFiles();
		}
		const skillInfo = this.customInstructionsService.getSkillInfo(uri);

		if (start === 1 && end === documentSnapshot.lineCount) {
			if (skillInfo) {
				const { skillName } = skillInfo;
				if (this.customInstructionsService.isSkillMdFile(uri)) {
					return {
						invocationMessage: new MarkdownString(l10n.t`Reading skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillName })}`),
						pastTenseMessage: new MarkdownString(l10n.t`Read skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillName })}`),
					};
				} else {
					return {
						invocationMessage: new MarkdownString(l10n.t`Reading skill \`${skillName}\`: ${formatUriForFileWidget(uri)}`),
						pastTenseMessage: new MarkdownString(l10n.t`Read skill \`${skillName}\`: ${formatUriForFileWidget(uri)}`),
					};
				}
			}
			return {
				invocationMessage: new MarkdownString(l10n.t`Reading ${formatUriForFileWidget(uri)}`),
				pastTenseMessage: new MarkdownString(l10n.t`Read ${formatUriForFileWidget(uri)}`),
			};
		}

		// Jump to the start of the range, don't select the whole range
		const readLocation = new Location(uri, new Range(start - 1, 0, start - 1, 0));
		if (this.customInstructionsService.isSkillFile(uri)) {
			if (skillInfo) {
				const { skillName } = skillInfo;
				if (this.customInstructionsService.isSkillMdFile(uri)) {
					return {
						invocationMessage: new MarkdownString(l10n.t`Reading skill ${formatUriForFileWidget(readLocation, { vscodeLinkType: 'skill', linkText: skillName })}, lines ${start} to ${end}`),
						pastTenseMessage: new MarkdownString(l10n.t`Read skill ${formatUriForFileWidget(readLocation, { vscodeLinkType: 'skill', linkText: skillName })}, lines ${start} to ${end}`),
					};
				} else {
					return {
						invocationMessage: new MarkdownString(l10n.t`Reading skill \`${skillName}\`: ${formatUriForFileWidget(readLocation)}, lines ${start} to ${end}`),
						pastTenseMessage: new MarkdownString(l10n.t`Read skill \`${skillName}\`: ${formatUriForFileWidget(readLocation)}, lines ${start} to ${end}`),
					};
				}
			}
		}
		return {
			invocationMessage: new MarkdownString(l10n.t`Reading ${formatUriForFileWidget(readLocation)}, lines ${start} to ${end}`),
			pastTenseMessage: new MarkdownString(l10n.t`Read ${formatUriForFileWidget(readLocation)}, lines ${start} to ${end}`),
		};
	}

	public alternativeDefinition(originTool: vscode.LanguageModelToolInformation): vscode.LanguageModelToolInformation {
		if (this.configurationService.getExperimentBasedConfig<boolean>(ConfigKey.TeamInternal.EnableReadFileV2, this.experimentationService)) {
			return readFileV2Description;
		}

		return originTool;
	}

	private async getSnapshot(uri: URI) {
		return this.notebookService.hasSupportedNotebooks(uri) ?
			await this.workspaceService.openNotebookDocumentAndSnapshot(uri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model)) :
			TextDocumentSnapshot.create(await this.workspaceService.openTextDocument(uri));
	}

	private async sendReadFileTelemetry(outcome: string, options: Pick<vscode.LanguageModelToolInvocationOptions<ReadFileParams>, 'model' | 'chatRequestId' | 'input'>, { start, end, truncated }: IParamRanges, uri: URI | undefined) {
		const model = options.model && (await this.endpointProvider.getChatEndpoint(options.model)).model;
		const fileType = uri && this.customInstructionsService.isSkillFile(uri) ? 'skill' : '';

		/* __GDPR__
			"readFileToolInvoked" : {
				"owner": "roblourens",
				"comment": "The read_file tool was invoked",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"interactionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current interaction." },
				"toolOutcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the invocation was successful, or a failure reason" },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"linesRead": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of lines that were read" },
				"truncated": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The file length was truncated" },
				"isV2": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the tool is a v2 version" },
				"isEntireFile": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the entire file was read with v2 params" },
				"fileType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The type of file being read" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('readFileToolInvoked',
			{
				requestId: options.chatRequestId,
				interactionId: options.chatRequestId,
				toolOutcome: outcome, // Props named "outcome" often get stuck in the kusto pipeline
				isV2: isParamsV2(options.input) ? 'true' : 'false',
				isEntireFile: isParamsV2(options.input) && options.input.offset === undefined && options.input.limit === undefined ? 'true' : 'false',
				fileType,
				model
			},
			{
				linesRead: end - start,
				truncated: truncated ? 1 : 0,
			}
		);
	}

	async resolveInput(input: IReadFileParamsV1, promptContext: IBuildPromptContext): Promise<IReadFileParamsV1> {
		this._promptContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(ReadFileTool);


interface ReadFileResultProps extends BasePromptElementProps {
	uri: URI;
	startLine: number;
	endLine: number;
	truncated: boolean;
	snapshot: TextDocumentSnapshot | NotebookDocumentSnapshot;
	languageModel: vscode.LanguageModelChat | undefined;
}

class ReadFileResult extends PromptElement<ReadFileResultProps> {
	constructor(
		props: PromptElementProps<ReadFileResultProps>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	override async render() {
		// Only check content exclusion (copilot ignore) - external file confirmation was already handled in prepareInvocation
		await this.instantiationService.invokeFunction(accessor => assertFileNotContentExcluded(accessor, this.props.uri));

		const documentSnapshot = this.props.snapshot;

		const documentText = documentSnapshot.getText();
		if (documentText.length === 0) {
			return <>(The file `{this.promptPathRepresentationService.getFilePath(this.props.uri)}` exists, but is empty)</>;
		} else if (documentText.trim().length === 0) {
			return <>(The file `{this.promptPathRepresentationService.getFilePath(this.props.uri)}` exists, but contains only whitespace)</>;
		}

		const range = new Range(
			this.props.startLine - 1, 0,
			this.props.endLine - 1, Infinity,
		);
		let contents = documentSnapshot.getText(range);

		if (this.props.truncated) {
			contents += `\n[File content truncated at line ${this.props.endLine}. Use ${ToolName.ReadFile} with offset/limit parameters to view more.]\n`;
		}

		return <>
			{range.end.line + 1 === documentSnapshot.lineCount && !this.props.truncated ? undefined : <>File: `{this.promptPathRepresentationService.getFilePath(this.props.uri)}`. Lines {range.start.line + 1} to {range.end.line + 1} ({documentSnapshot.lineCount} lines total): <br /></ >}
			<CodeBlock
				uri={this.props.uri}
				code={contents}
				languageId={documentSnapshot.languageId}
				shouldTrim={false}
				includeFilepath={false}
				references={[new PromptReference(this.props.uri, undefined, { isFromTool: true })]}
				lineBasedPriority
			/>
		</>;
	}
}
