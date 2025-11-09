/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, l10n, Uri } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitService } from '../../../platform/git/common/gitService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { localize } from '../../../util/vs/nls';
import { ICopilotCLIModels } from '../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../agents/copilotcli/node/copilotcliSession';
import { ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { ConfirmationResult, CopilotCloudSessionsProvider } from './copilotCloudSessionsProvider';

/** Option ID for model selection in chat session options */
const MODELS_OPTION_ID = 'model';

/** Option ID for worktree isolation in chat session options */
const ISOLATION_OPTION_ID = 'isolation';

/**
 * Tracks model selections per session.
 * Maps session IDs to their selected model options.
 * TODO@rebornix: we should have proper storage for the session model preference (revisit with API)
 */
const _sessionModel: Map<string, vscode.ChatSessionProviderOptionItem | undefined> = new Map();

/**
 * Manages git worktrees for Copilot CLI chat sessions.
 * Handles creation, storage, and retrieval of isolated worktrees for sessions.
 */
export class CopilotCLIWorktreeManager {
	/** Storage key for default session isolation preference */
	static COPILOT_CLI_DEFAULT_ISOLATION_MEMENTO_KEY = 'github.copilot.cli.sessionIsolation';

	/** Storage key for session-to-worktree path mappings */
	static COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';

	/** Maps session IDs to their isolation preference */
	private _sessionIsolation: Map<string, boolean> = new Map();

	/** Maps session IDs to their worktree paths */
	private _sessionWorktrees: Map<string, string> = new Map();

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext) { }

	/**
	 * Creates a git worktree for a session if isolation is enabled.
	 * @param sessionId - The unique identifier of the chat session
	 * @param stream - The chat response stream for progress messages
	 * @returns The path to the created worktree, or undefined if isolation is disabled or creation failed
	 */
	async createWorktreeIfNeeded(sessionId: string, stream: vscode.ChatResponseStream): Promise<string | undefined> {
		const isolationEnabled = this._sessionIsolation.get(sessionId) ?? false;
		if (!isolationEnabled) {
			return undefined;
		}

		try {
			const worktreePath = await vscode.commands.executeCommand('git.createWorktreeWithDefaults') as string | undefined;
			if (worktreePath) {
				stream.progress(vscode.l10n.t('Created isolated worktree at {0}', worktreePath));
				return worktreePath;
			} else {
				stream.warning(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory'));
			}
		} catch (error) {
			stream.warning(vscode.l10n.t('Error creating worktree for isolation: {0}', error instanceof Error ? error.message : String(error)));
		}
		return undefined;
	}

	/**
	 * Stores the worktree path for a session in both memory and persistent storage.
	 * @param sessionId - The unique identifier of the chat session
	 * @param workingDirectory - The path to the worktree
	 */
	async storeWorktreePath(sessionId: string, workingDirectory: string): Promise<void> {
		this._sessionWorktrees.set(sessionId, workingDirectory);
		const sessionWorktrees = this.extensionContext.globalState.get<Record<string, string>>(CopilotCLIWorktreeManager.COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY, {});
		sessionWorktrees[sessionId] = workingDirectory;
		await this.extensionContext.globalState.update(CopilotCLIWorktreeManager.COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY, sessionWorktrees);
	}

	/**
	 * Retrieves the worktree path for a session from memory or persistent storage.
	 * @param sessionId - The unique identifier of the chat session
	 * @returns The worktree path, or undefined if not found
	 */
	getWorktreePath(sessionId: string): string | undefined {
		let workingDirectory = this._sessionWorktrees.get(sessionId);
		if (!workingDirectory) {
			const sessionWorktrees = this.extensionContext.globalState.get<Record<string, string>>(CopilotCLIWorktreeManager.COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY, {});
			workingDirectory = sessionWorktrees[sessionId];
			if (workingDirectory) {
				this._sessionWorktrees.set(sessionId, workingDirectory);
			}
		}
		return workingDirectory;
	}

	/**
	 * Gets the relative (display) name of the worktree for a session.
	 * Extracts the worktree name from its full path.
	 * @param sessionId - The unique identifier of the chat session
	 * @returns The worktree name (last path segment), or undefined if no worktree exists
	 */
	getWorktreeRelativePath(sessionId: string): string | undefined {
		const worktreePath = this.getWorktreePath(sessionId);
		if (!worktreePath) {
			return undefined;
		}

		// TODO@rebornix, @osortega: read the workingtree name from git extension
		const lastIndex = worktreePath.lastIndexOf('/');
		return worktreePath.substring(lastIndex + 1);

	}

	/**
	 * Gets the isolation preference for a session.
	 * Falls back to the global default isolation setting if not set for this session.
	 * @param sessionId - The unique identifier of the chat session
	 * @returns true if isolation is enabled for this session, false otherwise
	 */
	getIsolationPreference(sessionId: string): boolean {
		if (!this._sessionIsolation.has(sessionId)) {
			const defaultIsolation = this.extensionContext.globalState.get<boolean>(CopilotCLIWorktreeManager.COPILOT_CLI_DEFAULT_ISOLATION_MEMENTO_KEY, false);
			this._sessionIsolation.set(sessionId, defaultIsolation);
		}
		return this._sessionIsolation.get(sessionId) ?? false;
	}

	/**
	 * Sets the isolation preference for a session and updates the global default.
	 * @param sessionId - The unique identifier of the chat session
	 * @param enabled - Whether isolation should be enabled
	 */
	async setIsolationPreference(sessionId: string, enabled: boolean): Promise<void> {
		this._sessionIsolation.set(sessionId, enabled);
		await this.extensionContext.globalState.update(CopilotCLIWorktreeManager.COPILOT_CLI_DEFAULT_ISOLATION_MEMENTO_KEY, enabled);
	}
}


/**
 * Utility namespace for converting between session IDs and VS Code URIs.
 * Uses the 'copilotcli' URI scheme to represent CLI sessions.
 */
namespace SessionIdForCLI {
	/**
	 * Converts a session ID to a VS Code URI.
	 * @param sessionId - The session ID to convert
	 * @returns A URI with the 'copilotcli' scheme
	 */
	export function getResource(sessionId: string): vscode.Uri {
		return vscode.Uri.from({
			scheme: 'copilotcli', path: `/${sessionId}`,
		});
	}

	/**
	 * Extracts the session ID from a VS Code URI.
	 * @param resource - The URI to parse
	 * @returns The session ID (path without leading slash)
	 */
	export function parse(resource: vscode.Uri): string {
		return resource.path.slice(1);
	}
}

/**
 * Escapes XML special characters in a string.
 * Used to safely embed text in XML attributes and elements.
 * @param text - The text to escape
 * @returns The escaped text with HTML/XML entities (&amp;, &lt;, &gt;, &quot;, &apos;)
 */
function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Provides chat session items for Copilot CLI sessions.
 * Implements VS Code's ChatSessionItemProvider interface to display CLI sessions in the chat panel.
 */
export class CopilotCLIChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {
	/** Event fired when the list of chat session items changes */
	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	/** Event fired when a chat session item is committed (e.g., renamed after creation) */
	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;
	constructor(
		private readonly worktreeManager: CopilotCLIWorktreeManager,
		@ICopilotCLISessionService private readonly copilotcliSessionService: ICopilotCLISessionService,
		@ICopilotCLITerminalIntegration private readonly terminalIntegration: ICopilotCLITerminalIntegration,
	) {
		super();
		this._register(this.terminalIntegration);
		this._register(this.copilotcliSessionService.onDidChangeSessions(() => {
			this.refresh();
		}));
	}

	/**
	 * Refreshes the list of chat session items.
	 * Triggers a refresh in the chat panel UI.
	 */
	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	/**
	 * Swaps a chat session item with a modified version.
	 * Used when updating session metadata (e.g., after creation).
	 * @param original - The original session item
	 * @param modified - The modified session item
	 */
	public swap(original: vscode.ChatSessionItem, modified: vscode.ChatSessionItem): void {
		this._onDidCommitChatSessionItem.fire({ original, modified });
	}

	/**
	 * Provides all chat session items for display in the chat panel.
	 * @param token - Cancellation token
	 * @returns Array of chat session items
	 */
	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this.copilotcliSessionService.getAllSessions(token);
		const diskSessions = sessions.map(session => this._toChatSessionItem(session));

		// Update context for UI state (e.g., showing empty state)
		const count = diskSessions.length;
		vscode.commands.executeCommand('setContext', 'github.copilot.chat.cliSessionsEmpty', count === 0);

		return diskSessions;
	}

	/**
	 * Converts a session object to a VS Code chat session item.
	 * @param session - The session data to convert
	 * @returns A chat session item for display in the UI
	 */
	private _toChatSessionItem(session: { id: string; label: string; timestamp: Date; status?: vscode.ChatSessionStatus }): vscode.ChatSessionItem {
		// Create a URI resource for this session using the 'copilotcli' scheme
		const resource = SessionIdForCLI.getResource(session.id);
		
		// Use provided label or default to 'Copilot CLI'
		const label = session.label || 'Copilot CLI';
		
		// Check if this session has an associated worktree for isolation
		const worktreePath = this.worktreeManager.getWorktreeRelativePath(session.id);
		let description: vscode.MarkdownString | undefined;
		if (worktreePath) {
			// Display worktree name with git icon in the description
			description = new vscode.MarkdownString(`$(git-merge) ${worktreePath}`);
			description.supportThemeIcons = true;
		}
		
		// Build tooltip with session details
		const tooltipLines = [`Copilot CLI session: ${label}`];
		if (worktreePath) {
			tooltipLines.push(`Worktree: ${worktreePath}`);
		}
		
		// Default to Completed status if not specified
		const status = session.status ?? vscode.ChatSessionStatus.Completed;
		return {
			resource,
			label,
			description,
			tooltip: tooltipLines.join('\n'),
			timing: { startTime: session.timestamp.getTime() },
			status
		};
	}

	/**
	 * Creates and opens a new Copilot CLI terminal.
	 * The terminal name can be customized via the COPILOTCLI_TERMINAL_TITLE environment variable.
	 */
	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || 'Copilot CLI';
		await this.terminalIntegration.openTerminal(terminalName);
	}

	/**
	 * Resumes a Copilot CLI session in a terminal.
	 * Opens a terminal and passes the --resume flag with the session ID.
	 * @param sessionItem - The session item to resume
	 */
	public async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const id = SessionIdForCLI.parse(sessionItem.resource);
		const terminalName = sessionItem.label || id;
		const cliArgs = ['--resume', id];
		await this.terminalIntegration.openTerminal(terminalName, cliArgs);
	}
}

