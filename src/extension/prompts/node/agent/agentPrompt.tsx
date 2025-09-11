/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, Chunk, Image, PromptElement, PromptPieceChild, PromptSizing, Raw, SystemMessage, TokenLimit, UserMessage } from '@vscode/prompt-tsx';
import { isDefined } from '@vscode/test-electron/out/util';
import type { ChatRequestEditedFileEvent, LanguageModelToolInformation, NotebookEditor, TaskDefinition, TextEditor } from 'vscode';
import { ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { modelNeedsStrongReplaceStringHint } from '../../../../platform/endpoint/common/chatModelCapabilities';
import { CacheType } from '../../../../platform/endpoint/common/endpointTypes';
import { IEnvService, OperatingSystem } from '../../../../platform/env/common/envService';
import { getGitHubRepoInfoFromContext, IGitService } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { IAlternativeNotebookContentService } from '../../../../platform/notebook/common/alternativeContent';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { ITabsAndEditorsService } from '../../../../platform/tabs/common/tabsAndEditorsService';
import { ITasksService } from '../../../../platform/tasks/common/tasksService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { basename } from '../../../../util/vs/base/common/path';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestEditedFileEventKind, Position, Range } from '../../../../vscodeTypes';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { GitHubPullRequestProviders } from '../../../conversation/node/githubPullRequestProviders';
import { ChatVariablesCollection } from '../../../prompt/common/chatVariablesCollection';
import { GlobalContextMessageMetadata, RenderedUserMessageMetadata, Turn } from '../../../prompt/common/conversation';
import { InternalToolReference } from '../../../prompt/common/intents';
import { IPromptVariablesService } from '../../../prompt/node/promptVariablesService';
import { ToolName } from '../../../tools/common/toolNames';
import { TodoListContextPrompt } from '../../../tools/node/todoListContextPrompt';
import { CopilotIdentityRules, GPT5CopilotIdentityRule } from '../base/copilotIdentity';
import { IPromptEndpoint, renderPromptElement } from '../base/promptRenderer';
import { Gpt5SafetyRule, SafetyRules } from '../base/safetyRules';
import { Tag } from '../base/tag';
import { TerminalStatePromptElement } from '../base/terminalState';
import { ChatVariables } from '../panel/chatVariables';
import { EXISTING_CODE_MARKER } from '../panel/codeBlockFormattingRules';
import { CustomInstructions } from '../panel/customInstructions';
import { NotebookFormat, NotebookReminderInstructions } from '../panel/notebookEditCodePrompt';
import { NotebookSummaryChange } from '../panel/notebookSummaryChangePrompt';
import { UserPreferences } from '../panel/preferences';
import { ChatToolCalls } from '../panel/toolCalling';
import { MultirootWorkspaceStructure } from '../panel/workspace/workspaceStructure';
import { AgentConversationHistory } from './agentConversationHistory';
import { AlternateGPTPrompt, CodexStyleGPTPrompt, DefaultAgentPrompt, DefaultAgentPromptV2, SweBenchAgentPrompt } from './agentInstructions';
import { SummarizedConversationHistory } from './summarizedConversationHistory';

export interface AgentPromptProps extends GenericBasePromptElementProps {
	readonly endpoint: IChatEndpoint;
	readonly location: ChatLocation;

	readonly triggerSummarize?: boolean;

	/**
	 * Enables cache breakpoints and summarization
	 */
	readonly enableCacheBreakpoints?: boolean;

	/**
	 * Codesearch mode, aka agentic Ask mode
	 */
	readonly codesearchMode?: boolean;
}

/** Proportion of the prompt token budget any singular textual tool result is allowed to use. */
const MAX_TOOL_RESPONSE_PCT = 0.5;

/**
 * The agent mode prompt, rendered on each request
 */
export class AgentPrompt extends PromptElement<AgentPromptProps> {
	constructor(
		props: AgentPromptProps,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@IPromptEndpoint private readonly promptEndpoint: IPromptEndpoint,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const instructions = this.getInstructions();

		const omitBaseAgentInstructions = this.configurationService.getConfig(ConfigKey.Internal.OmitBaseAgentInstructions);
		const baseAgentInstructions = <>
			<SystemMessage>
				You are an expert AI programming assistant, working with a user in the VS Code editor.<br />
				{this.props.endpoint.family.startsWith('gpt-5') ? (
					<>
						<GPT5CopilotIdentityRule />
						<Gpt5SafetyRule />
					</>
				) : (
					<>
						<CopilotIdentityRules />
						<SafetyRules />
					</>
				)}
			</SystemMessage>
			{instructions}
		</>;
		const baseInstructions = <>
			{!omitBaseAgentInstructions && baseAgentInstructions}
			{this.getAgentCustomInstructions()}
			<UserMessage>
				{await this.getOrCreateGlobalAgentContext(this.props.endpoint)}
			</UserMessage>
		</>;

		const maxToolResultLength = Math.floor(this.promptEndpoint.modelMaxPromptTokens * MAX_TOOL_RESPONSE_PCT);

		if (this.props.enableCacheBreakpoints) {
			return <>
				{baseInstructions}
				<SummarizedConversationHistory
					flexGrow={1}
					triggerSummarize={this.props.triggerSummarize}
					priority={900}
					promptContext={this.props.promptContext}
					location={this.props.location}
					maxToolResultLength={maxToolResultLength}
					endpoint={this.props.endpoint}
					tools={this.props.promptContext.tools?.availableTools}
					enableCacheBreakpoints={this.props.enableCacheBreakpoints}
				/>
			</>;
		} else {
			return <>
				{baseInstructions}
				<AgentConversationHistory flexGrow={1} priority={700} promptContext={this.props.promptContext} />
				<AgentUserMessage flexGrow={2} priority={900} {...getUserMessagePropsFromAgentProps(this.props)} />
				<ChatToolCalls priority={899} flexGrow={2} promptContext={this.props.promptContext} toolCallRounds={this.props.promptContext.toolCallRounds} toolCallResults={this.props.promptContext.toolCallResults} truncateAt={maxToolResultLength} enableCacheBreakpoints={false} />
			</>;
		}
	}

	private getInstructions() {
		if (this.configurationService.getConfig(ConfigKey.Internal.SweBenchAgentPrompt)) {
			return <SweBenchAgentPrompt availableTools={this.props.promptContext.tools?.availableTools} modelFamily={this.props.endpoint.family} codesearchMode={undefined} />;
		}

		if (this.props.endpoint.family.startsWith('gpt-5')) {
			const promptType = this.configurationService.getExperimentBasedConfig(ConfigKey.Gpt5AlternatePrompt, this.experimentationService);
			switch (promptType) {
				case 'codex':
					return <CodexStyleGPTPrompt
						availableTools={this.props.promptContext.tools?.availableTools}
						modelFamily={this.props.endpoint.family}
						codesearchMode={this.props.codesearchMode}
					/>;
				case 'v2':
					return <DefaultAgentPromptV2
						availableTools={this.props.promptContext.tools?.availableTools}
						modelFamily={this.props.endpoint.family}
						codesearchMode={this.props.codesearchMode}
					/>;
				default:
					return <DefaultAgentPrompt
						availableTools={this.props.promptContext.tools?.availableTools}
						modelFamily={this.props.endpoint.family}
						codesearchMode={this.props.codesearchMode}
					/>;
			}
		}

		if (this.props.endpoint.family.startsWith('grok-code')) {
			const promptType = this.configurationService.getExperimentBasedConfig(ConfigKey.GrokCodeAlternatePrompt, this.experimentationService);
			switch (promptType) {
				case 'v2':
					return <DefaultAgentPromptV2
						availableTools={this.props.promptContext.tools?.availableTools}
						modelFamily={this.props.endpoint.family}
						codesearchMode={this.props.codesearchMode}
					/>;
				default:
					return <DefaultAgentPrompt
						availableTools={this.props.promptContext.tools?.availableTools}
						modelFamily={this.props.endpoint.family}
						codesearchMode={this.props.codesearchMode}
					/>;
			}
		}

		if (this.props.endpoint.family.startsWith('gpt-') && this.configurationService.getExperimentBasedConfig(ConfigKey.EnableAlternateGptPrompt, this.experimentationService)) {
			return <AlternateGPTPrompt
				availableTools={this.props.promptContext.tools?.availableTools}
				modelFamily={this.props.endpoint.family}
				codesearchMode={this.props.codesearchMode}
			/>;
		}

		return <DefaultAgentPrompt
			availableTools={this.props.promptContext.tools?.availableTools}
			modelFamily={this.props.endpoint.family}
			codesearchMode={this.props.codesearchMode}
		/>;
	}

	private getAgentCustomInstructions() {
		const putCustomInstructionsInSystemMessage = this.configurationService.getConfig(ConfigKey.CustomInstructionsInSystemMessage);
		const customInstructionsBody = <>
			<CustomInstructions
				languageId={undefined}
				chatVariables={this.props.promptContext.chatVariables}
				includeSystemMessageConflictWarning={!putCustomInstructionsInSystemMessage}
				customIntroduction={putCustomInstructionsInSystemMessage ? '' : undefined} // If in system message, skip the "follow these user-provided coding instructions" intro
			/>
			{
				this.props.promptContext.modeInstructions && <Tag name='customInstructions'>
					Below are some additional instructions from the user.<br />
					<br />
					{this.props.promptContext.modeInstructions}
				</Tag>
			}
		</>;
		return putCustomInstructionsInSystemMessage ?
			<SystemMessage>{customInstructionsBody}</SystemMessage> :
			<UserMessage>{customInstructionsBody}</UserMessage>;
	}

	private async getOrCreateGlobalAgentContext(endpoint: IChatEndpoint): Promise<PromptPieceChild[]> {
		const globalContext = await this.getOrCreateGlobalAgentContextContent(endpoint);
		return globalContext ?
			renderedMessageToTsxChildren(globalContext, !!this.props.enableCacheBreakpoints) :
			<GlobalAgentContext enableCacheBreakpoints={!!this.props.enableCacheBreakpoints} availableTools={this.props.promptContext.tools?.availableTools} />;
	}

	private async getOrCreateGlobalAgentContextContent(endpoint: IChatEndpoint): Promise<Raw.ChatCompletionContentPart[] | undefined> {
		const firstTurn = this.props.promptContext.conversation?.turns.at(0);
		if (firstTurn) {
			const metadata = firstTurn.getMetadata(GlobalContextMessageMetadata);
			if (metadata) {
				return metadata.renderedGlobalContext;
			}
		}

		const rendered = await renderPromptElement(this.instantiationService, endpoint, GlobalAgentContext, { enableCacheBreakpoints: this.props.enableCacheBreakpoints, availableTools: this.props.promptContext.tools?.availableTools }, undefined, undefined);
		const msg = rendered.messages.at(0)?.content;
		if (msg) {
			firstTurn?.setMetadata(new GlobalContextMessageMetadata(msg));
			return msg;
		}
	}
}

interface GlobalAgentContextProps extends BasePromptElementProps {
	readonly enableCacheBreakpoints?: boolean;
	readonly availableTools?: readonly LanguageModelToolInformation[];
}

/**
 * The "global agent context" is a static prompt at the start of a conversation containing user environment info, initial workspace structure, anything else that is a useful beginning
 * hint for the agent but is not updated during the conversation.
 */
class GlobalAgentContext extends PromptElement<GlobalAgentContextProps> {
	render() {
		return <UserMessage>
			<Tag name='environment_info'>
				<UserOSPrompt />
				<UserShellPrompt />
			</Tag>
			<Tag name='workspace_info'>
				<AgentTasksInstructions availableTools={this.props.availableTools} />
				<WorkspaceFoldersHint />
				<MultirootWorkspaceStructure maxSize={2000} excludeDotFiles={true} /><br />
				This is the state of the context at this point in the conversation. The view of the workspace structure may be truncated. You can use tools to collect more context if needed.
			</Tag>
			<UserPreferences flexGrow={7} priority={800} />
			{this.props.enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />}
		</UserMessage>;
	}
}

export interface AgentUserMessageProps extends BasePromptElementProps {
	readonly turn?: Turn;
	readonly isHistorical?: boolean;
	readonly request: string;
	readonly endpoint: IChatEndpoint;
	readonly toolReferences: readonly InternalToolReference[];
	readonly availableTools?: readonly LanguageModelToolInformation[];
	readonly chatVariables: ChatVariablesCollection;
	readonly enableCacheBreakpoints?: boolean;
	readonly editedFileEvents?: readonly ChatRequestEditedFileEvent[];
	readonly sessionId?: string;
}

export function getUserMessagePropsFromTurn(turn: Turn, endpoint: IChatEndpoint): AgentUserMessageProps {
	return {
		isHistorical: true,
		request: turn.request.message,
		turn,
		endpoint,
		toolReferences: turn.toolReferences,
		chatVariables: turn.promptVariables ?? new ChatVariablesCollection(),
		editedFileEvents: turn.editedFileEvents,
		enableCacheBreakpoints: false // Should only be added to the current turn - some user messages may get them in Agent post-processing
	};
}

export function getUserMessagePropsFromAgentProps(agentProps: AgentPromptProps): AgentUserMessageProps {
	return {
		request: agentProps.promptContext.query,
		// Will pull frozenContent off the Turn if available
		turn: agentProps.promptContext.conversation?.getLatestTurn(),
		endpoint: agentProps.endpoint,
		toolReferences: agentProps.promptContext.tools?.toolReferences ?? [],
		availableTools: agentProps.promptContext.tools?.availableTools,
		chatVariables: agentProps.promptContext.chatVariables,
		enableCacheBreakpoints: agentProps.enableCacheBreakpoints,
		editedFileEvents: agentProps.promptContext.editedFileEvents,
		// TODO:@roblourens
		sessionId: (agentProps.promptContext.tools?.toolInvocationToken as any)?.sessionId,

	};
}

/**
 * Is sent with each user message. Includes the user message and also any ambient context that we want to update with each request.
 * Uses frozen content if available, for prompt caching and to avoid being updated by any agent action below this point in the conversation.
 */
export class AgentUserMessage extends PromptElement<AgentUserMessageProps> {
	constructor(
		props: AgentUserMessageProps,
		@IPromptVariablesService private readonly promptVariablesService: IPromptVariablesService,
		@ILogService private readonly logService: ILogService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const frozenContent = this.props.turn?.getMetadata(RenderedUserMessageMetadata)?.renderedUserMessage;
		if (frozenContent) {
			return <FrozenContentUserMessage frozenContent={frozenContent} enableCacheBreakpoints={this.props.enableCacheBreakpoints} />;
		}

		if (this.props.isHistorical) {
			this.logService.trace('Re-rendering historical user message');
		}

		const query = await this.promptVariablesService.resolveToolReferencesInPrompt(this.props.request, this.props.toolReferences ?? []);
		const hasReplaceStringTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.ReplaceString);
		const hasMultiReplaceStringTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.MultiReplaceString);
		const hasApplyPatchTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.ApplyPatch);
		const hasCreateFileTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.CreateFile);
		const hasEditFileTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.EditFile);
		const hasEditNotebookTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.EditNotebook);
		const hasTerminalTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.CoreRunInTerminal);
		const attachmentHint = (this.props.endpoint.family === 'gpt-4.1' || this.props.endpoint.family.startsWith('gpt-5')) && this.props.chatVariables.hasVariables() ?
			' (See <attachments> above for file contents. You may not need to search or read the file again.)'
			: '';
		const hasToolsToEditNotebook = hasCreateFileTool || hasEditNotebookTool || hasReplaceStringTool || hasApplyPatchTool || hasEditFileTool;
		const hasTodoTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.CoreManageTodoList);
		const shouldUseUserQuery = this.props.endpoint.family.startsWith('grok-code');
		return (
			<>
				<UserMessage>
					{hasToolsToEditNotebook && <NotebookFormat flexGrow={5} priority={810} chatVariables={this.props.chatVariables} query={query} />}
					<TokenLimit max={sizing.tokenBudget / 6} flexGrow={3} priority={898}>
						<ChatVariables chatVariables={this.props.chatVariables} isAgent={true} omitReferences />
					</TokenLimit>
					<ToolReferencesHint toolReferences={this.props.toolReferences} modelFamily={this.props.endpoint.family} />
					<Tag name='context'>
						<CurrentDatePrompt />
						<EditedFileEvents editedFileEvents={this.props.editedFileEvents} />
						<NotebookSummaryChange />
						{hasTerminalTool && <TerminalStatePromptElement sessionId={this.props.sessionId} />}
						{hasTodoTool && <TodoListContextPrompt sessionId={this.props.sessionId} />}
					</Tag>
					<CurrentEditorContext endpoint={this.props.endpoint} />
					<RepoContext />
					<Tag name='reminderInstructions'>
						{/* Critical reminders that are effective when repeated right next to the user message */}
						<KeepGoingReminder modelFamily={this.props.endpoint.family} />
						{getEditingReminder(hasEditFileTool, hasReplaceStringTool, modelNeedsStrongReplaceStringHint(this.props.endpoint), hasMultiReplaceStringTool)}
						<NotebookReminderInstructions chatVariables={this.props.chatVariables} query={this.props.request} />
						{getExplanationReminder(this.props.endpoint.family, hasTodoTool)}
					</Tag>
					{query && <Tag name={shouldUseUserQuery ? 'user_query' : 'userRequest'} priority={900} flexGrow={7}>{query + attachmentHint}</Tag>}
					{this.props.enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />}
				</UserMessage>
			</>
		);
	}
}

