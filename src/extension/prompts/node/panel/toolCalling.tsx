/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AssistantMessage, BasePromptElementProps, PromptRenderer as BasePromptRenderer, Chunk, IfEmpty, Image, JSONTree, PromptElement, PromptElementProps, PromptMetadata, PromptPiece, PromptSizing, TokenLimit, ToolCall, ToolMessage, useKeepWith, UserMessage } from '@vscode/prompt-tsx';
import type { ChatParticipantToolToken, LanguageModelToolResult2, LanguageModelToolTokenizationOptions } from 'vscode';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { CacheType } from '../../../../platform/endpoint/common/endpointTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { ITokenizer } from '../../../../util/common/tokenizer';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { toErrorMessage } from '../../../../util/vs/base/common/errorMessage';
import { isCancellationError } from '../../../../util/vs/base/common/errors';
import { LanguageModelDataPart, LanguageModelPromptTsxPart, ToolResultAudience, LanguageModelTextPart, LanguageModelToolResult, LanguageModelTextPart2, LanguageModelDataPart2 } from '../../../../vscodeTypes';
import { isImageDataPart } from '../../../conversation/common/languageModelChatMessageHelpers';
import { IResultMetadata } from '../../../prompt/common/conversation';
import { IBuildPromptContext, IToolCall, IToolCallRound } from '../../../prompt/common/intents';
import { ToolName } from '../../../tools/common/toolNames';
import { CopilotToolMode } from '../../../tools/common/toolsRegistry';
import { IToolsService } from '../../../tools/common/toolsService';
import { IPromptEndpoint } from '../base/promptRenderer';

export interface ChatToolCallsProps extends BasePromptElementProps {
	readonly promptContext: IBuildPromptContext;
	readonly toolCallRounds: readonly IToolCallRound[] | undefined;
	readonly toolCallResults: Record<string, LanguageModelToolResult2> | undefined;
	readonly isHistorical?: boolean;
	readonly toolCallMode?: CopilotToolMode;
	readonly enableCacheBreakpoints?: boolean;
	readonly truncateAt?: number;
}

const MAX_INPUT_VALIDATION_RETRIES = 5;

/**
 * Render one round of the assistant response's tool calls.
 * One assistant response "turn" which contains multiple rounds of assistant message text, tool calls, and tool results.
 */
export class ChatToolCalls extends PromptElement<ChatToolCallsProps, void> {
	constructor(
		props: PromptElementProps<ChatToolCallsProps>,
		@IToolsService private readonly toolsService: IToolsService,
	) {
		super(props);
	}

	override async render(state: void, sizing: PromptSizing): Promise<PromptPiece<any, any> | undefined> {
		if (!this.props.promptContext.tools || !this.props.toolCallRounds?.length) {
			return;
		}

		const toolCallRounds = this.props.toolCallRounds.flatMap((round, i) => {
			return this.renderOneToolCallRound(round, i, this.props.toolCallRounds!.length);
		});
		if (!toolCallRounds.length) {
			return;
		}

		const KeepWith = useKeepWith();
		return <>
			<KeepWith priority={1} flexGrow={1}>
				{toolCallRounds}
			</KeepWith>
		</>;
	}

