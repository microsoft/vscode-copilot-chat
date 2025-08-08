/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatAgentService, defaultAgentName, editingSessionAgent2Name, editingSessionAgentEditorName, editingSessionAgentName, editorAgentName, editsAgentName, getChatParticipantIdFromName, notebookEditorAgentName, terminalAgentName, vscodeAgentName, workspaceAgentName } from '../../../platform/chat/common/chatAgents';
import { IChatQuotaService } from '../../../platform/chat/common/chatQuotaService';
import { IInteractionService } from '../../../platform/chat/common/interactionService';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { Event, Relay } from '../../../util/vs/base/common/event';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { autorun } from '../../../util/vs/base/common/observableInternal';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequest } from '../../../vscodeTypes';
import { Intent, agentsToCommands } from '../../common/constants';
import { ChatParticipantRequestHandler } from '../../prompt/node/chatParticipantRequestHandler';
import { IFeedbackReporter } from '../../prompt/node/feedbackReporter';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { ChatTitleProvider } from '../../prompt/node/title';
import { IUserFeedbackService } from './userActions';
import { getAdditionalWelcomeMessage } from './welcomeMessageProvider';

export class ChatAgentService implements IChatAgentService {
	declare readonly _serviceBrand: undefined;

	private _lastChatAgents: ChatAgents | undefined; // will be cleared when disposed

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	public debugGetCurrentChatAgents(): ChatAgents | undefined {
		return this._lastChatAgents;
	}

	register(): IDisposable {
		const chatAgents = this.instantiationService.createInstance(ChatAgents);
		chatAgents.register();
		this._lastChatAgents = chatAgents;
		return {
			dispose: () => {
				chatAgents.dispose();
				this._lastChatAgents = undefined;
			}
		};
	}
}

class ChatAgents implements IDisposable {
	private readonly _disposables = new DisposableStore();