interface FrozenMessageContentProps extends BasePromptElementProps {
	readonly frozenContent: readonly Raw.ChatCompletionContentPart[];
	readonly enableCacheBreakpoints?: boolean;
}

class FrozenContentUserMessage extends PromptElement<FrozenMessageContentProps> {
	async render(state: void, sizing: PromptSizing) {
		return <UserMessage priority={this.props.priority}>
			<Chunk>
				{/* Have to move <cacheBreakpoint> out of the Chunk */}
				{renderedMessageToTsxChildren(this.props.frozenContent, false)}
			</Chunk>
			{this.props.enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />}
		</UserMessage>;
	}
}

interface ToolReferencesHintProps extends BasePromptElementProps {
	readonly toolReferences: readonly InternalToolReference[];
	readonly modelFamily?: string;
}

/**
 * `#` tool references included in the request are a strong hint to the model that the tool is relevant, but we don't force a tool call.
 */
class ToolReferencesHint extends PromptElement<ToolReferencesHintProps> {
	render() {
		if (!this.props.toolReferences.length) {
			return;
		}

		return <>
			<Tag name='toolReferences'>
				The user attached the following tools to this message. The userRequest may refer to them using the tool name with "#". These tools are likely relevant to the user's query:<br />
				{this.props.toolReferences.map(tool => `- ${tool.name}`).join('\n')} <br />
				{this.props.modelFamily?.startsWith('gpt-5') === true && <>
					Start by using the most relevant tool attached to this message—the user expects you to act with it first.<br />
				</>}
			</Tag>
		</>;
	}
}