	/**
	 * Render one round of tool calling: the assistant message text, its tool calls, and the results of those tool calls.
	 */
	private renderOneToolCallRound(round: IToolCallRound, index: number, total: number): PromptElement[] {
		let fixedNameToolCalls = round.toolCalls.map(tc => ({ ...tc, name: this.toolsService.validateToolName(tc.name) ?? tc.name }));
		if (this.props.isHistorical) {
			fixedNameToolCalls = fixedNameToolCalls.filter(tc => tc.id && this.props.toolCallResults?.[tc.id]);
		}

		if (round.toolCalls.length && !fixedNameToolCalls.length) {
			return [];
		}

		const assistantToolCalls: Required<ToolCall>[] = fixedNameToolCalls.map(tc => ({
			type: 'function',
			function: { name: tc.name, arguments: tc.arguments },
			id: tc.id!,
			keepWith: useKeepWith(),
		}));
		const children: PromptElement[] = [];
		children.push(<AssistantMessage toolCalls={assistantToolCalls}>{round.response}</AssistantMessage>);

		// Tool call elements should be rendered with the later elements first, allowed to grow to fill the available space
		// Each tool 'reserves' 1/(N*4) of the available space just so that newer tool calls don't completely elimate
		// older tool calls.
		const reserve1N = (1 / (total * 4)) / fixedNameToolCalls.length;
		// todo@connor4312: historical tool calls don't need to reserve and can all be flexed together
		for (const [i, toolCall] of fixedNameToolCalls.entries()) {
			const KeepWith = assistantToolCalls[i].keepWith;
			children.push(
				<KeepWith priority={index} flexGrow={index + 1} flexReserve={`/${1 / reserve1N}`}>
					<ToolResultElement
						toolCall={toolCall}
						toolInvocationToken={this.props.promptContext.tools!.toolInvocationToken}
						toolCallResult={this.props.toolCallResults?.[toolCall.id!]}
						allowInvokingTool={!this.props.isHistorical}
						validateInput={round.toolInputRetry < MAX_INPUT_VALIDATION_RETRIES}
						requestId={this.props.promptContext.requestId}
						toolCallMode={this.props.toolCallMode ?? CopilotToolMode.PartialContext}
						promptContext={this.props.promptContext}
						isLast={!this.props.isHistorical && i === fixedNameToolCalls.length - 1 && index === total - 1}
						enableCacheBreakpoints={this.props.enableCacheBreakpoints ?? false}
						truncateAt={this.props.truncateAt}
					/>
				</KeepWith>,
			);
		}
		return children;
	}
}

interface ToolResultElementProps extends BasePromptElementProps {
	readonly toolCall: IToolCall;
	readonly toolInvocationToken: ChatParticipantToolToken | undefined;
	readonly toolCallResult: LanguageModelToolResult2 | undefined;
	readonly allowInvokingTool?: boolean;
	readonly validateInput?: boolean;
	readonly requestId?: string;
	readonly toolCallMode: CopilotToolMode;
	readonly promptContext: IBuildPromptContext;
	readonly isLast: boolean;
	readonly enableCacheBreakpoints: boolean;
	readonly truncateAt?: number;
}

const toolErrorSuffix = '\nPlease check your input and try again.';

/**
 * One tool call result, which either comes from the cache or from invoking the tool.
 */
