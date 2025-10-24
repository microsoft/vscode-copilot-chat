/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../platform/git/common/gitService';
import { PullRequestSearchItem, SessionInfo } from '../../../platform/github/common/githubAPI';
import { IOctoKitService, JobInfo, RemoteAgentJobPayload } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { body_suffix, CONTINUE_TRUNCATION, extractTitle, formatBodyPlaceholder, getAuthorDisplayName, getRepoId, JOBS_API_VERSION, RemoteAgentResult, SessionIdForPr, toOpenPullRequestWebviewUri, truncatePrompt } from '../vscode/copilotCodingAgentUtils';
import { ChatSessionContentBuilder } from './copilotCloudSessionContentBuilder';
import { IPullRequestFileChangesService } from './pullRequestFileChangesService';

type ConfirmationResult = { step: string; accepted: boolean; metadata?: CreatePromptMetadata | UncommittedChangesMetadata };

interface CreatePromptMetadata {
	prompt: string;
	history?: string;
	references?: vscode.ChatPromptReference[];
}

interface UncommittedChangesMetadata {
	prompt: string;
	problemContext?: string;
	customAgentName?: string;
}

export interface PullRequestInfo {
	uri: string;
	title: string;
	description: string;
	author: string;
	linkTag: string;
}

export interface PullRequestInfo {
	uri: string;
	title: string;
	description: string;
	author: string;
	linkTag: string;
}

export interface PullRequestInfo {
	uri: string;
	title: string;
	description: string;
	author: string;
	linkTag: string;
}

export interface ICommentResult {
	id: number;
	url: string;
	body: string;
	user?: {
		login: string;
		url: string;
		avatarUrl: string;
		email: string;
		id: string;
		name: string;
		specialDisplayName?: string;
		accountType: string;
	};
	createdAt: string;
	htmlUrl: string;
	graphNodeId: string;
}

const AGENTS_OPTION_GROUP_ID = 'agents';
const DEFAULT_AGENT_ID = '___vscode_default___';