	private additionalWelcomeMessage: vscode.MarkdownString | undefined;

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IUserFeedbackService private readonly userFeedbackService: IUserFeedbackService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IFeedbackReporter private readonly feedbackReporter: IFeedbackReporter,
		@IInteractionService private readonly interactionService: IInteractionService,
		@IChatQuotaService private readonly _chatQuotaService: IChatQuotaService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) { }

	dispose() {
		this._disposables.dispose();
	}

	register(): void {
		this.additionalWelcomeMessage = this.instantiationService.invokeFunction(getAdditionalWelcomeMessage);
		this._disposables.add(this.registerDefaultAgent());
		this._disposables.add(this.registerEditingAgent());
		this._disposables.add(this.registerEditingAgent2());
		this._disposables.add(this.registerEditingAgentEditor());
		this._disposables.add(this.registerEditsAgent());
		this._disposables.add(this.registerEditorDefaultAgent());
		this._disposables.add(this.registerNotebookEditorDefaultAgent());
		this._disposables.add(this.registerNotebookDefaultAgent());
		this._disposables.add(this.registerWorkspaceAgent());
		this._disposables.add(this.registerVSCodeAgent());
		this._disposables.add(this.registerTerminalAgent());
		this._disposables.add(this.registerTerminalPanelAgent());
	}

	private createAgent(name: string, defaultIntentIdOrGetter: IntentOrGetter, options?: { id?: string }): vscode.ChatParticipant {
		const id = options?.id || getChatParticipantIdFromName(name);
		const onRequestPaused = new Relay<vscode.ChatParticipantPauseStateEvent>();
		const agent = vscode.chat.createChatParticipant(id, this.getChatParticipantHandler(id, name, defaultIntentIdOrGetter, onRequestPaused.event));
		agent.onDidReceiveFeedback(e => {
			this.userFeedbackService.handleFeedback(e, id);
		});
		agent.onDidPerformAction(e => {
			this.userFeedbackService.handleUserAction(e, id);
		});
		if (agent.onDidChangePauseState) {
			onRequestPaused.input = agent.onDidChangePauseState as Event<vscode.ChatParticipantPauseStateEvent>;
		}
		this._disposables.add(autorun(reader => {
			agent.supportIssueReporting = this.feedbackReporter.canReport.read(reader);
		}));

		return agent;
	}

	private registerWorkspaceAgent(): IDisposable {
		const workspaceAgent = this.createAgent(workspaceAgentName, Intent.Workspace);

		workspaceAgent.iconPath = new vscode.ThemeIcon('code');

		return workspaceAgent;
	}

	private registerVSCodeAgent(): IDisposable {
		const useInsidersIcon = vscode.env.appName.includes('Insiders') || vscode.env.appName.includes('OSS');
		const vscodeAgent = this.createAgent(vscodeAgentName, Intent.VSCode);
		vscodeAgent.iconPath = useInsidersIcon ? new vscode.ThemeIcon('vscode-insiders') : new vscode.ThemeIcon('vscode');
		return vscodeAgent;
	}

	private registerTerminalAgent(): IDisposable {
		const terminalAgent = this.createAgent(terminalAgentName, Intent.Terminal);

		terminalAgent.iconPath = new vscode.ThemeIcon('terminal');
		return terminalAgent;
	}

	private registerTerminalPanelAgent(): IDisposable {
		const terminalPanelAgent = this.createAgent(terminalAgentName, Intent.Terminal, { id: 'github.copilot.terminalPanel' });

		terminalPanelAgent.iconPath = new vscode.ThemeIcon('terminal');

		return terminalPanelAgent;
	}

	private async initDefaultAgentRequestorProps(defaultAgent: vscode.ChatParticipant) {
		const tryToSetRequestorProps = async () => {
			const user = await this.octoKitService.getCurrentAuthedUser();
			if (!user) {
				return false;
			}
			defaultAgent.requester = {
				name: user.login,
				icon: URI.parse(user?.avatar_url ?? `https://avatars.githubusercontent.com/${user.login}`)
			};
			return true;
		};

		if (!(await tryToSetRequestorProps())) {
			// Not logged in yet, wait for login
			const listener = this.authenticationService.onDidAuthenticationChange(async () => {
				if (await tryToSetRequestorProps()) {
					listener.dispose();
				}
			});
		}
	}

	private registerEditingAgent(): IDisposable {
		const editingAgent = this.createAgent(editingSessionAgentName, Intent.Edit);
		editingAgent.iconPath = new vscode.ThemeIcon('copilot');
		editingAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		editingAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		return editingAgent;
	}

	private registerEditingAgentEditor(): IDisposable {
		const editingAgent = this.createAgent(editingSessionAgentEditorName, Intent.Edit);
		editingAgent.iconPath = new vscode.ThemeIcon('copilot');
		editingAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		return editingAgent;
	}

	private registerEditingAgent2(): IDisposable {
		const editingAgent = this.createAgent(editingSessionAgent2Name, Intent.Edit2);
		editingAgent.iconPath = new vscode.ThemeIcon('copilot');
		editingAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		editingAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		return editingAgent;
	}

	private registerEditsAgent(): IDisposable {
		const editingAgent = this.createAgent(editsAgentName, Intent.Agent);
		editingAgent.iconPath = new vscode.ThemeIcon('tools');
		editingAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		editingAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		return editingAgent;
	}

	private registerDefaultAgent(): IDisposable {
		const intentGetter = (request: vscode.ChatRequest) => {
			if (this.configurationService.getExperimentBasedConfig(ConfigKey.Internal.AskAgent, this.experimentationService) && request.model.capabilities.supportsToolCalling && this.configurationService.getNonExtensionConfig('chat.agent.enabled')) {
				return Intent.AskAgent;
			}
			return Intent.Unknown;
		};
		const defaultAgent = this.createAgent(defaultAgentName, intentGetter);
		defaultAgent.iconPath = new vscode.ThemeIcon('copilot');
		this.initDefaultAgentRequestorProps(defaultAgent);

		defaultAgent.helpTextPrefix = vscode.l10n.t('You can ask me general programming questions, or chat with the following participants which have specialized expertise and can perform actions:');
		const helpPostfix = vscode.l10n.t({
			message: `To have a great conversation, ask me questions as if I was a real programmer:

* **Show me the code** you want to talk about by having the files open and selecting the most important lines.
* **Make refinements** by asking me follow-up questions, adding clarifications, providing errors, etc.
* **Review my suggested code** and tell me about issues or improvements, so I can iterate on it.

You can also ask me questions about your editor selection by [starting an inline chat session](command:inlineChat.start).

Learn more about [GitHub Copilot](https://docs.github.com/copilot/using-github-copilot/getting-started-with-github-copilot?tool=vscode&utm_source=editor&utm_medium=chat-panel&utm_campaign=2024q3-em-MSFT-getstarted) in [Visual Studio Code](https://code.visualstudio.com/docs/copilot/overview). Or explore the [Copilot walkthrough](command:github.copilot.open.walkthrough).`,
			comment: "{Locked='](command:inlineChat.start)'}"
		});
		const markdownString = new vscode.MarkdownString(helpPostfix);
		markdownString.isTrusted = { enabledCommands: ['inlineChat.start', 'github.copilot.open.walkthrough'] };
		defaultAgent.helpTextPostfix = markdownString;
		defaultAgent.helpTextVariablesPrefix = vscode.l10n.t('You can also help me understand your question by using the following variables to give me extra context:');

		defaultAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		defaultAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		defaultAgent.summarizer = this.instantiationService.createInstance(ChatSummarizerProvider);

		return defaultAgent;
	}

	private registerEditorDefaultAgent(): IDisposable {
		const defaultAgent = this.createAgent(editorAgentName, Intent.Editor);
		defaultAgent.iconPath = new vscode.ThemeIcon('copilot');

		return defaultAgent;
	}

	private registerNotebookEditorDefaultAgent(): IDisposable {
		const defaultAgent = this.createAgent('notebook', Intent.Editor);
		defaultAgent.iconPath = new vscode.ThemeIcon('copilot');

		return defaultAgent;
	}

	private registerNotebookDefaultAgent(): IDisposable {
		const defaultAgent = this.createAgent(notebookEditorAgentName, Intent.notebookEditor);
		defaultAgent.iconPath = new vscode.ThemeIcon('copilot');

		return defaultAgent;
	}

	private getChatParticipantHandler(id: string, name: string, defaultIntentIdOrGetter: IntentOrGetter, onRequestPaused: Event<vscode.ChatParticipantPauseStateEvent>): vscode.ChatExtendedRequestHandler {
		return async (request, context, stream, token): Promise<vscode.ChatResult> => {

			// If we need privacy confirmation, i.e with 3rd party models. We will return a confirmation response and return early
			const privacyConfirmation = await this.requestPolicyConfirmation(request, stream);
			if (typeof privacyConfirmation === 'boolean') {
				return {};
			}
			request = privacyConfirmation;
			// If we need to switch to the base model, this function will handle it
			// Otherwise it just returns the same request passed into it
			request = await this.switchToBaseModel(request, stream);
			// The user is starting an interaction with the chat
			this.interactionService.startInteraction();

			const defaultIntentId = typeof defaultIntentIdOrGetter === 'function' ?
				defaultIntentIdOrGetter(request) :
				defaultIntentIdOrGetter;

			// empty chatAgentArgs will force InteractiveSession to not use a command or try to parse one out of the query
			const commandsForAgent = agentsToCommands[defaultIntentId];
			const intentId = request.command && commandsForAgent ?
				commandsForAgent[request.command] :
				defaultIntentId;

			const onPause = Event.chain(onRequestPaused, $ => $.filter(e => e.request === request).map(e => e.isPaused));
			const handler = this.instantiationService.createInstance(ChatParticipantRequestHandler, context.history, request, stream, token, { agentName: name, agentId: id, intentId }, onPause);
			return await handler.getResult();
		};
	}

	/**
	 * Handles showing the privacy confirmation in cases such as 3rd party models
	 * @param request The current chat request
	 * @param stream The chat response stream
	 * @returns True if a privacy confirmation is shown, otherwise a chat request object. This is used sometimes to modify the prompt
	 */
	private async requestPolicyConfirmation(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<boolean | ChatRequest> {
		const endpoint = await this.endpointProvider.getChatEndpoint(request);
		if (endpoint.policy === 'enabled') {
			return request;
		}
		// Accept the policy and agree to the terms. Then send the request through so the LLM can answer it
		if (request.acceptedConfirmationData?.[0]?.prompt && (await endpoint.acceptChatPolicy())) {
			return { ...request, prompt: request.acceptedConfirmationData[0].prompt };
		}
		// User is being prompted for the first time to acknowledge
		stream.confirmation(`Enable ${endpoint.name} for all clients`, endpoint.policy.terms, { prompt: request.prompt }, ['Enable']);
		return true;
	}

	private async switchToBaseModel(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<ChatRequest> {
		const endpoint = await this.endpointProvider.getChatEndpoint(request);
		const baseEndpoint = await this.endpointProvider.getChatEndpoint('copilot-base');
		// IF base model or BYOK model, we just continue
		if (endpoint.model === baseEndpoint.model || request.model.vendor !== 'copilot') {
			return request;
		}
		if (this._chatQuotaService.overagesEnabled || !this._chatQuotaService.quotaExhausted) {
			return request;
		}
		const baseLmModel = (await vscode.lm.selectChatModels({ id: baseEndpoint.model, family: baseEndpoint.family, vendor: 'copilot' }))[0];
		if (!baseLmModel) {
			return request;
		}
		await vscode.commands.executeCommand('workbench.action.chat.changeModel', { vendor: baseLmModel.vendor, id: baseLmModel.id, family: baseLmModel.family });
		// Switch to the base model and show a warning
		request = { ...request, model: baseLmModel };
		let messageString: vscode.MarkdownString;
		if (this.authenticationService.copilotToken?.isIndividual) {
			messageString = new vscode.MarkdownString(vscode.l10n.t({
				message: 'You have exceeded your premium request allowance. We have automatically switched you to {0} which is included with your plan. [Enable additional paid premium requests]({1}) to continue using premium models.',
				args: [baseEndpoint.name, 'command:chat.enablePremiumOverages'],
				// To make sure the translators don't break the link
				comment: ["{Locked=']({'}"]
			}));
			messageString.isTrusted = { enabledCommands: ['chat.enablePremiumOverages'] };
		} else {
			messageString = new vscode.MarkdownString(vscode.l10n.t('You have exceeded your free request allowance. We have automatically switched you to {0} which is included with your plan. To enable additional paid premium requests, contact your organization admin.', baseEndpoint.name));
		}
		stream.warning(messageString);
		return request;
	}
}

type IntentOrGetter = Intent | ((request: vscode.ChatRequest) => Intent);