class ToolResultElement extends PromptElement<ToolResultElementProps, void> {
	constructor(
		props: ToolResultElementProps,
		@IToolsService private readonly toolsService: IToolsService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IPromptEndpoint private readonly promptEndpoint: IPromptEndpoint
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing): Promise<PromptPiece | undefined> {
		const tokenizationOptions: LanguageModelToolTokenizationOptions = {
			tokenBudget: sizing.tokenBudget,
			countTokens: async (content: string) => sizing.countTokens(content),
		};

		if (!this.props.toolCallResult && !this.props.allowInvokingTool) {
			throw new Error(`Missing tool call result for "${this.props.toolCall.id}" (${this.props.toolCall.name})`);
		}

		const extraMetadata: PromptMetadata[] = [];
		let isCancelled = false;
		let toolResult = this.props.toolCallResult;
		const copilotTool = this.toolsService.getCopilotTool(this.props.toolCall.name as ToolName);
		if (toolResult === undefined) {
			let inputObj: unknown;
			let validation: ToolValidationOutcome = ToolValidationOutcome.Unknown;
			if (this.props.validateInput) {
				const validationResult = this.toolsService.validateToolInput(this.props.toolCall.name, this.props.toolCall.arguments);
				if ('error' in validationResult) {
					validation = ToolValidationOutcome.Invalid;
					extraMetadata.push(new ToolFailureEncountered(this.props.toolCall.id));
					toolResult = textToolResult(validationResult.error + toolErrorSuffix);
				} else {
					validation = ToolValidationOutcome.Valid;
					inputObj = validationResult.inputObj;
				}
			} else {
				inputObj = JSON.parse(this.props.toolCall.arguments);
			}

			let outcome: ToolInvocationOutcome = toolResult === undefined ? ToolInvocationOutcome.Success : ToolInvocationOutcome.InvalidInput;
			if (toolResult === undefined) {
				try {
					if (this.props.promptContext.tools && !this.props.promptContext.tools.availableTools.find(t => t.name === this.props.toolCall.name)) {
						outcome = ToolInvocationOutcome.DisabledByUser;
						throw new Error(`Tool ${this.props.toolCall.name} is currently disabled by the user, and cannot be called.`);
					}

					if (copilotTool?.resolveInput) {
						inputObj = await copilotTool.resolveInput(inputObj, this.props.promptContext, this.props.toolCallMode);
					}

					toolResult = await this.toolsService.invokeTool(this.props.toolCall.name, { input: inputObj, toolInvocationToken: this.props.toolInvocationToken, tokenizationOptions, chatRequestId: this.props.requestId }, CancellationToken.None);
					sendInvokedToolTelemetry(this.promptEndpoint.acquireTokenizer(), this.telemetryService, this.props.toolCall.name, toolResult);
				} catch (err) {
					const errResult = toolCallErrorToResult(err);
					toolResult = errResult.result;
					isCancelled = errResult.isCancelled ?? false;
					if (errResult.isCancelled) {
						outcome = ToolInvocationOutcome.Cancelled;
					} else {
						outcome = outcome === ToolInvocationOutcome.DisabledByUser ? outcome : ToolInvocationOutcome.Error;
						extraMetadata.push(new ToolFailureEncountered(this.props.toolCall.id));
						this.logService.error(`Error from tool ${this.props.toolCall.name} with args ${this.props.toolCall.arguments}`, toErrorMessage(err, true));
					}
				}
			}
			this.sendToolCallTelemetry(outcome, validation);
		}

		const toolResultElement = this.props.enableCacheBreakpoints ?
			<>
				<Chunk>
					<ToolResult content={toolResult.content} truncate={this.props.truncateAt} />
				</Chunk>
			</> :
			<ToolResult content={toolResult.content} truncate={this.props.truncateAt} />;

		return (
			<ToolMessage toolCallId={this.props.toolCall.id!}>
				<meta value={new ToolResultMetadata(this.props.toolCall.id!, toolResult, isCancelled)} />
				{...extraMetadata.map(m => <meta value={m} />)}
				{toolResultElement}
				{this.props.isLast && this.props.enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />}
			</ToolMessage>
		);
	}
	private async sendToolCallTelemetry(invokeOutcome: ToolInvocationOutcome, validateOutcome: ToolValidationOutcome) {
		const model = this.props.promptContext.request?.model && (await this.endpointProvider.getChatEndpoint(this.props.promptContext.request?.model)).model;
		const toolName = this.props.toolCall.name;

		/* __GDPR__
			"toolInvoke" : {
				"owner": "donjayamanne",
				"comment": "Details about invocation of tools",
				"validateOutcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The outcome of the tool input validation. valid, invalid and unknown" },
				"invokeOutcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The outcome of the tool Invokcation. invalidInput, disabledByUser, success, error, cancelled" },
				"toolName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The name of the tool being invoked." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('toolInvoke',
			{
				validateOutcome,
				invokeOutcome,
				toolName,
				model
			}
		);

		if (toolName === ToolName.EditNotebook) {
			sendNotebookEditToolValidationTelemetry(invokeOutcome, validateOutcome, this.props.toolCall.arguments, this.telemetryService, model);
		}
	}
}

export function sendInvokedToolTelemetry(tokenizer: ITokenizer, telemetry: ITelemetryService, toolName: string, toolResult: LanguageModelToolResult2) {
	new BasePromptRenderer(
		{ modelMaxPromptTokens: Infinity },
		class extends PromptElement {
			render() {
				return <UserMessage><PrimitiveToolResult content={toolResult.content} /></UserMessage>;
			}
		},
		{},
		tokenizer,
	).render().then(({ tokenCount }) => {
		/* __GDPR__
			"agent.tool.responseLength" : {
				"owner": "connor4312",
				"comment": "Counts the number of tokens generated by tools",
				"toolName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The name of the tool being invoked." },
				"tokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of tokens used.", "isMeasurement": true }
			}
		*/
		telemetry.sendMSFTTelemetryEvent('agent.tool.responseLength', { toolName }, { tokenCount });
	});
}

enum ToolValidationOutcome {
	Valid = 'valid',
	Invalid = 'invalid',
	Unknown = 'unknown'
}

enum ToolInvocationOutcome {
	InvalidInput = 'invalidInput',
	DisabledByUser = 'disabledByUser',
	Success = 'success',
	Error = 'error',
	Cancelled = 'cancelled',
}