/**
 * Provides content and options for Copilot CLI chat sessions.
 * Implements VS Code's ChatSessionContentProvider interface to manage session state and options.
 */
export class CopilotCLIChatSessionContentProvider implements vscode.ChatSessionContentProvider {
	constructor(
		private readonly worktreeManager: CopilotCLIWorktreeManager,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	/**
	 * Provides the content and initial state for a chat session.
	 * Loads session history, selected model, and configuration options.
	 * @param resource - The URI identifying the chat session
	 * @param token - Cancellation token
	 * @returns A chat session object with history and options
	 */
	async provideChatSessionContent(resource: Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		// Fetch available models and default model in parallel for efficiency
		const [models, defaultModel] = await Promise.all([
			this.copilotCLIModels.getAvailableModels(),
			this.copilotCLIModels.getDefaultModel()
		]);
		
		// Extract session ID from the resource URI
		const copilotcliSessionId = SessionIdForCLI.parse(resource);
		
		// Determine the preferred model for this session
		const preferredModelId = _sessionModel.get(copilotcliSessionId)?.id;
		const preferredModel = (preferredModelId ? models.find(m => m.id === preferredModelId) : undefined) ?? defaultModel;

		// Check if session has an associated worktree
		const workingDirectory = this.worktreeManager.getWorktreePath(copilotcliSessionId);
		
		// Try to load existing session from disk
		const existingSession = await this.sessionService.getSession(copilotcliSessionId, undefined, workingDirectory, false, token);
		
		// Get the model selected in the existing session (if any)
		const selectedModelId = await existingSession?.getSelectedModelId();
		const selectedModel = selectedModelId ? models.find(m => m.id === selectedModelId) : undefined;
		
		// Build options for the session UI
		const options: Record<string, string> = {
			[MODELS_OPTION_ID]: _sessionModel.get(copilotcliSessionId)?.id ?? defaultModel.id,
		};

		// For new sessions, add isolation option if the feature is enabled
		if (!existingSession && this.configurationService.getConfig(ConfigKey.Internal.CLIIsolationEnabled)) {
			const isolationEnabled = this.worktreeManager.getIsolationPreference(copilotcliSessionId);
			options[ISOLATION_OPTION_ID] = isolationEnabled ? 'enabled' : 'disabled';
		}
		
		// Load chat history from existing session, or use empty array for new sessions
		const history = await existingSession?.getChatHistory() || [];

		// Cache the selected model for this session if not already set
		if (!_sessionModel.get(copilotcliSessionId)) {
			_sessionModel.set(copilotcliSessionId, selectedModel ?? preferredModel);
		}

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options: options
		};
	}