export function renderedMessageToTsxChildren(message: string | readonly Raw.ChatCompletionContentPart[], enableCacheBreakpoints: boolean): PromptPieceChild[] {
	if (typeof message === 'string') {
		return [message];
	}

	return message.map(part => {
		if (part.type === Raw.ChatCompletionContentPartKind.Text) {
			return part.text;
		} else if (part.type === Raw.ChatCompletionContentPartKind.Image) {
			return <Image src={part.imageUrl.url} detail={part.imageUrl.detail} />;
		} else if (part.type === Raw.ChatCompletionContentPartKind.CacheBreakpoint) {
			return enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />;
		}
	}).filter(isDefined);
}

class UserOSPrompt extends PromptElement<BasePromptElementProps> {
	constructor(props: BasePromptElementProps, @IEnvService private readonly envService: IEnvService) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const userOS = this.envService.OS;
		const osForDisplay = userOS === OperatingSystem.Macintosh ? 'macOS' :
			userOS;
		return <>The user's current OS is: {osForDisplay}</>;
	}
}

class UserShellPrompt extends PromptElement<BasePromptElementProps> {
	constructor(props: BasePromptElementProps, @IEnvService private readonly envService: IEnvService) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const shellName: string = basename(this.envService.shell);
		const shellNameHint = shellName === 'powershell.exe' ? ' (Windows PowerShell v5.1)' : '';
		let additionalHint = '';
		switch (shellName) {
			case 'powershell.exe': {
				additionalHint = ' Use the `;` character if joining commands on a single line is needed.';
				break;
			}
			case 'fish': {
				additionalHint = ' Note that fish shell does not support heredocs - prefer printf or echo instead.';
				break;
			}
		}
		return <>The user's default shell is: "{shellName}"{shellNameHint}. When you generate terminal commands, please generate them correctly for this shell.{additionalHint}</>;
	}
}