export function imageDataPartToTSX(part: LanguageModelDataPart) {
	if (isImageDataPart(part)) {
		const base64 = Buffer.from(part.data).toString('base64');
		return <Image src={`data:${part.mimeType};base64,${base64}`} />;
	}
}

function textToolResult(text: string): LanguageModelToolResult {
	return new LanguageModelToolResult([new LanguageModelTextPart(text)]);
}

export function toolCallErrorToResult(err: unknown) {
	if (isCancellationError(err)) {
		return { result: textToolResult('The user cancelled the tool call.'), isCancelled: true };
	} else {
		const errorMessage = err instanceof Error ? err.message : String(err);
		return { result: textToolResult(`ERROR while calling tool: ${errorMessage}${toolErrorSuffix}`) };
	}
}

export class ToolFailureEncountered extends PromptMetadata {
	constructor(
		public toolCallId: string
	) {
		super();
	}
}

export class ToolResultMetadata extends PromptMetadata {
	constructor(
		public readonly toolCallId: string,
		public readonly result: LanguageModelToolResult2,
		public isCancelled?: boolean
	) {
		super();
	}
}

interface IPrimitiveToolResultProps extends BasePromptElementProps {
	content: LanguageModelToolResult2['content'];
}

class PrimitiveToolResult<T extends IPrimitiveToolResultProps> extends PromptElement<T> {
	async render(): Promise<PromptPiece | undefined> {
		return (
			<>
				<IfEmpty alt='(empty)'>
					{await Promise.all(this.props.content.filter(part => this.hasAssistantAudience(part)).map(async part => {
						if (part instanceof LanguageModelTextPart) {
							return await this.onText(part.value);
						} else if (part instanceof LanguageModelPromptTsxPart) {
							return await this.onTSX(part.value as JSONTree.PromptElementJSON);
						} else if (isImageDataPart(part)) {
							return await this.onData(part);
						}
					}))}
				</IfEmpty>
			</>
		);
	}

	private hasAssistantAudience(part: LanguageModelTextPart2 | LanguageModelPromptTsxPart | LanguageModelDataPart2 | unknown): boolean {
		if (part instanceof LanguageModelPromptTsxPart) {
			return true;
		}
		if (!(part instanceof LanguageModelDataPart2 || part instanceof LanguageModelTextPart2) || !part.audience) {
			return true;
		}
		return part.audience.includes(ToolResultAudience.Assistant);
	}

	protected onData(part: LanguageModelDataPart) {
		return Promise.resolve(imageDataPartToTSX(part));
	}

	protected onTSX(part: JSONTree.PromptElementJSON) {
		return Promise.resolve(<elementJSON data={part} />);
	}

	protected onText(part: string) {
		return Promise.resolve(part);
	}
}

export interface IToolResultProps extends IPrimitiveToolResultProps {
	/**
	 * Number of tokens at which truncation will be triggered for string content.
	 */
	truncate?: number;
}


/**
 * Inlined from prompt-tsx. In prompt-tsx it does `require('vscode)` for the instanceof checks which breaks in vitest
 * and unfortunately I can't figure out how to work around that with the tools we have!
 */
export class ToolResult extends PrimitiveToolResult<IToolResultProps> {
	constructor(
		props: PromptElementProps<IToolResultProps>,
		@IPromptEndpoint private readonly endpoint: IPromptEndpoint,
	) {
		super(props);
	}

	protected override async onTSX(part: JSONTree.PromptElementJSON): Promise<any> {
		if (this.props.truncate) {
			return <TokenLimit max={this.props.truncate}>{await super.onTSX(part)}</TokenLimit>;
		}

		return super.onTSX(part);
	}

	protected override async onText(content: string): Promise<string> {
		const truncateAtTokens = this.props.truncate;
		if (!truncateAtTokens || content.length < truncateAtTokens) { // always >=1 character per token, early bail-out
			return content;
		}

		const tokens = await this.endpoint.acquireTokenizer().tokenLength(content);
		if (tokens < truncateAtTokens) {
			return content;
		}

		const approxCharsPerToken = content.length / tokens;
		const removedMessage = '\n[Tool response was too long and was truncated.]\n';
		const targetChars = Math.round(approxCharsPerToken * (truncateAtTokens - removedMessage.length));

		const keepInFirstHalf = Math.round(targetChars * 0.4);
		const keepInSecondHalf = targetChars - keepInFirstHalf;

		return content.slice(0, keepInFirstHalf) + removedMessage + content.slice(-keepInSecondHalf);
	}
}