	/**
	 * Provides the available options for chat sessions (e.g., model selection, isolation).
	 * @returns Configuration options for the chat session provider
	 */
	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		return {
			optionGroups: [
				{
					id: MODELS_OPTION_ID,
					name: 'Model',
					description: 'Select the language model to use',
					items: await this.copilotCLIModels.getAvailableModels()
				},
				{
					id: ISOLATION_OPTION_ID,
					name: 'Isolation',
					description: 'Enable worktree isolation for this session',
					items: [
						{ id: 'enabled', name: 'Isolated' },
						{ id: 'disabled', name: 'Workspace' }
					]
				}
			]
		};
	}

	/**
	 * Handles changes to session options (e.g., model selection, isolation preference).
	 * Stores the updated settings in memory and persists user preferences.
	 * @param resource - The URI identifying the chat session
	 * @param updates - Array of option updates to apply
	 * @param token - Cancellation token
	 */
	async provideHandleOptionsChange(resource: Uri, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, token: vscode.CancellationToken): Promise<void> {
		const sessionId = SessionIdForCLI.parse(resource);
		const models = await this.copilotCLIModels.getAvailableModels();
		
		// Process each option update
		for (const update of updates) {
			if (update.optionId === MODELS_OPTION_ID) {
				// Handle model selection changes
				if (typeof update.value === 'undefined') {
					// Clear model selection if value is undefined
					_sessionModel.set(sessionId, undefined);
				} else {
					// Find and store the selected model
					const model = models.find(m => m.id === update.value);
					_sessionModel.set(sessionId, model);
					
					// Persist the user's choice to global state for future sessions
					if (model) {
						this.copilotCLIModels.setDefaultModel(model);
					}
				}
			} else if (update.optionId === ISOLATION_OPTION_ID) {
				// Handle isolation (worktree) option changes
				await this.worktreeManager.setIsolationPreference(sessionId, update.value === 'enabled');
			}
		}
	}
}