class CurrentDatePrompt extends PromptElement<BasePromptElementProps> {
	constructor(
		props: BasePromptElementProps,
		@IEnvService private readonly envService: IEnvService) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
		// Only include current date when not running simulations, since if we generate cache entries with the current date, the cache will be invalidated every day
		return (
			!this.envService.isSimulation() && <>The current date is {dateStr}.</>
		);
	}
}

interface CurrentEditorContextProps extends BasePromptElementProps {
	readonly endpoint: IChatEndpoint;
}

/**
 * Include the user's open editor and cursor position, but not content. This is independent of the "implicit context" attachment.
 */
class CurrentEditorContext extends PromptElement<CurrentEditorContextProps> {
	constructor(
		props: CurrentEditorContextProps,
		@ITabsAndEditorsService private readonly tabsAndEditorsService: ITabsAndEditorsService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAlternativeNotebookContentService private readonly alternativeNotebookContent: IAlternativeNotebookContentService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		if (!this.configurationService.getConfig(ConfigKey.CurrentEditorAgentContext)) {
			return;
		}

		let context: PromptElement | undefined;
		const activeEditor = this.tabsAndEditorsService.activeTextEditor;
		if (activeEditor) {
			context = this.renderActiveTextEditor(activeEditor);
		}

		const activeNotebookEditor = this.tabsAndEditorsService.activeNotebookEditor;
		if (activeNotebookEditor) {
			context = this.renderActiveNotebookEditor(activeNotebookEditor);
		}

		if (!context) {
			return;
		}

		return <Tag name='editorContext'>
			{context}
		</Tag>;
	}