export class CopilotChatSessionsProvider extends Disposable implements vscode.ChatSessionContentProvider, vscode.ChatSessionItemProvider {
	public static readonly TYPE = 'copilot-cloud-agent';
	private readonly DELEGATE_MODAL_DETAILS = vscode.l10n.t('The agent will work asynchronously to create a pull request with your requested changes.');
	private readonly _onDidChangeChatSessionItems = this._register(new vscode.EventEmitter<void>());
	public readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;
	private readonly _onDidCommitChatSessionItem = this._register(new vscode.EventEmitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem = this._onDidCommitChatSessionItem.event;
	private chatSessions: Map<number, PullRequestSearchItem> = new Map();
	private chatSessionItemsPromise: Promise<vscode.ChatSessionItem[]> | undefined;
	private sessionAgentMap: Map<Uri, string> = new Map();
	public chatParticipant = vscode.chat.createChatParticipant(CopilotChatSessionsProvider.TYPE, async (request, context, stream, token) =>
		await this.chatParticipantImpl(request, context, stream, token)
	);

	constructor(
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@IGitService private readonly _gitService: IGitService,
		@ITelemetryService private readonly telemetry: ITelemetryService,
		@ILogService private readonly logService: ILogService,
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
		@IPullRequestFileChangesService private readonly _prFileChangesService: IPullRequestFileChangesService,
	) {
		super();
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	async provideChatSessionProviderOptions(token: vscode.CancellationToken): Promise<vscode.ChatSessionProviderOptions> {
		const repoId = await getRepoId(this._gitService);
		if (!repoId) {
			return { optionGroups: [] };
		}

		try {
			const customAgents = await this._octoKitService.getCustomAgents(repoId.org, repoId.repo);
			const agentItems: vscode.ChatSessionProviderOptionItem[] = [
				{ id: DEFAULT_AGENT_ID, name: vscode.l10n.t('Default Agent') },
				...customAgents.map(agent => ({
					id: agent.name,
					name: agent.display_name || agent.name
				}))
			];
			return {
				optionGroups: [
					{
						id: AGENTS_OPTION_GROUP_ID,
						name: vscode.l10n.t('Custom Agents'),
						description: vscode.l10n.t('Select which agent to use'),
						items: agentItems,
					}
				]
			};
		} catch (error) {
			this.logService.error(`Error fetching custom agents: ${error}`);
			return { optionGroups: [] };
		}
	}

	provideHandleOptionsChange(resource: Uri, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, token: vscode.CancellationToken): void {
		for (const update of updates) {
			if (update.optionId === AGENTS_OPTION_GROUP_ID) {
				if (update.value) {
					this.sessionAgentMap.set(resource, update.value);
					this.logService.info(`Agent changed for session ${resource}: ${update.value}`);
				} else {
					this.sessionAgentMap.delete(resource);
					this.logService.info(`Agent cleared for session ${resource}`);
				}
			}
		}
	}

	async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		if (this.chatSessionItemsPromise) {
			return this.chatSessionItemsPromise;
		}
		this.chatSessionItemsPromise = (async () => {
			const repoId = await getRepoId(this._gitService);
			if (!repoId) {
				return [];
			}

			const sessions = await this._octoKitService.getAllOpenSessions(`${repoId.org}/${repoId.repo}`);

			// Group sessions by resource_id and keep only the latest per resource_id
			const latestSessionsMap = new Map<number, SessionInfo>();
			for (const session of sessions) {
				const existing = latestSessionsMap.get(session.resource_id);
				if (!existing || this.shouldPushSession(session, existing)) {
					latestSessionsMap.set(session.resource_id, session);
				}
			}

			// Fetch PRs for all unique resource_global_ids in parallel
			const uniqueGlobalIds = new Set(Array.from(latestSessionsMap.values()).map(s => s.resource_global_id));
			const prFetches = Array.from(uniqueGlobalIds).map(async globalId => {
				const pr = await this._octoKitService.getPullRequestFromGlobalId(globalId);
				return { globalId, pr };
			});
			const prResults = await Promise.all(prFetches);
			const prMap = new Map(prResults.filter(r => r.pr).map(r => [r.globalId, r.pr!]));

			// Create session items from latest sessions
			const sessionItems = await Promise.all(Array.from(latestSessionsMap.values()).map(async sessionItem => {
				const pr = prMap.get(sessionItem.resource_global_id);
				if (!pr) {
					return undefined;
				}

				const uri = await toOpenPullRequestWebviewUri({ owner: repoId.org, repo: repoId.repo, pullRequestNumber: pr.number });
				const prLinkTitle = vscode.l10n.t('Open pull request in VS Code');
				const description = new vscode.MarkdownString(`[#${pr.number}](${uri.toString()} "${prLinkTitle}")`);

				const session = {
					resource: vscode.Uri.from({ scheme: CopilotChatSessionsProvider.TYPE, path: '/' + pr.number }),
					label: pr.title,
					status: this.getSessionStatusFromSession(sessionItem),
					description,
					timing: {
						startTime: new Date(sessionItem.last_updated_at).getTime(),
					},
					statistics: {
						insertions: pr.additions,
						deletions: pr.deletions
					},
					fullDatabaseId: pr.fullDatabaseId.toString(),
					pullRequestDetails: pr,
				};
				this.chatSessions.set(pr.number, pr);
				return session;
			}));
			const filteredSessions = sessionItems
				// Remove any undefined sessions
				.filter(item => item !== undefined)
				// Only keep sessions with attached PRs not CLOSED or MERGED
				.filter(item => {
					const pr = item.pullRequestDetails;
					const state = pr.state.toUpperCase();
					return state !== 'CLOSED' && state !== 'MERGED';
				});

			vscode.commands.executeCommand('setContext', 'github.copilot.chat.cloudSessionsEmpty', filteredSessions.length === 0);
			return filteredSessions;
		})().finally(() => {
			this.chatSessionItemsPromise = undefined;
		});
		return this.chatSessionItemsPromise;
	}

	private shouldPushSession(sessionItem: SessionInfo, existing: SessionInfo | undefined): boolean {
		if (!existing) {
			return true;
		}
		const existingDate = new Date(existing.last_updated_at);
		const newDate = new Date(sessionItem.last_updated_at);
		return newDate > existingDate;
	}

	async provideChatSessionContent(resource: Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const indexedSessionId = SessionIdForPr.parse(resource);
		let pullRequestNumber: number | undefined;
		if (indexedSessionId) {
			pullRequestNumber = indexedSessionId.prNumber;
		}
		if (typeof pullRequestNumber === 'undefined') {
			pullRequestNumber = SessionIdForPr.parsePullRequestNumber(resource);
			if (isNaN(pullRequestNumber)) {
				this.logService.error(`Invalid pull request number: ${resource}`);
				return this.createEmptySession(resource);
			}
		}

		const pr = await this.findPR(pullRequestNumber);
		const getProblemStatement = async (sessions: SessionInfo[]) => {
			if (sessions.length === 0) {
				return undefined;
			}
			const repoId = await getRepoId(this._gitService);
			if (!repoId) {
				return undefined;
			}
			const jobInfo = await this._octoKitService.getJobBySessionId(repoId.org, repoId.repo, sessions[0].id, 'vscode-copilot-chat');
			let prompt = jobInfo?.problem_statement || 'Initial Implementation';
			const titleMatch = prompt.match(/TITLE: \s*(.*)/i);
			if (titleMatch && titleMatch[1]) {
				prompt = titleMatch[1].trim();
			} else {
				const split = prompt.split('\n');
				if (split.length > 0) {
					prompt = split[0].trim();
				}
			}
			return prompt.replace(/@copilot\s*/gi, '').trim();
		};
		if (!pr) {
			this.logService.error(`Session not found for ID: ${resource}`);
			return this.createEmptySession(resource);
		}
		const sessions = await this._octoKitService.getCopilotSessionsForPR(pr.fullDatabaseId.toString());
		const sortedSessions = sessions
			.filter((session, index, array) =>
				array.findIndex(s => s.id === session.id) === index
			)
			.slice().sort((a, b) =>
				new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
			);
		const sessionContentBuilder = new ChatSessionContentBuilder(CopilotChatSessionsProvider.TYPE, this._gitService, this._prFileChangesService);
		const history = await sessionContentBuilder.buildSessionHistory(getProblemStatement(sortedSessions), sortedSessions, pr, (sessionId: string) => this._octoKitService.getSessionLogs(sessionId));

		const selectedAgent =
			// Local cache of session -> custom agent
			this.sessionAgentMap.get(resource)
			// Query for the sub-agent that the remote reports for this session
			|| undefined; /* TODO: Needs API to support this. */

		return {
			history,
			options: selectedAgent ? { [AGENTS_OPTION_GROUP_ID]: selectedAgent } : undefined,
			activeResponseCallback: this.findActiveResponseCallback(sessions, pr),
			requestHandler: undefined
		};
	}

	async openSessionsInBrowser(chatSessionItem: vscode.ChatSessionItem): Promise<void> {
		const session = SessionIdForPr.parse(chatSessionItem.resource);
		let prNumber = session?.prNumber;
		if (typeof prNumber === 'undefined' || isNaN(prNumber)) {
			prNumber = SessionIdForPr.parsePullRequestNumber(chatSessionItem.resource);
			if (isNaN(prNumber)) {
				vscode.window.showErrorMessage(vscode.l10n.t('Invalid pull request number: {0}', chatSessionItem.resource));
				this.logService.error(`Invalid pull request number: ${chatSessionItem.resource}`);
				return;
			}
		}

		const pr = await this.findPR(prNumber);
		if (!pr) {
			vscode.window.showErrorMessage(vscode.l10n.t('Could not find pull request #{0}', prNumber));
			this.logService.error(`Could not find pull request #${prNumber}`);
			return;
		}

		const url = `https://github.com/copilot/tasks/pull/${pr.id}`;
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	private findActiveResponseCallback(
		sessions: SessionInfo[],
		pr: PullRequestSearchItem
	): ((stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Thenable<void>) | undefined {
		// Only the latest in-progress session gets activeResponseCallback
		const inProgressSession = sessions
			.slice()
			.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
			.find(session => session.state === 'in_progress');

		if (inProgressSession) {
			return this.createActiveResponseCallback(pr, inProgressSession.id);
		}
		return undefined;
	}

	private createActiveResponseCallback(pr: PullRequestSearchItem, sessionId: string): (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Thenable<void> {
		return async (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
			return this.streamSessionLogs(stream, pr, sessionId, token);
		};
	}

	private createEmptySession(resource: Uri): vscode.ChatSession {
		const sessionId = resource ? resource.path.slice(1) : undefined;
		return {
			history: [],
			...(sessionId && sessionId.startsWith('untitled-')
				? {
					options: {
						[AGENTS_OPTION_GROUP_ID]:
							this.sessionAgentMap.get(resource)
							?? (this.sessionAgentMap.set(resource, DEFAULT_AGENT_ID), DEFAULT_AGENT_ID)
					}
				}
				: {}),
			requestHandler: undefined
		};
	}

	private async findPR(prNumber: number) {
		let pr = this.chatSessions.get(prNumber);
		if (pr) {
			return pr;
		}
		const repoId = await getRepoId(this._gitService);
		if (!repoId) {
			this.logService.warn('Failed to determine GitHub repo from workspace');
			return undefined;
		}
		const pullRequests = await this._octoKitService.getCopilotPullRequestsForUser(repoId.org, repoId.repo);
		pr = pullRequests.find(pr => pr.number === prNumber);
		if (!pr) {
			this.logService.warn(`Pull request not found for number: ${prNumber}`);
			return undefined;
		}
		return pr;
	}

	private getSessionStatusFromSession(session: SessionInfo): vscode.ChatSessionStatus {
		// Map session state to ChatSessionStatus
		switch (session.state) {
			case 'failed':
				return vscode.ChatSessionStatus.Failed;
			case 'in_progress':
			case 'queued':
				return vscode.ChatSessionStatus.InProgress;
			case 'completed':
				return vscode.ChatSessionStatus.Completed;
			default:
				return vscode.ChatSessionStatus.Completed;
		}
	}

	private async startSession(stream: vscode.ChatResponseStream, token: vscode.CancellationToken, source: string, prompt: string, history?: string, references?: readonly vscode.ChatPromptReference[], customAgentName?: string) {
		/* __GDPR__
			"copilot.codingAgent.editor.invoke" : {
				"promptLength" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"historyLength" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"referencesCount" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"source" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetry.sendTelemetryEvent('copilot.codingAgent.editor.invoke', { microsoft: true, github: false }, {
			promptLength: prompt.length.toString() ?? '0',
			historyLength: history?.length.toString() ?? '0',
			referencesCount: references?.length.toString() ?? '0',
			source,
		});
		const result = await this.invokeRemoteAgent(
			prompt,
			[
				this.extractFileReferences(references),
				history
			].join('\n\n').trim(),
			token,
			false,
			stream,
			customAgentName,
		);
		if (!result) {
			return;
		}
		if (result.state !== 'success') {
			this.logService.error(`Failed to provide new chat session item: ${result.error}${result.innerError ? `\nInner Error: ${result.innerError}` : ''}`);
			stream.warning(result.error);
			return;
		}
		return result.number;
	}


	private async handleConfirmationData(request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		const results: ConfirmationResult[] = [];
		results.push(...(request.acceptedConfirmationData?.map(data => ({ step: data.step, accepted: true, metadata: data?.metadata })) ?? []));
		results.push(...((request.rejectedConfirmationData ?? []).filter(data => !results.some(r => r.step === data.step)).map(data => ({ step: data.step, accepted: false, metadata: data?.metadata }))));
		for (const data of results) {
			switch (data.step) {
				case 'create':
					{
						if (!data.accepted) {
							stream.markdown(vscode.l10n.t('Cloud agent request cancelled.'));
							return {};
						}
						await this.createDelegatedChatSession(data.metadata as CreatePromptMetadata, stream, token);
						break;
					}
				case 'uncommitted-changes':
					{
						if (!data.accepted) {
							stream.markdown(vscode.l10n.t('Cloud agent request cancelled due to uncommitted changes.'));
							return {};
						}
						const { prompt, problemContext, customAgentName } = data.metadata as UncommittedChangesMetadata;
						// Continue with the agent invocation, skipping the uncommitted changes
						const result = await this.invokeRemoteAgentWithoutChangesCheck(prompt, problemContext, undefined, true, stream, customAgentName);
						if (result && result.state !== 'success') {
							stream.warning(result.error);
							return {};
						}
						stream.markdown(vscode.l10n.t('GitHub Copilot cloud agent has begun working on your request, ignoring uncommitted changes.'));
						return {};
					}
				default:
					stream.warning(`Unknown confirmation step: ${data.step}\n\n`);
					break;
			}
		}
		return {};
	}

	async createDelegatedChatSession(metadata: CreatePromptMetadata, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<PullRequestInfo | undefined> {
		const { prompt, history, references } = metadata;
		const number = await this.startSession(stream, token, 'chat', prompt, history, references);
		if (!number) {
			return undefined;
		}
		const pullRequest = await this.findPR(number);
		if (!pullRequest) {
			stream.warning(vscode.l10n.t('Could not find the associated pull request {0} for this chat session.', number));
			return undefined;
		}

		const uri = await toOpenPullRequestWebviewUri({ owner: pullRequest.repository.owner.login, repo: pullRequest.repository.name, pullRequestNumber: pullRequest.number });
		const card = new vscode.ChatResponsePullRequestPart(uri, pullRequest.title, pullRequest.body, getAuthorDisplayName(pullRequest.author), `#${pullRequest.number}`);
		stream.push(card);
		stream.markdown(vscode.l10n.t('GitHub Copilot cloud agent has begun working on your request. Follow its progress in the associated chat and pull request.'));
		await vscode.commands.executeCommand('vscode.open', vscode.Uri.from({ scheme: CopilotChatSessionsProvider.TYPE, path: '/' + number }));
		// Return PR info for embedding in session history
		return {
			uri: uri.toString(),
			title: pullRequest.title,
			description: pullRequest.body,
			author: getAuthorDisplayName(pullRequest.author),
			linkTag: `#${pullRequest.number}`
		};
	}

	private async chatParticipantImpl(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		if (request.acceptedConfirmationData || request.rejectedConfirmationData) {
			return await this.handleConfirmationData(request, stream, token);
		}

		if (context.chatSessionContext?.isUntitled) {
			/* Generate new cloud agent session from an 'untitled' session */
			const selectedAgent = this.sessionAgentMap.get(context.chatSessionContext.chatSessionItem.resource);
			const number = await this.startSession(
				stream,
				token,
				'untitledChatSession',
				context.chatSummary?.prompt ?? request.prompt,
				context.chatSummary?.history,
				request.references,
				selectedAgent
			);
			if (!number) {
				return {};
			}
			// Tell UI to the new chat session
			this._onDidCommitChatSessionItem.fire({
				original: context.chatSessionContext.chatSessionItem,
				modified: {
					resource: vscode.Uri.from({ scheme: CopilotChatSessionsProvider.TYPE, path: '/' + number }),
					label: `Pull Request ${number}`
				}
			});
		} else if (context.chatSessionContext) {
			/* Follow up to an existing cloud agent session */
			try {
				if (token.isCancellationRequested) {
					return {};
				}

				// Validate user input
				const userPrompt = request.prompt;
				if (!userPrompt || userPrompt.trim().length === 0) {
					stream.markdown(vscode.l10n.t('Please provide a message for the cloud agent.'));
					return {};
				}

				stream.progress(vscode.l10n.t('Preparing'));
				const session = SessionIdForPr.parse(context.chatSessionContext.chatSessionItem.resource);
				let prNumber = session?.prNumber;
				if (!prNumber) {
					prNumber = SessionIdForPr.parsePullRequestNumber(context.chatSessionContext.chatSessionItem.resource);
					if (!prNumber) {
						return {};
					}
				}
				const pullRequest = await this.findPR(prNumber);
				if (!pullRequest) {
					stream.warning(vscode.l10n.t('Could not find the associated pull request {0} for this chat session.', context.chatSessionContext.chatSessionItem.resource));
					return {};
				}

				stream.progress(vscode.l10n.t('Delegating request to cloud agent'));

				const result = await this.addFollowUpToExistingPR(pullRequest.number, userPrompt);
				if (!result) {
					stream.markdown(vscode.l10n.t('Failed to add follow-up comment to the pull request.'));
					return {};
				}

				// Show initial success message
				stream.markdown(result);
				stream.markdown('\n\n');

				stream.progress(vscode.l10n.t('Attaching to session'));

				// Wait for new session and stream its progress
				const newSession = await this.waitForNewSession(pullRequest, stream, token, true);
				if (!newSession) {
					return {};
				}

				// Stream the new session logs
				stream.markdown(vscode.l10n.t('Cloud agent has begun work on your request'));
				stream.markdown('\n\n');

				await this.streamSessionLogs(stream, pullRequest, newSession.id, token);

				return {};
			} catch (error) {
				this.logService.error(`Error in request handler: ${error}`);
				stream.markdown(vscode.l10n.t('An error occurred while processing your request.'));
				return { errorDetails: { message: error.message } };
			}
		} else {
			/* @copilot invoked from a 'normal' chat or 'cloud button' */
			stream.confirmation(
				vscode.l10n.t('Delegate to cloud agent'),
				this.DELEGATE_MODAL_DETAILS,
				{
					step: 'create',
					metadata: {
						prompt: context.chatSummary?.prompt ?? request.prompt,
						history: context.chatSummary?.history,
						references: request.references,
					}
				},
				['Delegate', 'Cancel']
			);
		}
	}

	private extractFileReferences(references: readonly vscode.ChatPromptReference[] | undefined): string | undefined {
		if (!references || references.length === 0) {
			return;
		}
		// 'file:///Users/jospicer/dev/joshbot/.github/workflows/build-vsix.yml'  -> '.github/workflows/build-vsix.yml'
		const parts: string[] = [];
		for (const ref of references) {
			if (ref.value instanceof vscode.Uri && ref.value.scheme === 'file') { // TODO: Add support for more kinds of references
				const git = this._gitExtensionService.getExtensionApi();
				const repositoryForFile = git?.getRepository(ref.value);
				if (repositoryForFile) {
					const relativePath = pathLib.relative(repositoryForFile.rootUri.fsPath, ref.value.fsPath);
					parts.push(` - ${relativePath}`);
				}
			}
		}

		if (!parts.length) {
			return;
		}

		parts.unshift('The user has attached the following files as relevant context:');
		return parts.join('\n');
	}

	private async streamSessionLogs(stream: vscode.ChatResponseStream, pullRequest: PullRequestSearchItem, sessionId: string, token: vscode.CancellationToken): Promise<void> {
		let lastLogLength = 0;
		let lastProcessedLength = 0;
		let hasActiveProgress = false;
		const pollingInterval = 3000; // 3 seconds

		return new Promise<void>((resolve, reject) => {
			let isCompleted = false;

			const complete = async () => {
				if (isCompleted) {
					return;
				}
				isCompleted = true;

				this.logService.info(`Session completed, attempting to get file changes for PR #${pullRequest.number}`);
				const multiDiffPart = await this._prFileChangesService.getFileChangesMultiDiffPart(pullRequest);
				if (multiDiffPart) {
					stream.push(multiDiffPart);
				}
				resolve();
			};

			const pollForUpdates = async (): Promise<void> => {
				try {
					if (token.isCancellationRequested) {
						complete();
						return;
					}

					// Get the specific session info
					const sessionInfo = await this._octoKitService.getSessionInfo(sessionId);
					if (!sessionInfo || token.isCancellationRequested) {
						complete();
						return;
					}

					// Get session logs
					const logs = await this._octoKitService.getSessionLogs(sessionId);

					// Check if session is still in progress
					if (sessionInfo.state !== 'in_progress') {
						if (logs.length > lastProcessedLength) {
							const newLogContent = logs.slice(lastProcessedLength);
							const streamResult = await this.streamNewLogContent(pullRequest, stream, newLogContent);
							if (streamResult.hasStreamedContent) {
								hasActiveProgress = false;
							}
						}
						hasActiveProgress = false;
						complete();
						return;
					}

					if (logs.length > lastLogLength) {
						this.logService.trace(`New logs detected, attempting to stream content`);
						const newLogContent = logs.slice(lastProcessedLength);
						const streamResult = await this.streamNewLogContent(pullRequest, stream, newLogContent);
						lastProcessedLength = logs.length;

						if (streamResult.hasStreamedContent) {
							this.logService.trace(`Content was streamed, resetting hasActiveProgress to false`);
							hasActiveProgress = false;
						} else if (streamResult.hasSetupStepProgress) {
							this.logService.trace(`Setup step progress detected, keeping progress active`);
							// Keep hasActiveProgress as is, don't reset it
						} else {
							this.logService.trace(`No content was streamed, keeping hasActiveProgress as ${hasActiveProgress}`);
						}
					}

					lastLogLength = logs.length;

					if (!token.isCancellationRequested && sessionInfo.state === 'in_progress') {
						if (!hasActiveProgress) {
							this.logService.trace(`Showing progress indicator (hasActiveProgress was false)`);
							stream.progress('Working...');
							hasActiveProgress = true;
						} else {
							this.logService.trace(`NOT showing progress indicator (hasActiveProgress was true)`);
						}
						setTimeout(pollForUpdates, pollingInterval);
					} else {
						complete();
					}
				} catch (error) {
					this.logService.error(`Error polling for session updates: ${error}`);
					if (!token.isCancellationRequested) {
						setTimeout(pollForUpdates, pollingInterval);
					} else {
						reject(error);
					}
				}
			};

			// Start polling
			setTimeout(pollForUpdates, pollingInterval);
		});
	}

	private async streamNewLogContent(pullRequest: PullRequestSearchItem, stream: vscode.ChatResponseStream, newLogContent: string): Promise<{ hasStreamedContent: boolean; hasSetupStepProgress: boolean }> {
		try {
			if (!newLogContent.trim()) {
				return { hasStreamedContent: false, hasSetupStepProgress: false };
			}


			// Parse the new log content
			const contentBuilder = new ChatSessionContentBuilder(CopilotChatSessionsProvider.TYPE, this._gitService, this._prFileChangesService);

			const logChunks = contentBuilder.parseSessionLogs(newLogContent);
			let hasStreamedContent = false;
			let hasSetupStepProgress = false;

			for (const chunk of logChunks) {
				for (const choice of chunk.choices) {
					const delta = choice.delta;

					if (delta.role === 'assistant') {
						// Handle special case for run_custom_setup_step/run_setup
						if (choice.finish_reason === 'tool_calls' && delta.tool_calls?.length && (delta.tool_calls[0].function.name === 'run_custom_setup_step' || delta.tool_calls[0].function.name === 'run_setup')) {
							const toolCall = delta.tool_calls[0];
							let args: any = {};
							try {
								args = JSON.parse(toolCall.function.arguments);
							} catch {
								// fallback to empty args
							}

							if (delta.content && delta.content.trim()) {
								// Finished setup step - create/update tool part
								const toolPart = contentBuilder.createToolInvocationPart(pullRequest, toolCall, args.name || delta.content);
								if (toolPart) {
									stream.push(toolPart);
									hasStreamedContent = true;
								}
							} else {
								// Running setup step - just track progress
								hasSetupStepProgress = true;
								this.logService.trace(`Setup step in progress: ${args.name || 'Unknown step'}`);
							}
						} else {
							if (delta.content) {
								if (!delta.content.startsWith('<pr_title>')) {
									stream.markdown(delta.content);
									hasStreamedContent = true;
								}
							}

							if (delta.tool_calls) {
								for (const toolCall of delta.tool_calls) {
									const toolPart = contentBuilder.createToolInvocationPart(pullRequest, toolCall, delta.content || '');
									if (toolPart) {
										stream.push(toolPart);
										hasStreamedContent = true;
									}
								}
							}
						}
					}

					// Handle finish reasons
					if (choice.finish_reason && choice.finish_reason !== 'null') {
						this.logService.trace(`Streaming finish_reason: ${choice.finish_reason}`);
					}
				}
			}

			if (hasStreamedContent) {
				this.logService.trace(`Streamed content (markdown or tool parts), progress should be cleared`);
			} else if (hasSetupStepProgress) {
				this.logService.trace(`Setup step progress detected, keeping progress indicator`);
			} else {
				this.logService.trace(`No actual content streamed, progress may still be showing`);
			}
			return { hasStreamedContent, hasSetupStepProgress };
		} catch (error) {
			this.logService.error(`Error streaming new log content: ${error}`);
			return { hasStreamedContent: false, hasSetupStepProgress: false };
		}
	}

	private async waitForQueuedToInProgress(
		sessionId: string,
		token?: vscode.CancellationToken
	): Promise<SessionInfo | undefined> {
		let sessionInfo: SessionInfo | undefined;

		const waitForQueuedMaxRetries = 3;
		const waitForQueuedDelay = 5_000; // 5 seconds

		// Allow for a short delay before the session is marked as 'queued'
		let waitForQueuedCount = 0;
		do {
			sessionInfo = await this._octoKitService.getSessionInfo(sessionId);
			if (sessionInfo && sessionInfo.state === 'queued') {
				this.logService.trace('Queued session found');
				break;
			}
			if (waitForQueuedCount < waitForQueuedMaxRetries) {
				this.logService.trace('Session not yet queued, waiting...');
				await new Promise(resolve => setTimeout(resolve, waitForQueuedDelay));
			}
			++waitForQueuedCount;
		} while (waitForQueuedCount <= waitForQueuedMaxRetries && (!token || !token.isCancellationRequested));

		if (!sessionInfo || sessionInfo.state !== 'queued') {
			// Failure
			this.logService.trace('Failed to find queued session');
			return;
		}

		const maxWaitTime = 2 * 60 * 1_000; // 2 minutes
		const pollInterval = 3_000; // 3 seconds
		const startTime = Date.now();

		this.logService.trace(`Session ${sessionInfo.id} is queued, waiting for transition to in_progress...`);
		while (Date.now() - startTime < maxWaitTime && (!token || !token.isCancellationRequested)) {
			const sessionInfo = await this._octoKitService.getSessionInfo(sessionId);
			if (sessionInfo?.state === 'in_progress') {
				this.logService.trace(`Session ${sessionInfo.id} now in progress.`);
				return sessionInfo;
			}
			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}
	}

	private async waitForNewSession(
		pullRequest: PullRequestSearchItem,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		waitForTransitionToInProgress: boolean = false
	): Promise<SessionInfo | undefined> {
		// Get the current number of sessions
		const initialSessions = await this._octoKitService.getCopilotSessionsForPR(pullRequest.fullDatabaseId.toString());
		const initialSessionCount = initialSessions.length;

		// Poll for a new session to start
		const maxWaitTime = 5 * 60 * 1000; // 5 minutes
		const pollInterval = 3000; // 3 seconds
		const startTime = Date.now();

		while (Date.now() - startTime < maxWaitTime && !token.isCancellationRequested) {
			const currentSessions = await this._octoKitService.getCopilotSessionsForPR(pullRequest.fullDatabaseId.toString());

			// Check if a new session has started
			if (currentSessions.length > initialSessionCount) {
				const newSession = currentSessions
					.sort((a: { created_at: string | number | Date }, b: { created_at: string | number | Date }) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
				if (!waitForTransitionToInProgress) {
					return newSession;
				}
				const inProgressSession = await this.waitForQueuedToInProgress(newSession.id, token);
				if (!inProgressSession) {
					stream.markdown(vscode.l10n.t('Timed out waiting for cloud agent to begin work. Please try again shortly.'));
					return;
				}
				return inProgressSession;
			}

			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}

		stream.markdown(vscode.l10n.t('Timed out waiting for the cloud agent to respond. The agent may still be processing your request.'));
		return;
	}

	async addFollowUpToExistingPR(pullRequestNumber: number, userPrompt: string, summary?: string): Promise<string | undefined> {
		try {
			const pr = await this.findPR(pullRequestNumber);
			if (!pr) {
				this.logService.error(`Could not find pull request #${pullRequestNumber}`);
				return;
			}
			// Add a comment tagging @copilot with the user's prompt
			const commentBody = `@copilot ${userPrompt} \n\n --- \n\n ${summary ?? ''}`;

			const commentResult = await this._octoKitService.addPullRequestComment(pr.id, commentBody);
			if (!commentResult) {
				this.logService.error(`Failed to add comment to PR #${pullRequestNumber}`);
				return;
			}
			// allow-any-unicode-next-line
			return vscode.l10n.t('🚀 Follow-up comment added to [#{0}]({1})', pullRequestNumber, commentResult.url);
		} catch (err) {
			this.logService.error(`Failed to add follow-up comment to PR #${pullRequestNumber}: ${err}`);
			return;
		}
	}

	private async waitForJobWithPullRequest(
		owner: string,
		repo: string,
		jobId: string,
		token?: vscode.CancellationToken
	): Promise<JobInfo | undefined> {
		const maxWaitTime = 30 * 1000; // 30 seconds
		const pollInterval = 2000; // 2 seconds
		const startTime = Date.now();

		this.logService.trace(`Waiting for job ${jobId} to have pull request information...`);

		while (Date.now() - startTime < maxWaitTime && (!token || !token.isCancellationRequested)) {
			const jobInfo = await this._octoKitService.getJobByJobId(owner, repo, jobId, 'vscode-copilot-chat');
			if (jobInfo && jobInfo.pull_request && jobInfo.pull_request.number) {
				this.logService.trace(`Job ${jobId} now has pull request #${jobInfo.pull_request.number}`);
				return jobInfo;
			}
			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}

		this.logService.warn(`Timed out waiting for job ${jobId} to have pull request information`);
		return undefined;
	}

	async invokeRemoteAgent(prompt: string, problemContext?: string, token?: vscode.CancellationToken, autoPushAndCommit = true, chatStream?: vscode.ChatResponseStream, customAgentName?: string): Promise<RemoteAgentResult | undefined> {
		return this.invokeRemoteAgentInternal(prompt, problemContext, token, autoPushAndCommit, chatStream, customAgentName, true);
	}

	private async invokeRemoteAgentWithoutChangesCheck(prompt: string, problemContext?: string, token?: vscode.CancellationToken, autoPushAndCommit = true, chatStream?: vscode.ChatResponseStream, customAgentName?: string): Promise<RemoteAgentResult | undefined> {
		return this.invokeRemoteAgentInternal(prompt, problemContext, token, autoPushAndCommit, chatStream, customAgentName, false);
	}

	private async invokeRemoteAgentInternal(prompt: string, problemContext?: string, token?: vscode.CancellationToken, autoPushAndCommit = true, chatStream?: vscode.ChatResponseStream, customAgentName?: string, checkForChanges = true): Promise<RemoteAgentResult | undefined> {
		// TODO: support selecting remote
		// await this.promptAndUpdatePreferredGitHubRemote(true);
		const repoId = await getRepoId(this._gitService);
		if (!repoId) {
			return { error: vscode.l10n.t('Repository information is not available.'), state: 'error' };
		}
		const currentRepository = this._gitService.activeRepository.get();
		if (!currentRepository) {
			return { error: vscode.l10n.t('No active repository found.'), state: 'error' };
		}
		const git = this._gitExtensionService.getExtensionApi();
		const repo = git?.getRepository(currentRepository?.rootUri);
		// Check if user has permission to access the repository
		if (!repo) {
			return {
				error: vscode.l10n.t(
					'Unable to access {0}. Please check your permissions and try again.',
					`\`${repoId.org}/${repoId.repo}\``
				),
				state: 'error',
			};
		}

		// NOTE: This is as unobtrusive as possible with the current high-level APIs.
		// Get the current branch as base_ref (the ref the PR will merge into)
		const base_ref = repo.state.HEAD?.name;
		if (!base_ref) {
			return { error: vscode.l10n.t('Unable to determine the current branch.'), state: 'error' };
		}
		let head_ref: string | undefined; // This is the ref cloud agent starts work from (omitted unless we push local changes)

		// Check for uncommitted changes and prompt user if checking is enabled
		const hasChanges = repo.state.workingTreeChanges.length > 0 || repo.state.indexChanges.length > 0;
		if (checkForChanges && hasChanges) {
			this.logService.warn('Uncommitted changes detected, prompting user for confirmation.');
			if (chatStream) {
				chatStream.confirmation(
					vscode.l10n.t('Uncommitted changes detected'),
					vscode.l10n.t('You have uncommitted changes in your workspace. Consider committing them if you would like to include them in the cloud agent\'s work.'),
					{
						step: 'uncommitted-changes',
						metadata: {
							prompt,
							problemContext,
							customAgentName
						}
					},
					['Proceed', 'Cancel']
				);
				return;
			} else {
				// Fallback for cases where chatStream is not available
				return {
					error: vscode.l10n.t('Uncommitted changes detected. Please commit, stash, or discard your changes before delegating work to the cloud agent.'),
					state: 'error'
				};
			}
		}

		const remoteName =
			repo?.state.HEAD?.upstream?.remote ??
			currentRepository?.upstreamRemote ??
			repo?.state.remotes?.[0]?.name;

		if (repo && remoteName && base_ref) {
			try {
				const remoteBranches = await repo.getBranches({ remote: true });
				const expectedRemoteBranch = `${remoteName}/${base_ref}`;
				const alternateNames = new Set<string>([
					expectedRemoteBranch,
					`refs/remotes/${expectedRemoteBranch}`,
					base_ref
				]);
				const hasRemoteBranch = remoteBranches.some(branch => {
					if (!branch.name) {
						return false;
					}
					if (branch.remote && branch.remote !== remoteName) {
						return false;
					}
					const candidateName = branch.remote ? `${branch.remote}/${branch.name}` : branch.name;
					return alternateNames.has(candidateName);
				});

				if (!hasRemoteBranch) {
					this.logService.warn(`Base branch '${expectedRemoteBranch}' not found on remote.`);
					return {
						error: vscode.l10n.t('The branch \'{0}\' does not exist on remote \'{1}\'. Please push the branch and try again.', base_ref, remoteName),
						state: 'error'
					};
				}
			} catch (error) {
				this.logService.error(`Failed to verify remote branch for cloud agent: ${error instanceof Error ? error.message : String(error)}`);
				return {
					error: vscode.l10n.t('Unable to verify that branch \'{0}\' exists on remote \'{1}\'. Please ensure the remote branch is available and try again.', base_ref, remoteName),
					innerError: error instanceof Error ? error.message : undefined,
					state: 'error'
				};
			}
		}

		const title = extractTitle(prompt, problemContext);
		const { problemStatement, isTruncated } = truncatePrompt(this.logService, prompt, problemContext);

		if (isTruncated) {
			chatStream?.progress(vscode.l10n.t('Truncating context'));
			const truncationResult = await vscode.window.showWarningMessage(
				vscode.l10n.t('Prompt size exceeded'), { modal: true, detail: vscode.l10n.t('Your prompt will be truncated to fit within cloud agent\'s context window. This may affect the quality of the response.') }, CONTINUE_TRUNCATION);
			const userCancelled = token?.isCancellationRequested || !truncationResult || truncationResult !== CONTINUE_TRUNCATION;
			/* __GDPR__
				"copilot.codingAgent.truncation" : {
					"isCancelled" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetry.sendTelemetryEvent('copilot.codingAgent.truncation', { microsoft: true, github: false }, {
				isCancelled: String(userCancelled),
			});
			if (userCancelled) {
				return { error: vscode.l10n.t('User cancelled due to truncation.'), state: 'error' };
			}
		}

		const payload: RemoteAgentJobPayload = {
			problem_statement: problemStatement,
			event_type: 'visual_studio_code_remote_agent_tool_invoked',
			...(customAgentName && customAgentName !== DEFAULT_AGENT_ID && { custom_agent: customAgentName }),
			pull_request: {
				title,
				body_placeholder: formatBodyPlaceholder(title),
				base_ref,
				body_suffix,
				...(head_ref && { head_ref }),
			}
		};

		try {
			chatStream?.progress(vscode.l10n.t('Delegating to cloud agent'));
			this.logService.trace(`Invoking cloud agent job with payload: ${JSON.stringify(payload)}`);
			const response = await this._octoKitService.postCopilotAgentJob(repoId.org, repoId.repo, JOBS_API_VERSION, payload);

			// For v1 API, we need to fetch the job details to get the PR info
			// Since the PR might not be created immediately, we need to poll for it
			chatStream?.progress(vscode.l10n.t('Creating pull request'));
			const jobInfo = await this.waitForJobWithPullRequest(repoId.org, repoId.repo, response.job_id, token);
			if (!jobInfo || !jobInfo.pull_request) {
				return { error: vscode.l10n.t('Failed to retrieve pull request information from job'), state: 'error' };
			}

			const { number } = jobInfo.pull_request;

			// Find the actual PR to get the HTML URL
			const pullRequest = await this.findPR(number);
			if (!pullRequest) {
				return { error: vscode.l10n.t('Failed to find pull request'), state: 'error' };
			}
			const htmlUrl = pullRequest.url;

			const webviewUri = await toOpenPullRequestWebviewUri({ owner: pullRequest.repository.owner.login, repo: pullRequest.repository.name, pullRequestNumber: number });
			const prLlmString = `The remote agent has begun work and has created a pull request. Details about the pull request are being shown to the user. If the user wants to track progress or iterate on the agent's work, they should use the pull request.`;

			chatStream?.progress(vscode.l10n.t('Attaching to session'));
			await this.waitForQueuedToInProgress(response.session_id, token);
			return {
				state: 'success',
				number,
				link: htmlUrl,
				webviewUri,
				llmDetails: head_ref ? `Local pending changes have been pushed to branch '${head_ref}'. ${prLlmString}` : prLlmString,
				sessionId: response.session_id
			};
		} catch (error) {
			return { error: vscode.l10n.t('Failed delegating to cloud agent. Please try again later.'), innerError: error.message, state: 'error' };
		}
	}
}