/**
 * Handles chat requests for Copilot CLI sessions.
 * Orchestrates request processing, delegation to cloud agents, and session management.
 */
export class CopilotCLIChatSessionParticipant {
	constructor(
		private readonly promptResolver: CopilotCLIPromptResolver,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
		private readonly cloudSessionProvider: CopilotCloudSessionsProvider | undefined,
		private readonly summarizer: ChatSummarizerProvider,
		private readonly worktreeManager: CopilotCLIWorktreeManager,
		@IGitService private readonly gitService: IGitService,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) { }

	/**
	 * Creates a chat request handler function.
	 * @returns A bound handler function for processing chat requests
	 */
	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	/**
	 * Handles an incoming chat request.
	 * Routes requests to appropriate handlers based on session state and request type.
	 * @param request - The chat request to process
	 * @param context - The chat context including session information
	 * @param stream - The response stream for sending messages
	 * @param token - Cancellation token
	 * @returns A chat result or void
	 */
	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		const { chatSessionContext } = context;


		/* __GDPR__
			"copilotcli.chat.invoke" : {
				"owner": "joshspicer",
				"comment": "Event sent when a CopilotCLI chat request is made.",
				"hasChatSessionItem": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Invoked with a chat session item." },
				"isUntitled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Indicates if the chat session is untitled." },
				"hasDelegatePrompt": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Indicates if the prompt is a /delegate command." }
			}
		*/
		// Send telemetry about the chat request
		this.telemetryService.sendMSFTTelemetryEvent('copilotcli.chat.invoke', {
			hasChatSessionItem: String(!!chatSessionContext?.chatSessionItem),
			isUntitled: String(chatSessionContext?.isUntitled),
			hasDelegatePrompt: String(request.prompt.startsWith('/delegate'))
		});