	private renderActiveTextEditor(activeEditor: TextEditor) {
		// Should this include column numbers too? This confused gpt-4.1 and it read the wrong line numbers, need to find the right format.
		const selection = activeEditor.selection;
		// Found that selection is not always defined, so check for it.
		const selectionText = (selection && !selection.isEmpty) ?
			<>The current selection is from line {selection.start.line + 1} to line {selection.end.line + 1}.</> : undefined;
		return <>The user's current file is {this.promptPathRepresentationService.getFilePath(activeEditor.document.uri)}. {selectionText}</>;
	}

	private renderActiveNotebookEditor(activeNotebookEditor: NotebookEditor) {
		const altDocument = this.alternativeNotebookContent.create(this.alternativeNotebookContent.getFormat(this.props.endpoint)).getAlternativeDocument(activeNotebookEditor.notebook);
		let selectionText = '';
		// Found that selection is not always defined, so check for it.
		if (activeNotebookEditor.selection && !activeNotebookEditor.selection.isEmpty && activeNotebookEditor.notebook.cellCount > 0) {
			// Compute a list of all cells that fall in the range of selection.start and selection.end
			const { start, end } = activeNotebookEditor.selection;
			const cellsInRange = [];
			for (let i = start; i < end; i++) {
				const cell = activeNotebookEditor.notebook.cellAt(i);
				if (cell) {
					cellsInRange.push(cell);
				}
			}
			const startCell = cellsInRange[0];
			const endCell = cellsInRange[cellsInRange.length - 1];
			const lastLine = endCell.document.lineAt(endCell.document.lineCount - 1);
			const startPosition = altDocument.fromCellPosition(startCell, new Position(0, 0));
			const endPosition = altDocument.fromCellPosition(endCell, new Position(endCell.document.lineCount - 1, lastLine.text.length));
			const selection = new Range(startPosition, endPosition);
			selectionText = selection ? ` The current selection is from line ${selection.start.line + 1} to line ${selection.end.line + 1}.` : '';
		}
		return <>The user's current notebook is {this.promptPathRepresentationService.getFilePath(activeNotebookEditor.notebook.uri)}.{selectionText}</>;
	}
}