export interface IToolCallResultWrapperProps extends BasePromptElementProps {
	toolCallResults: IResultMetadata['toolCallResults'];
}

// Wrapper around ToolResult to allow rendering prompts
export class ToolCallResultWrapper extends PromptElement<IToolCallResultWrapperProps> {
	async render(): Promise<PromptPiece | undefined> {
		return (
			<>
				{Object.entries(this.props.toolCallResults ?? {}).map(([toolCallId, toolCallResult]) => (
					<ToolMessage toolCallId={toolCallId}>
						<ToolResult content={toolCallResult.content} />
					</ToolMessage>
				))}
			</>
		);
	}
}

function sendNotebookEditToolValidationTelemetry(invokeOutcome: ToolInvocationOutcome, validationResult: ToolValidationOutcome, toolArgs: string, telemetryService: ITelemetryService, model?: string): void {
	let editType: 'insert' | 'delete' | 'edit' | 'unknown' = 'unknown';
	let explanation: 'provided' | 'empty' | 'unknown' = 'unknown';
	let newCodeType: 'string' | 'string[]' | 'object' | 'object[]' | 'unknown' | '' = 'unknown';
	let cellId: 'TOP' | 'BOTTOM' | 'cellid' | 'unknown' | 'empty' = 'unknown';
	let inputParsed = 0;
	const knownProps = ['editType', 'explanation', 'newCode', 'cellId', 'filePath', 'language'];
	let missingProps: string[] = [];
	let unknownProps: string[] = [];
	try {
		const args = JSON.parse(toolArgs);
		if (args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length > 0) {
			const props = Object.keys(args);
			unknownProps = props.filter(key => !knownProps.includes(key));
			unknownProps.sort();
			missingProps = knownProps.filter(key => !props.includes(key));
			missingProps.sort();
		}
		inputParsed = 1;
		if (args.editType) {
			editType = args.editType;
		}
		if (args.explanation) {
			explanation = 'provided';
		} else {
			explanation = 'empty';
		}
		if (args.newCode || typeof args.newCode === 'string') {
			if (typeof args.newCode === 'string') {
				newCodeType = 'string';
			} else if (Array.isArray(args.newCode) && (args.newCode as any[]).every(item => typeof item === 'string')) {
				newCodeType = 'string[]';
			} else if (Array.isArray(args.newCode)) {
				newCodeType = 'object[]';
			} else if (typeof args.newCode === 'object') {
				newCodeType = 'object';
			}
		}
		if (editType === 'delete') {
			newCodeType = '';
		}
		const cellIdValue = args.cellId;
		if (typeof cellIdValue === 'string') {
			if (cellIdValue === 'TOP' || cellIdValue === 'BOTTOM') {
				cellId = cellIdValue;
			} else {
				cellId = cellIdValue.trim().length === 0 ? 'cellid' : 'empty';
			}
		}
	} catch {
		//
	}

	/* __GDPR__
		"editNotebook.validation" : {
			"owner": "donjayamanne",
			"comment": "Validation failure for a Edit Notebook tool invocation",
			"validationResult": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The result of the tool input validation. valid, invalid and unknown" },
			"invokeOutcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The result of the tool Invocation. invalidInput, disabledByUser, success, error, cancelled" },
			"editType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The type of edit that was attempted. insert, delete, edit or unknown" },
			"unknownProps": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "List of unknown properties in the input" },
			"missingProps": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "List of missing properties in the input" },
			"newCodeType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The type of code, whether its string, string[], object, object[] or unknown" },
			"cellId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the cell, TOP, BOTTOM, cellid, empty or unknown" },
			"explanation": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The explanation for the edit. provided, empty and unknown" },
			"inputParsed": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the input was parsed as JSON" },
			"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" }
		}
	*/

	telemetryService.sendMSFTTelemetryEvent('editNotebook.validation',
		{
			validationResult,
			invokeOutcome,
			editType,
			newCodeType,
			cellId,
			explanation,
			model,
			unknownProps: unknownProps.join(','),
			missingProps: missingProps.join(','),
		},
		{
			inputParsed,
		}
	);
}