		// Handle requests without session context (invoked from normal chat or cloud button)
		if (!chatSessionContext) {
			if (request.acceptedConfirmationData || request.rejectedConfirmationData) {
				stream.warning(vscode.l10n.t('No chat session context available for confirmation data handling.'));
				return {};
			}

			// Create a new CLI session and push chat content to it
			return await this.handlePushConfirmationData(request, context, stream, token);
		}

		// Determine which model to use for this request
		const defaultModel = await this.copilotCLIModels.getDefaultModel();
		const { resource } = chatSessionContext.chatSessionItem;
		const id = SessionIdForCLI.parse(resource);
		const preferredModel = _sessionModel.get(id);
		// For existing sessions we cannot fall back, as the model info would be updated in _sessionModel
		const modelId = this.copilotCLIModels.toModelProvider(preferredModel?.id || defaultModel.id);
		
		// Resolve the prompt and any attachments from the request
		const { prompt, attachments } = await this.promptResolver.resolvePrompt(request, token);

		// Handle new (untitled) sessions - create session and optional worktree
		if (chatSessionContext.isUntitled) {
			const workingDirectory = await this.worktreeManager.createWorktreeIfNeeded(id, stream);
			const session = await this.sessionService.createSession(prompt, modelId, workingDirectory, token);
			
			// Store worktree path if one was created
			if (workingDirectory) {
				await this.worktreeManager.storeWorktreePath(session.sessionId, workingDirectory);
			}

			// Process the request with the CLI session
			await session.handleRequest(prompt, attachments, modelId, stream, request.toolInvocationToken, token);

			// Update the session item with the actual session ID and user's prompt as the label
			this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { resource: SessionIdForCLI.getResource(session.sessionId), label: request.prompt ?? 'CopilotCLI' });