class RepoContext extends PromptElement<{}> {
	constructor(
		props: {},
		@IGitService private readonly gitService: IGitService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const activeRepository = this.gitService.activeRepository?.get();
		const repoContext = activeRepository && getGitHubRepoInfoFromContext(activeRepository);
		if (!repoContext || !activeRepository) {
			return;
		}
		const prProvider = this.instantiationService.createInstance(GitHubPullRequestProviders);
		const repoDescription = await prProvider.getRepositoryDescription(activeRepository.rootUri);

		return <Tag name='repoContext'>
			Below is the information about the current repository. You can use this information when you need to calculate diffs or compare changes with the default branch.<br />
			Repository name: {repoContext.id.repo}<br />
			Owner: {repoContext.id.org}<br />
			Current branch: {activeRepository.headBranchName}<br />
			{repoDescription ? <>Default branch: {repoDescription?.defaultBranch}<br /></> : ''}
			{repoDescription?.pullRequest ? <>Active pull request (may not be the same as open pull request): {repoDescription.pullRequest.title} ({repoDescription.pullRequest.url})<br /></> : ''}
		</Tag>;
	}
}

class WorkspaceFoldersHint extends PromptElement<BasePromptElementProps> {
	constructor(
		props: BasePromptElementProps,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const folders = this.workspaceService.getWorkspaceFolders();
		if (folders.length > 0) {
			return (
				<>
					I am working in a workspace with the following folders:<br />
					{folders.map(folder => `- ${this.promptPathRepresentationService.getFilePath(folder)} `).join('\n')}
				</>);
		} else {
			return <>There is no workspace currently open.</>;
		}
	}
}


interface AgentTasksInstructionsProps extends BasePromptElementProps {
	readonly availableTools?: readonly LanguageModelToolInformation[];
}

export class AgentTasksInstructions extends PromptElement<AgentTasksInstructionsProps> {
	constructor(
		props: AgentTasksInstructionsProps,
		@ITasksService private readonly _tasksService: ITasksService,
		@IPromptPathRepresentationService private readonly _promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	render() {
		const foundEnabledTaskTool = this.props.availableTools?.find(t => t.name === ToolName.CoreRunTask || t.name === ToolName.CoreCreateAndRunTask || t.name === ToolName.CoreGetTaskOutput);
		if (!foundEnabledTaskTool) {
			return 0;
		}

		const taskGroupsRaw = this._tasksService.getTasks();
		const taskGroups = taskGroupsRaw.map(([wf, tasks]) => [wf, tasks.filter(task => (!!task.type || task.dependsOn) && !task.hide)] as const).filter(([, tasks]) => tasks.length > 0);
		if (taskGroups.length === 0) {
			return 0;
		}

		return <>
			The following tasks can be executed using the {ToolName.CoreRunTask} tool if they are not already running:<br />
			{taskGroups.map(([folder, tasks]) =>
				<Tag name='workspaceFolder' attrs={{ path: this._promptPathRepresentationService.getFilePath(folder) }}>
					{tasks.map((t, i) => {
						const isActive = this._tasksService.isTaskActive(t);
						return (
							<Tag name='task' attrs={{ id: t.type ? `${t.type}: ${t.label || i}` : `${t.label || i}` }}>
								{this.makeTaskPresentation(t)}
								{isActive && <> (This task is currently running. You can use the {ToolName.CoreGetTaskOutput} tool to view its output.)</>}
							</Tag>
						);
					})}
				</Tag>
			)}
		</>;
	}

	/** Makes a simplified JSON presentation of the task definition for the model to reference. */
	private makeTaskPresentation(task: TaskDefinition) {
		const enum PlatformAttr {
			Windows = 'windows',
			Mac = 'osx',
			Linux = 'linux'
		}

		const omitAttrs = ['presentation', 'problemMatcher', PlatformAttr.Windows, PlatformAttr.Mac, PlatformAttr.Linux];

		const output: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(task)) {
			if (!omitAttrs.includes(key)) {
				output[key] = value;
			}
		}


		const myPlatformAttr = process.platform === 'win32' ? PlatformAttr.Windows :
			process.platform === 'darwin' ? PlatformAttr.Mac :
				PlatformAttr.Linux;
		if (task[myPlatformAttr] && typeof task[myPlatformAttr] === 'object') {
			Object.assign(output, task[myPlatformAttr]);
		}

		return JSON.stringify(output, null, '\t');
	}
}