			return {};
		}

		// Handle existing sessions - retrieve session from storage
		const workingDirectory = this.worktreeManager.getWorktreePath(id);
		const session = await this.sessionService.getSession(id, undefined, workingDirectory, false, token);
		if (!session) {
			stream.warning(vscode.l10n.t('Chat session not found.'));
			return {};
		}

		// Handle confirmation responses (e.g., user accepted/rejected delegation with uncommitted changes)
		if (request.acceptedConfirmationData || request.rejectedConfirmationData) {
			return await this.handleConfirmationData(session, request, context, stream, token);
		}

		// Handle /delegate command to delegate work to cloud agent
		if (request.prompt.startsWith('/delegate')) {
			await this.handleDelegateCommand(session, request, context, stream, token);
			return {};
		}

		// Process normal chat request with the CLI session
		await session.handleRequest(prompt, attachments, modelId, stream, request.toolInvocationToken, token);
		return {};
	}

	/**
	 * Handles the /delegate command to delegate work to a cloud agent.
	 * Creates a pull request with the current chat context and history.
	 * @param session - The current CLI session
	 * @param request - The chat request containing the delegate command
	 * @param context - The chat context
	 * @param stream - The response stream
	 * @param token - Cancellation token
	 */
	private async handleDelegateCommand(session: ICopilotCLISession, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		// Verify cloud agent is available
		if (!this.cloudSessionProvider) {
			stream.warning(localize('copilotcli.missingCloudAgent', "No cloud agent available"));
			return {};
		}

		// Check for uncommitted changes in the workspace
		const currentRepository = this.gitService.activeRepository.get();
		const hasChanges = (currentRepository?.changes?.indexChanges && currentRepository.changes.indexChanges.length > 0);

		// Warn user if there are uncommitted changes
		if (hasChanges) {
			stream.warning(localize('copilotcli.uncommittedChanges', "You have uncommitted changes in your workspace. The cloud agent will start from the last committed state. Consider committing your changes first if you want to include them."));
		}

		// Summarize the conversation history to provide context to the cloud agent
		const history = await this.summarizer.provideChatSummary(context, token);
		
		// Extract the actual prompt by removing the '/delegate' prefix
		const prompt = request.prompt.substring('/delegate'.length).trim();
		
		// Try to handle uncommitted changes scenario, or create delegated session
		if (!await this.cloudSessionProvider.tryHandleUncommittedChanges({
			prompt: prompt,
			history: history,
			chatContext: context
		}, stream, token)) {
			// Create a new cloud agent session (which creates a PR)
			const prInfo = await this.cloudSessionProvider.createDelegatedChatSession({
				prompt,
				history,
				chatContext: context
			}, stream, token);
			
			// Record the delegation in the CLI session history
			if (prInfo) {
				await this.recordPushToSession(session, request.prompt, prInfo, token);
			}
		}
	}

	/**
	 * Handles user confirmation responses for actions like delegating with uncommitted changes.
	 * @param session - The current CLI session
	 * @param request - The chat request with confirmation data
	 * @param context - The chat context
	 * @param stream - The response stream
	 * @param token - Cancellation token
	 * @returns A chat result
	 */
	private async handleConfirmationData(session: ICopilotCLISession, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		// Collect all confirmation results (both accepted and rejected)
		const results: ConfirmationResult[] = [];
		
		// Add accepted confirmations
		results.push(...(request.acceptedConfirmationData?.map(data => ({ step: data.step, accepted: true, metadata: data?.metadata })) ?? []));
		
		// Add rejected confirmations (excluding duplicates already in accepted)
		results.push(...((request.rejectedConfirmationData ?? []).filter(data => !results.some(r => r.step === data.step)).map(data => ({ step: data.step, accepted: false, metadata: data?.metadata }))));

		// Process each confirmation result
		for (const data of results) {
			switch (data.step) {
				case 'uncommitted-changes':
					{
						// Handle response to uncommitted changes confirmation
						if (!data.accepted || !data.metadata) {
							stream.markdown(vscode.l10n.t('Cloud agent delegation request cancelled.'));
							return {};
						}
						
						// User accepted - proceed with delegation
						const prInfo = await this.cloudSessionProvider?.createDelegatedChatSession({
							prompt: data.metadata.prompt,
							history: data.metadata.history,
							chatContext: context
						}, stream, token);
						
						// Record the delegation in session history
						if (prInfo) {
							await this.recordPushToSession(session, request.prompt, prInfo, token);
						}
						return {};
					}
				default:
					// Warn about unknown confirmation steps
					stream.warning(`Unknown confirmation step: ${data.step}\n\n`);
					break;
			}
		}
		return {};
	}

	/**
	 * Handles pushing chat content to a new CLI session when invoked without session context.
	 * Creates a new session and opens it with the current prompt and history.
	 * @param request - The chat request
	 * @param context - The chat context
	 * @param stream - The response stream
	 * @param token - Cancellation token
	 * @returns A chat result or void
	 */
	private async handlePushConfirmationData(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		const prompt = request.prompt;
		
		// Get conversation history if available, or summarize the context
		const history = context.chatSummary?.history ?? await this.summarizer.provideChatSummary(context, token);

		// Combine prompt with history summary for context
		const requestPrompt = history ? `${prompt}\n**Summary**\n${history}` : prompt;
		
		// Create a new CLI session with the combined prompt
		const session = await this.sessionService.createSession(requestPrompt, undefined, undefined, token);

		// Open the new CLI session in the UI
		await vscode.commands.executeCommand('vscode.open', SessionIdForCLI.getResource(session.sessionId));
		
		// Submit the prompt to the newly opened session
		await vscode.commands.executeCommand('workbench.action.chat.submit', { inputValue: requestPrompt });
		return {};
	}

	/**
	 * Records a delegation to cloud agent in the session history.
	 * Adds user and assistant messages with PR metadata.
	 * @param session - The CLI session to update
	 * @param userPrompt - The user's original prompt
	 * @param prInfo - Information about the created pull request
	 * @param token - Cancellation token
	 */
	private async recordPushToSession(
		session: ICopilotCLISession,
		userPrompt: string,
		prInfo: { uri: string; title: string; description: string; author: string; linkTag: string },
		token: vscode.CancellationToken
	): Promise<void> {
		// Add user message event
		session.addUserMessage(userPrompt);

		// Add assistant message event with embedded PR metadata
		const assistantMessage = `GitHub Copilot cloud agent has begun working on your request. Follow its progress in the associated chat and pull request.\n<pr_metadata uri="${prInfo.uri}" title="${escapeXml(prInfo.title)}" description="${escapeXml(prInfo.description)}" author="${escapeXml(prInfo.author)}" linkTag="${escapeXml(prInfo.linkTag)}"/>`;
		session.addUserAssistantMessage(assistantMessage);
	}
}