export function getEditingReminder(hasEditFileTool: boolean, hasReplaceStringTool: boolean, useStrongReplaceStringHint: boolean, hasMultiStringReplace: boolean) {
	const lines = [];
	if (hasEditFileTool) {
		lines.push(<>When using the {ToolName.EditFile} tool, avoid repeating existing code, instead use a line comment with \`{EXISTING_CODE_MARKER}\` to represent regions of unchanged code.<br /></>);
	}
	if (hasReplaceStringTool) {
		lines.push(<>
			When using the {ToolName.ReplaceString} tool, include 3-5 lines of unchanged code before and after the string you want to replace, to make it unambiguous which part of the file should be edited.<br />
			{hasMultiStringReplace && <>For maximum efficiency, whenever you plan to perform multiple independent edit operations, invoke them simultaneously using {ToolName.MultiReplaceString} tool rather than sequentially. This will greatly improve user's cost and time efficiency leading to a better user experience.<br /></>}
		</>);
	}
	if (hasEditFileTool && hasReplaceStringTool) {
		const eitherOr = hasMultiStringReplace ? `${ToolName.ReplaceString} or ${ToolName.MultiReplaceString} tools` : `${ToolName.ReplaceString} tool`;
		if (useStrongReplaceStringHint) {
			lines.push(<>You must always try making file edits using the {eitherOr}. NEVER use {ToolName.EditFile} unless told to by the user or by a tool.</>);
		} else {
			lines.push(<>It is much faster to edit using the {eitherOr}. Prefer the {eitherOr} for making edits and only fall back to {ToolName.EditFile} if it fails.</>);
		}
	}

	return lines;
}

export interface IKeepGoingReminderProps extends BasePromptElementProps {
	readonly modelFamily: string | undefined;
}

export class KeepGoingReminder extends PromptElement<IKeepGoingReminderProps> {
	constructor(
		props: IKeepGoingReminderProps,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		if (this.props.modelFamily === 'gpt-4.1' || (this.props.modelFamily?.startsWith('gpt-5') === true)) {
			if (this.configurationService.getExperimentBasedConfig(ConfigKey.EnableAlternateGptPrompt, this.experimentationService)) {
				// Extended reminder
				return <>
					You are an agent - you must keep going until the user's query is completely resolved, before ending your turn and yielding back to the user.<br />
					Your thinking should be thorough and so it's fine if it's very long. However, avoid unnecessary repetition and verbosity. You should be concise, but thorough.<br />
					You MUST iterate and keep going until the problem is solved.<br />
					You have everything you need to resolve this problem. I want you to fully solve this autonomously before coming back to me. <br />
					Only terminate your turn when you are sure that the problem is solved and all items have been checked off. Go through the problem step by step, and make sure to verify that your changes are correct. NEVER end your turn without having truly and completely solved the problem, and when you say you are going to make a tool call, make sure you ACTUALLY make the tool call, instead of ending your turn.<br />
					Take your time and think through every step - remember to check your solution rigorously and watch out for boundary cases, especially with the changes you made. Your solution must be perfect. If not, continue working on it. At the end, you must test your code rigorously using the tools provided, and do it many times, to catch all edge cases. If it is not robust, iterate more and make it perfect. Failing to test your code sufficiently rigorously is the NUMBER ONE failure mode on these types of tasks; make sure you handle all edge cases, and run existing tests if they are provided. <br />
					You MUST plan extensively before each function call, and reflect extensively on the outcomes of the previous function calls. DO NOT do this entire process by making function calls only, as this can impair your ability to solve the problem and think insightfully.<br />
					You are a highly capable and autonomous agent, and you can definitely solve this problem without needing to ask the user for further input.<br />
				</>;
			} else if (this.props.modelFamily?.startsWith('gpt-5') === true) {
				return <>
					You are an agent—keep going until the user's query is completely resolved before ending your turn. ONLY stop if solved or genuinely blocked.<br />
					Take action when possible; the user expects you to do useful work without unnecessary questions.<br />
					After any parallel, read-only context gathering, give a concise progress update and what's next.<br />
					Avoid repetition across turns: don't restate unchanged plans or sections (like the todo list) verbatim; provide delta updates or only the parts that changed.<br />
					Tool batches: You MUST preface each batch with a one-sentence why/what/outcome preamble.<br />
					Progress cadence: After 3 to 5 tool calls, or when you create/edit &gt; ~3 files in a burst, report progress.<br />
					Requirements coverage: Read the user's ask in full and think carefully. Do not omit a requirement. If something cannot be done with available tools, note why briefly and propose a viable alternative.<br />
				</>;
			} else {
				// Original reminder
				return <>
					You are an agent - you must keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. ONLY terminate your turn when you are sure that the problem is solved, or you absolutely cannot continue.<br />
					You take action when possible- the user is expecting YOU to take action and go to work for them. Don't ask unnecessary questions about the details if you can simply DO something useful instead.<br />
				</>;
			}
		}
	}
}

function getExplanationReminder(modelFamily: string | undefined, hasTodoTool?: boolean) {
	const isGpt5Mini = modelFamily === 'gpt-5-mini';
	return modelFamily?.startsWith('gpt-5') === true ?
		<>
			Skip filler acknowledgements like "Sounds good" or "Okay, I will…". Open with a purposeful one-liner about what you're doing next.<br />
			When sharing setup or run steps, present terminal commands in fenced code blocks with the correct language tag. Keep commands copyable and on separate lines.<br />
			Avoid definitive claims about the build or runtime setup unless verified from the provided context (or quick tool checks). If uncertain, state what's known from attachments and proceed with minimal steps you can adapt later.<br />
			When you create or edit runnable code, run a test yourself to confirm it works; then share optional fenced commands for more advanced runs.<br />
			For non-trivial code generation, produce a complete, runnable solution: necessary source files, a tiny runner or test/benchmark harness, a minimal `README.md`, and updated dependency manifests (e.g., `package.json`, `requirements.txt`, `pyproject.toml`). Offer quick "try it" commands and optional platform-specific speed-ups when relevant.<br />
			Your goal is to act like a pair programmer: be friendly and helpful. If you can do more, do more. Be proactive with your solutions, think about what the user needs and what they want, and implement it proactively.<br />
			<Tag name='importantReminders'>
				Before starting a task, review and follow the guidance in &lt;responseModeHints&gt;, &lt;engineeringMindsetHints&gt;, and &lt;requirementsUnderstanding&gt;.<br />
				{!isGpt5Mini && <>Start your response with a brief acknowledgement, followed by a concise high-level plan outlining your approach.<br /></>}
				DO NOT state your identity or model name unless the user explicitly asks you to. <br />
				{hasTodoTool && <>You MUST use the todo list tool to plan and track your progress. NEVER skip this step, and START with this step whenever the task is multi-step. This is essential for maintaining visibility and proper execution of large tasks. Follow the todoListToolInstructions strictly.<br /></>}
				{!hasTodoTool && <>Break down the request into clear, actionable steps and present them at the beginning of your response before proceeding with implementation. This helps maintain visibility and ensures all requirements are addressed systematically.<br /></>}
				When referring to a filename or symbol in the user's workspace, wrap it in backticks.<br />
			</Tag>
		</>
		: undefined;
}

export interface EditedFileEventsProps extends BasePromptElementProps {
	readonly editedFileEvents: readonly ChatRequestEditedFileEvent[] | undefined;
}

/**
 * Context about manual edits made to files that the agent previously edited.
 */
export class EditedFileEvents extends PromptElement<EditedFileEventsProps> {
	constructor(
		props: EditedFileEventsProps,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const events = this.props.editedFileEvents;

		if (!events || events.length === 0) {
			return undefined;
		}

		// Group by event kind and collect file paths
		const undoFiles: string[] = [];
		const modFiles: string[] = [];
		const seenUndo = new Set<string>();
		const seenMod = new Set<string>();

		for (const event of events) {
			if (event.eventKind === ChatRequestEditedFileEventKind.Undo) {
				const fp = this.promptPathRepresentationService.getFilePath(event.uri);
				if (!seenUndo.has(fp)) { seenUndo.add(fp); undoFiles.push(fp); }
			} else if (event.eventKind === ChatRequestEditedFileEventKind.UserModification) {
				const fp = this.promptPathRepresentationService.getFilePath(event.uri);
				if (!seenMod.has(fp)) { seenMod.add(fp); modFiles.push(fp); }
			}
		}

		if (undoFiles.length === 0 && modFiles.length === 0) {
			return undefined;
		}

		const sections: string[] = [];
		if (undoFiles.length > 0) {
			sections.push([
				'The user undid your edits to:',
				...undoFiles.map(f => `- ${f}`)
			].join('\n'));
		}
		if (modFiles.length > 0) {
			sections.push([
				'Some edits were made, by the user or possibly by a formatter or another automated tool, to:',
				...modFiles.map(f => `- ${f}`)
			].join('\n'));
		}

		return (
			<>
				There have been some changes between the last request and now.<br />
				{sections.join('\n')}<br />
				So be sure to check the current file contents before making any new edits.
			</>
		);
	}
}