/**
 * Registers VS Code commands for Copilot CLI chat sessions.
 * Includes commands for refreshing, deleting, and managing CLI sessions and terminals.
 * @param copilotcliSessionItemProvider - The session item provider
 * @param copilotCLISessionService - The session service
 * @returns A disposable for unregistering all commands
 */
export function registerCLIChatCommands(copilotcliSessionItemProvider: CopilotCLIChatSessionItemProvider, copilotCLISessionService: ICopilotCLISessionService): IDisposable {
	const disposableStore = new DisposableStore();
	
	// Register refresh command (legacy namespace)
	disposableStore.add(vscode.commands.registerCommand('github.copilot.copilotcli.sessions.refresh', () => {
		copilotcliSessionItemProvider.refresh();
	}));
	
	// Register refresh command (current namespace)
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.refresh', () => {
		copilotcliSessionItemProvider.refresh();
	}));
	
	// Register delete session command with confirmation dialog
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.delete', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.resource) {
			const deleteLabel = l10n.t('Delete');
			
			// Show confirmation dialog before deleting
			const result = await vscode.window.showWarningMessage(
				l10n.t('Are you sure you want to delete the session?'),
				{ modal: true },
				deleteLabel
			);

			// Proceed with deletion if user confirmed
			if (result === deleteLabel) {
				const id = SessionIdForCLI.parse(sessionItem.resource);
				await copilotCLISessionService.deleteSession(id);
				copilotcliSessionItemProvider.refresh();
			}
		}
	}));
	
	// Register command to resume session in terminal
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.resumeInTerminal', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.resource) {
			await copilotcliSessionItemProvider.resumeCopilotCLISessionInTerminal(sessionItem);
		}
	}));

	// Register command to create a new terminal session
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.newTerminalSession', async () => {
		await copilotcliSessionItemProvider.createCopilotCLITerminal();
	}));
	
	return disposableStore;
}