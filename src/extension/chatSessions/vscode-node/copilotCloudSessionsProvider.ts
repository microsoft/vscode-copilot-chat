/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import MarkdownIt from 'markdown-it';
import * as pathLib from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { IExperimentationService } from '../../../lib/node/chatLibMain';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../platform/git/common/gitService';
import { PullRequestSearchItem, SessionInfo } from '../../../platform/github/common/githubAPI';
import { IGithubRepositoryService, IOctoKitService, JobInfo, RemoteAgentJobPayload, RemoteAgentJobResponse } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { DeferredPromise, retry, RunOnceScheduler } from '../../../util/vs/base/common/async';
import { Event } from '../../../util/vs/base/common/event';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IChatDelegationSummaryService } from '../../agents/copilotcli/common/delegationSummaryService';
import { body_suffix, CONTINUE_TRUNCATION, extractTitle, formatBodyPlaceholder, getAuthorDisplayName, getRepoId, JOBS_API_VERSION, SessionIdForPr, toOpenPullRequestWebviewUri, truncatePrompt } from '../vscode/copilotCodingAgentUtils';
import { CopilotCloudGitOperationsManager } from './copilotCloudGitOperationsManager';
import { ChatSessionContentBuilder } from './copilotCloudSessionContentBuilder';
import { IPullRequestFileChangesService } from './pullRequestFileChangesService';

interface ConfirmationMetadata {
	prompt: string;
	references?: readonly vscode.ChatPromptReference[];
	chatContext: vscode.ChatContext;
}

function validateMetadata(metadata: unknown): asserts metadata is ConfirmationMetadata {
	if (typeof metadata !== 'object') {
		throw new Error('Invalid confirmation metadata: not an object.');
	}
	if (metadata === null) {
		throw new Error('Invalid confirmation metadata: null value.');
	}
	if (typeof (metadata as ConfirmationMetadata).prompt !== 'string') {
		throw new Error('Invalid confirmation metadata: missing or invalid prompt.');
	}
	if (typeof (metadata as ConfirmationMetadata).chatContext !== 'object' || (metadata as ConfirmationMetadata).chatContext === null) {
		throw new Error('Invalid confirmation metadata: missing or invalid chatContext.');
	}
}

const AGENTS_OPTION_GROUP_ID = 'agents';
const DEFAULT_AGENT_ID = '___vscode_default___';
const ACTIVE_SESSION_POLL_INTERVAL_MS = 5 * 1000; // 5 seconds
const SEEN_DELEGATION_PROMPT_KEY = 'seenDelegationPromptBefore';

/**
 * Custom renderer for markdown-it that converts markdown to plain text
 */
class PlainTextRenderer {
	private md: MarkdownIt;

	constructor() {
		this.md = new MarkdownIt();
	}

	/**
	 * Renders markdown text as plain text by extracting text content from all tokens
	 */
	render(markdown: string): string {
		const tokens = this.md.parse(markdown, {});
		return this.renderTokens(tokens).trim();
	}

	private renderTokens(tokens: MarkdownIt.Token[]): string {
		let result = '';
		for (const token of tokens) {
			// Process child tokens recursively
			if (token.children) {
				result += this.renderTokens(token.children);
			}

			// Handle different token types
			switch (token.type) {
				case 'text':
				case 'code_inline':
					// Only add content if no children were processed
					if (!token.children) {
						result += token.content;
					}
					break;

				case 'softbreak':
				case 'hardbreak':
					result += ' '; // Space instead of newline to match original
					break;

				case 'paragraph_close':
					result += '\n'; // Newline after paragraphs for separation
					break;

				case 'heading_close':
					result += '\n'; // Newline after headings
					break;

				case 'list_item_close':
					result += '\n'; // Newline after list items
					break;

				case 'fence':
				case 'code_block':
				case 'hr':
					// Skip these entirely
					break;

				// Don't add default case - only explicitly handle what we want
			}
		}
		return result;
	}
}

export class CopilotCloudSessionsProvider extends Disposable implements vscode.ChatSessionContentProvider, vscode.ChatSessionItemProvider {
	public static readonly TYPE = 'copilot-cloud-agent';
	private readonly _onDidChangeChatSessionItems = this._register(new vscode.EventEmitter<void>());
	public readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;
	private readonly _onDidCommitChatSessionItem = this._register(new vscode.EventEmitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem = this._onDidCommitChatSessionItem.event;
	private chatSessions: Map<number, PullRequestSearchItem> = new Map();
	private chatSessionItemsPromise: Promise<vscode.ChatSessionItem[]> | undefined;
	private readonly sessionAgentMap = new ResourceMap<string>();
	private readonly sessionReferencesMap = new ResourceMap<readonly vscode.ChatPromptReference[]>();
	public chatParticipant = vscode.chat.createChatParticipant(CopilotCloudSessionsProvider.TYPE, async (request, context, stream, token) => {
		await this.chatParticipantImpl(request, context, stream, token);
	});
	private cachedSessionsSize: number = 0;
	// Cache for provideChatSessionItems
	private cachedSessionItems: (vscode.ChatSessionItem & {
		fullDatabaseId: string;
		pullRequestDetails: PullRequestSearchItem;
	})[] | undefined;
	private activeSessionIds: Set<string> = new Set();
	private activeSessionPollingInterval: ReturnType<typeof setInterval> | undefined;
	private readonly plainTextRenderer = new PlainTextRenderer();
	private readonly gitOperationsManager = new CopilotCloudGitOperationsManager(this.logService, this._gitService, this._gitExtensionService);

	// Title
	private TITLE = vscode.l10n.t('Delegate to cloud agent');

	// Buttons (used for matching, be careful changing!)
	private readonly AUTHORIZE = vscode.l10n.t('Authorize');
	private readonly COMMIT = vscode.l10n.t('Commit Changes');
	private readonly PUSH_BRANCH = vscode.l10n.t('Push Branch');
	private readonly DELEGATE = vscode.l10n.t('Delegate');
	private readonly CANCEL = vscode.l10n.t('Cancel');

	// Messages
	private readonly BASE_MESSAGE = vscode.l10n.t('Cloud agent works asynchronously to create a pull request with your requested changes. This chat\'s history will be summarized and appended to the pull request as context.');
	private readonly AUTHORIZE_MESSAGE = vscode.l10n.t('Cloud agent requires elevated GitHub access to proceed.');
	private readonly COMMIT_MESSAGE = vscode.l10n.t('This workspace has uncommitted changes. Should these changes be pushed and included in cloud agent\'s work?');
	private readonly PUSH_BRANCH_MESSAGE = (baseRef: string, defaultBranch: string) => vscode.l10n.t('Push your currently checked out branch `{0}`, or start from the default branch `{1}`?', baseRef, defaultBranch);

	// Workspace storage keys
	private readonly WORKSPACE_CONTEXT_PREFIX = 'copilot.cloudAgent';

	constructor(
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@IGitService private readonly _gitService: IGitService,
		@ITelemetryService private readonly telemetry: ITelemetryService,
		@ILogService private readonly logService: ILogService,
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
		@IPullRequestFileChangesService private readonly _prFileChangesService: IPullRequestFileChangesService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IInstantiationService instantiationService: IInstantiationService,
		@IGithubRepositoryService private readonly _githubRepositoryService: IGithubRepositoryService,
		@IChatDelegationSummaryService private readonly _chatDelegationSummaryService: IChatDelegationSummaryService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
	) {
		super();

		// Background refresh
		getRepoId(this._gitService).then(async repoId => {
			const telemetryObj: {
				intervalMs?: number;
				hasHistoricalSessions?: boolean;
				error?: string;
				isEmptyWindow: boolean;
			} = {
				isEmptyWindow: !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0
			};
			if (repoId) {
				let intervalMs: number;
				let hasHistoricalSessions: boolean;
				try {
					const sessions = await this._octoKitService.getAllSessions(`${repoId.org}/${repoId.repo}`, false, { createIfNone: false });
					hasHistoricalSessions = sessions.length > 0;
					intervalMs = this.getRefreshIntervalTime(hasHistoricalSessions);
				} catch (e) {
					this.logService.error(`Error during background refresh setup: ${e instanceof Error ? e.message : String(e)}`);
					hasHistoricalSessions = false;
					intervalMs = this.getRefreshIntervalTime(hasHistoricalSessions);
					telemetryObj.error = e instanceof Error ? e.message : String(e);
				}
				telemetryObj.intervalMs = intervalMs;
				telemetryObj.hasHistoricalSessions = hasHistoricalSessions;
				const schedulerCallback = async () => {
					let sessions = [];
					try {
						sessions = await this._octoKitService.getAllSessions(`${repoId.org}/${repoId.repo}`, true, { createIfNone: false });
						if (this.cachedSessionsSize !== sessions.length) {
							this.refresh();
						}
					} catch (e) {
						logService.error(`Error during background refresh: ${e}`);
					}
					scheduler.schedule();
				};
				let lastRefreshedAt = 0;
				const scheduler = this._register(new RunOnceScheduler(() => {
					lastRefreshedAt = Date.now();
					schedulerCallback();
				}, intervalMs));
				scheduler.schedule();
				this._register(vscode.window.onDidChangeWindowState((e) => {
					if (!e.active) {
						scheduler.cancel();
					} else if (!scheduler.isScheduled()) {
						scheduler.schedule(Math.max(0, intervalMs - (Date.now() - lastRefreshedAt)));
					}
				}));

			}
			const onDebouncedAuthRefresh = Event.debounce(this._authenticationService.onDidAuthenticationChange, () => { }, 500);
			this._register(onDebouncedAuthRefresh(() => this.refresh()));
			this.telemetry.sendTelemetryEvent('copilotCloudSessions.refreshInterval', { microsoft: true, github: false }, telemetryObj);
		});
	}

	private getRefreshIntervalTime(hasHistoricalSessions: boolean): number {
		// Check for experiment overrides
		const expRefreshInterval = this._experimentationService.getTreatmentVariable<number>('copilotCloudSessions.refreshInterval');
		if (expRefreshInterval !== undefined) {
			return expRefreshInterval;
		}

		// Default intervals
		const fiveMinInterval = 5 * 60 * 1000; // 5 minutes
		const tenMinInterval = 10 * 60 * 1000; // 10 minutes
		if (hasHistoricalSessions) {
			return fiveMinInterval;
		} else {
			return tenMinInterval;
		}
	}

	public refresh(): void {
		this.cachedSessionItems = undefined;
		this.activeSessionIds.clear();
		this.stopActiveSessionPolling();
		this._onDidChangeChatSessionItems.fire();
	}

	private stopActiveSessionPolling(): void {
		if (this.activeSessionPollingInterval) {
			clearInterval(this.activeSessionPollingInterval);
			this.activeSessionPollingInterval = undefined;
		}
	}

	private startActiveSessionPolling(): void {
		// Don't start if already polling
		if (this.activeSessionPollingInterval) {
			return;
		}

		this.activeSessionPollingInterval = setInterval(async () => {
			await this.updateActiveSessionsOnly();
		}, ACTIVE_SESSION_POLL_INTERVAL_MS);

		// Register for disposal
		this._register(toDisposable(() => this.stopActiveSessionPolling()));
	}

	private async updateActiveSessionsOnly(): Promise<void> {
		if (this.activeSessionIds.size === 0) {
			this.stopActiveSessionPolling();
			return;
		}

		try {
			// Fetch only the active sessions using allSettled to handle individual failures
			const sessionResults = await Promise.allSettled(
				Array.from(this.activeSessionIds).map(sessionId =>
					this._octoKitService.getSessionInfo(sessionId, { createIfNone: true })
				)
			);

			const stillActiveSessions = new Set<string>();

			for (const result of sessionResults) {
				if (result.status === 'rejected') {
					this.logService.warn(`Failed to fetch session info: ${result.reason}`);
					continue;
				}

				const session = result.value;
				if (!session) {
					continue;
				}
				this.cachedSessionItems = this.cachedSessionItems?.map(item => {
					if (item.fullDatabaseId === session.resource_global_id) {
						return {
							...item,
							status: this.getSessionStatusFromSession(session),
						};
					}
					return item;
				});

				if (session.state === 'in_progress' || session.state === 'queued') {
					stillActiveSessions.add(session.id);
				}
			}

			// Update the active sessions set
			this.activeSessionIds = stillActiveSessions;

			// If there are changes or no more active sessions, invalidate cache and notify
			if (this.activeSessionIds.size === 0) {
				this.cachedSessionItems = undefined;
				this.stopActiveSessionPolling();
			}
			this._onDidChangeChatSessionItems.fire();
		} catch (error) {
			this.logService.error(`Error updating active sessions: ${error}`);
		}
	}

	async provideChatSessionProviderOptions(token: vscode.CancellationToken): Promise<vscode.ChatSessionProviderOptions> {
		this.logService.trace('copilotCloudSessionsProvider#provideChatSessionProviderOptions Start');
		const repoId = await getRepoId(this._gitService);
		if (!repoId) {
			this.logService.trace('copilotCloudSessionsProvider#provideChatSessionProviderOptions No Repo Id');
			return { optionGroups: [] };
		}

		// TODO: handle no auth token case more gracefully
		if (!this._authenticationService.permissiveGitHubSession) {
			this.logService.trace('[copilotCloudSessionsProvider#provideChatSessionProviderOptions] No Auth Token');
			return { optionGroups: [] };
		}
		try {
			const customAgents = await this._octoKitService.getCustomAgents(repoId.org, repoId.repo, { excludeInvalidConfig: true }, { createIfNone: true });
			if (customAgents.length === 0) {
				this.logService.trace('[copilotCloudSessionsProvider#provideChatSessionProviderOptions] No Custom Agents');
				return { optionGroups: [] };
			}

			this.logService.trace(`[copilotCloudSessionsProvider#provideChatSessionProviderOptions] ${JSON.stringify(customAgents, undefined, 2)}`);

			const agentItems: vscode.ChatSessionProviderOptionItem[] = [
				{ id: DEFAULT_AGENT_ID, name: vscode.l10n.t('Agent') },
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
			this.logService.error(`[copilotCloudSessionsProvider#provideChatSessionProviderOptions] Error fetching custom agents: ${error}`);
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
		// Return cached items if available
		if (this.cachedSessionItems) {
			return this.cachedSessionItems;
		}

		if (this.chatSessionItemsPromise) {
			return this.chatSessionItemsPromise;
		}
		this.chatSessionItemsPromise = (async () => {
			const repoId = await getRepoId(this._gitService);

			// Make sure if it's not a github repo we don't show any sessions
			if (!repoId && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
				return [];
			}
			const sessions = await this._octoKitService.getAllSessions(repoId ? `${repoId.org}/${repoId.repo}` : undefined, true, { createIfNone: false });
			this.cachedSessionsSize = sessions.length;

			// Group sessions by resource_id and keep only the latest per resource_id
			const latestSessionsMap = new Map<number, SessionInfo>();
			for (const session of sessions) {
				const existing = latestSessionsMap.get(session.resource_id);
				if (!existing || this.shouldPushSession(session, existing)) {
					latestSessionsMap.set(session.resource_id, session);
				}
			}

			// Track active sessions for background polling
			const newActiveSessionIds = new Set<string>();
			for (const session of latestSessionsMap.values()) {
				if (session.state === 'in_progress' || session.state === 'queued') {
					newActiveSessionIds.add(session.id);
				}
			}

			// Update active sessions and start polling if needed
			this.activeSessionIds = newActiveSessionIds;
			if (this.activeSessionIds.size > 0) {
				this.startActiveSessionPolling();
			} else {
				this.stopActiveSessionPolling();
			}

			// Fetch PRs for all unique resource_global_ids in parallel
			const uniqueGlobalIds = new Set(Array.from(latestSessionsMap.values()).map(s => s.resource_global_id));
			const prFetches = Array.from(uniqueGlobalIds).map(async globalId => {
				const pr = await this._octoKitService.getPullRequestFromGlobalId(globalId, { createIfNone: false });
				return { globalId, pr };
			});
			const prResults = await Promise.all(prFetches);
			const prMap = new Map(prResults.filter(r => r.pr).map(r => [r.globalId, r.pr!]));

			const validateISOTimestamp = (date: string | undefined): number | undefined => {
				try {
					if (!date) {
						return;
					}
					const time = new Date(date)?.getTime();
					if (time > 0) {
						return time;
					}
				} catch { }
			};

			const createdAt = sessions.length > 0 ? validateISOTimestamp(sessions[0].created_at) : undefined;

			// Create session items from latest sessions
			const sessionItems = await Promise.all(Array.from(latestSessionsMap.values()).map(async sessionItem => {
				const pr = prMap.get(sessionItem.resource_global_id);
				if (!pr) {
					return undefined;
				}

				const session = {
					resource: vscode.Uri.from({ scheme: CopilotCloudSessionsProvider.TYPE, path: '/' + pr.number }),
					label: pr.title,
					status: this.getSessionStatusFromSession(sessionItem),
					badge: this.getPullRequestBadge(pr),
					tooltip: this.createPullRequestTooltip(pr),
					...(createdAt ? {
						timing: {
							startTime: createdAt,
							endTime: validateISOTimestamp(sessionItem.completed_at),
						}
					} : {}),
					changes: {
						files: pr.files.totalCount,
						insertions: pr.additions,
						deletions: pr.deletions
					},
					fullDatabaseId: pr.fullDatabaseId.toString(),
					pullRequestDetails: pr,
				} satisfies vscode.ChatSessionItem & {
					fullDatabaseId: string;
					pullRequestDetails: PullRequestSearchItem;
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

			// Cache the results
			this.cachedSessionItems = filteredSessions;

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
		const summaryReference = new DeferredPromise<vscode.ChatPromptReference | undefined>();
		const getProblemStatement = async (sessions: SessionInfo[]) => {
			if (sessions.length === 0) {
				summaryReference.complete(undefined);
				return undefined;
			}
			const repoId = await getRepoId(this._gitService);
			if (!repoId) {
				summaryReference.complete(undefined);
				return undefined;
			}
			const jobInfo = await this._octoKitService.getJobBySessionId(repoId.org, repoId.repo, sessions[0].id, 'vscode-copilot-chat', { createIfNone: true });
			let prompt = jobInfo?.problem_statement || 'Initial Implementation';
			// When delegating, we append the summary to the prompt, & that can be very large and doesn't look great.
			// Turn the summary into a reference instead.
			const info = this._chatDelegationSummaryService.extractPrompt(sessions[0].id, prompt);
			if (info) {
				summaryReference.complete(info.reference);
				prompt = info.prompt;
			} else {
				summaryReference.complete(undefined);
			}
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
		const sessions = await this._octoKitService.getCopilotSessionsForPR(pr.fullDatabaseId.toString(), { createIfNone: true });
		const sortedSessions = sessions
			.filter((session, index, array) =>
				array.findIndex(s => s.id === session.id) === index
			)
			.slice().sort((a, b) =>
				new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
			);

		// Get stored references for this session
		const storedReferences = summaryReference.p.then(summaryRef => {
			return (this.sessionReferencesMap.get(resource) ?? []).concat(summaryRef ? [summaryRef] : []);
		});

		const sessionContentBuilder = new ChatSessionContentBuilder(CopilotCloudSessionsProvider.TYPE, this._gitService, this._prFileChangesService);
		const history = await sessionContentBuilder.buildSessionHistory(getProblemStatement(sortedSessions), sortedSessions, pr, (sessionId: string) => this._octoKitService.getSessionLogs(sessionId, { createIfNone: true }), storedReferences);

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

	async openChanges(chatSessionItemResource: vscode.Uri): Promise<void> {
		const session = SessionIdForPr.parse(chatSessionItemResource);
		let prNumber = session?.prNumber;
		if (typeof prNumber === 'undefined' || isNaN(prNumber)) {
			prNumber = SessionIdForPr.parsePullRequestNumber(chatSessionItemResource);
			if (isNaN(prNumber)) {
				vscode.window.showErrorMessage(vscode.l10n.t('Could not parse PR number from session resource'));
				this.logService.error(`Could not parse PR number from session resource: ${chatSessionItemResource}`);
				return;
			}
		}

		const pr = await this.findPR(prNumber);
		if (!pr) {
			vscode.window.showErrorMessage(vscode.l10n.t('Could not find pull request #{0}', prNumber));
			this.logService.error(`Could not find pull request #${prNumber}`);
			return;
		}

		const multiDiffPart = await this._prFileChangesService.getFileChangesMultiDiffPart(pr);
		if (!multiDiffPart) {
			vscode.window.showWarningMessage(vscode.l10n.t('No file changes found for pull request #{0}', prNumber));
			this.logService.warn(`No file changes found for PR #${prNumber}`);
			return;
		}

		await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
			multiDiffSourceUri: vscode.Uri.parse(`copilotcloud-pr-changes:/${prNumber}`),
			title: vscode.l10n.t('Pull Request #{0}', prNumber),
			resources: multiDiffPart.value
		});
	}

	private findActiveResponseCallback(
		sessions: SessionInfo[],
		pr: PullRequestSearchItem
	): ((stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Thenable<void>) | undefined {
		// Only the latest in-progress session gets activeResponseCallback
		const pendingSession = sessions
			.slice()
			.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
			.find(session => session.state === 'in_progress' || session.state === 'queued');

		if (pendingSession) {
			return this.createActiveResponseCallback(pr, pendingSession.id);
		}
		return undefined;
	}

	private createActiveResponseCallback(pr: PullRequestSearchItem, sessionId: string): (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Thenable<void> {
		return async (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
			await this.waitForQueuedToInProgress(sessionId, token);
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

	private async findPR(prNumber: number, retries: number = 1) {
		let pr = this.chatSessions.get(prNumber);
		if (pr) {
			return pr;
		}
		const repoId = await getRepoId(this._gitService);
		if (!repoId) {
			this.logService.warn('Failed to determine GitHub repo from workspace');
			return undefined;
		}
		try {
			pr = await retry(async () => {
				const pullRequests = await this._octoKitService.getCopilotPullRequestsForUser(repoId.org, repoId.repo, { createIfNone: true });
				const found = pullRequests.find(p => p.number === prNumber);
				if (!found) {
					this.logService.warn(`Pull request ${prNumber} is not visible yet, retrying...`);
					throw new Error(`PR ${prNumber} not yet visible`);
				}
				return found;
			}, 1500, retries);
			if (pr) {
				this.chatSessions.set(pr.number, pr);
			}
			return pr;
		} catch (error) {
			this.logService.warn(`Pull request not found for number: ${prNumber}. ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
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

	private getPullRequestBadge(pr: PullRequestSearchItem): vscode.MarkdownString {
		let badgeText: string;
		switch (pr.state) {
			case 'failed':
				badgeText = vscode.l10n.t('$(git-pull-request) Failed in {0}', `#${pr.number}`);
				break;
			case 'in_progress':
				badgeText = vscode.l10n.t('$(git-pull-request) Running in {0}', `#${pr.number}`);
				break;
			case 'queued':
				badgeText = vscode.l10n.t('$(git-pull-request) Queued in {0}', `#${pr.number}`);
				break;
			default:
				badgeText = vscode.l10n.t('$(git-pull-request) {0}', `#${pr.number}`);
				break;
		}

		const badge = new vscode.MarkdownString(badgeText);
		badge.supportThemeIcons = true;
		return badge;
	}

	private createPullRequestTooltip(pr: PullRequestSearchItem): vscode.MarkdownString {
		const markdown = new vscode.MarkdownString(undefined, true);
		markdown.supportHtml = true;

		// Repository and date
		const date = new Date(pr.createdAt);
		const ownerName = `${pr.repository.owner.login}/${pr.repository.name}`;
		markdown.appendMarkdown(
			`[${ownerName}](https://github.com/${ownerName}) on ${date.toLocaleString('default', {
				day: 'numeric',
				month: 'short',
				year: 'numeric',
			})}  \n`
		);

		// Icon, title, and PR number
		const icon = this.getIconMarkdown(pr);
		// Strip markdown from title for plain text display
		const title = this.plainTextRenderer.render(pr.title);
		markdown.appendMarkdown(
			`${icon} **${title}** [#${pr.number}](${pr.url})  \n`
		);

		// Body/Description (truncated if too long)
		markdown.appendMarkdown('  \n');
		const maxBodyLength = 200;
		let body = this.plainTextRenderer.render(pr.body || '');
		// Convert plain text newlines to markdown line breaks (two spaces + newline)
		body = body.replace(/\n/g, '  \n');
		body = body.length > maxBodyLength ? body.substring(0, maxBodyLength) + '...' : body;
		markdown.appendMarkdown(body + '  \n');

		return markdown;
	}

	private getIconMarkdown(pr: PullRequestSearchItem): string {
		const state = pr.state.toUpperCase();
		return state === 'MERGED' ? '$(git-merge)' : '$(git-pull-request)';
	}

	private hasHistoryToSummarize(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): boolean {
		if (!history || history.length === 0) {
			return false;
		}
		const allResponsesEmpty = history.every(turn => {
			if (turn instanceof vscode.ChatResponseTurn) {
				return turn.response.length === 0;
			}
			return true;
		});
		return !allResponsesEmpty;
	}

	async delegate(
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		context: vscode.ChatContext,
		token: vscode.CancellationToken,
		metadata: ConfirmationMetadata,
		base_ref?: string,
		head_ref?: string
	): Promise<{ uri: vscode.Uri; title: string; description: string; author: string; linkTag: string }> {

		let history: string | undefined;

		// TODO: Do this async/optimistically before delegation triggered
		if (this.hasHistoryToSummarize(context.history)) {
			stream.progress(vscode.l10n.t('Analyzing chat history'));
			history = await this._chatDelegationSummaryService.summarize(context, token);
		}

		let customAgentName: string | undefined;
		if (metadata.chatContext.chatSessionContext?.chatSessionItem?.resource) {
			customAgentName = this.sessionAgentMap.get(metadata.chatContext.chatSessionContext.chatSessionItem.resource);
			if (customAgentName) {
				this.logService.debug(`Using custom agent '${customAgentName}' for session ${metadata.chatContext.chatSessionContext.chatSessionItem.resource}`);
			}
		}

		const { result, processedReferences } = await this.extractReferences(metadata.references, !!head_ref);

		if (!base_ref) {
			const repoId = await getRepoId(this._gitService);
			if (!repoId) {
				throw new Error(vscode.l10n.t('Open a GitHub repository to use the cloud agent.'));
			}
			const { default_branch } = await this._githubRepositoryService.getRepositoryInfo(repoId.org, repoId.repo);
			base_ref = default_branch;
		}

		const { number, sessionId } = await this.invokeRemoteAgent(
			metadata.prompt,
			[result, history].filter(Boolean).join('\n\n').trim(),
			token,
			stream,
			base_ref,
			customAgentName,
			head_ref,
		);
		if (history) {
			void this._chatDelegationSummaryService.trackSummaryUsage(sessionId, history);
		}
		this.logService.debug(`Delegated to cloud agent for PR #${number} with session ID ${sessionId}`);

		// Store references for this session
		const sessionUri = vscode.Uri.from({ scheme: CopilotCloudSessionsProvider.TYPE, path: '/' + number });

		// Cache the processed references for presentation later
		if (processedReferences.length > 0) {
			this.sessionReferencesMap.set(sessionUri, processedReferences);
		}

		stream.progress(vscode.l10n.t('Fetching pull request details'));
		const pullRequest = await this.findPR(number, 5);
		if (!pullRequest) {
			throw new Error(`Failed to find pull request #${number} after delegation.`);
		}
		const uri = await toOpenPullRequestWebviewUri({ owner: pullRequest.repository.owner.login, repo: pullRequest.repository.name, pullRequestNumber: pullRequest.number });

		if (metadata.chatContext.chatSessionContext?.isUntitled) {
			// Untitled flow
			this._onDidCommitChatSessionItem.fire({
				original: metadata.chatContext.chatSessionContext.chatSessionItem,
				modified: {
					resource: sessionUri,
					label: `Pull Request ${number}`
				}
			});
		} else {
			// Delegated flow
			// NOTE: VS Code will now close the parent/source chat in most cases.
			stream.markdown(vscode.l10n.t('A cloud agent has begun working on your request. Follow its progress in the sessions list and associated pull request.'));
		}

		// Return this for external callers, eg: CLI
		return {
			uri, // PR uri
			title: pullRequest.title,
			description: pullRequest.body || '',
			author: getAuthorDisplayName(pullRequest.author),
			linkTag: `#${pullRequest.number}`
		};
	}

	private async handleConfirmationData(request: vscode.ChatRequest, stream: vscode.ChatResponseStream, context: vscode.ChatContext, token: vscode.CancellationToken) {
		if (!request.prompt || request.prompt.indexOf(':') === -1) {
			this.logService.error('Invalid confirmation prompt format.');
			return {};
		}

		// Parse out the button selected by the user
		const selection = (request.prompt?.split(':')[0] || '').trim().toUpperCase();
		const metadata: unknown = request.acceptedConfirmationData?.[0]?.metadata || request.rejectedConfirmationData?.[0]?.metadata;
		try {
			validateMetadata(metadata);
		} catch (error) {
			this.logService.error(`Invalid confirmation metadata: ${error}`);
			return {};
		}

		// -- Process each button press in order of precedence

		if (!selection || selection === this.CANCEL.toUpperCase() || token.isCancellationRequested) {
			stream.markdown(vscode.l10n.t('Cloud agent cancelled'));
			return {};
		}

		if (selection.includes(this.AUTHORIZE.toUpperCase())) {
			stream.progress(vscode.l10n.t('Authorizing'));
			try {
				await this._authenticationService.getGitHubSession('permissive', { createIfNone: true });
				if (!this._authenticationService.permissiveGitHubSession) {
					throw new Error('Failed to obtain permissive GitHub session');
				}
			} catch (error) {
				this.logService.error(`Authorization failed: ${error}`);
				throw new Error(vscode.l10n.t('Authorization failed. Please sign into GitHub and try again.'));

			}
		}

		let head_ref: string | undefined; // If set, this is the branch we pushed pending changes to.

		if (selection.includes(this.COMMIT.toUpperCase())) {
			try {
				stream.progress(vscode.l10n.t('Committing and pushing local changes'));
				head_ref = await this.gitOperationsManager.commitAndPushChanges();
				stream.markdown(vscode.l10n.t('Local changes pushed to remote branch `{0}`.', head_ref));
			} catch (error) {
				this.logService.error(`Commit and push failed: ${error}`);
				throw vscode.l10n.t('{0}. Commit or stash your changes and try again.', (error instanceof Error ? error.message : String(error)) ?? vscode.l10n.t('Failed to commit and push changes.'));
			}
		} else if (selection.includes(this.PUSH_BRANCH.toUpperCase())) {
			try {
				stream.progress(vscode.l10n.t('Pushing base branch to remote'));
				const baseBranch = await this.gitOperationsManager.pushBaseRefToRemote();
				stream.markdown(vscode.l10n.t('Base branch `{0}` pushed to remote.', baseBranch));
			} catch (error) {
				this.logService.error(`Push branch failed: ${error}`);
				throw vscode.l10n.t('{0}. Push the current branch to remote and try again.', (error instanceof Error ? error.message : String(error)) ?? vscode.l10n.t('Failed to push current branch.'));
			}
		}

		const base_ref: string = await (async () => {
			const res = await this.checkBaseBranchPresentOnRemote();
			if (!res) {
				// Unexpected
				throw new Error(vscode.l10n.t('Repo base branch is not detected on remote. Push your branch and try again.'));
			}
			return (res?.missingOnRemote || !res?.baseRef) ? res.repoDefaultBranch : res?.baseRef;
		})();
		stream.progress(vscode.l10n.t('Validating branch `{0}` exists on remote', base_ref));

		// Now trigger delegation
		try {
			await this.delegate(request, stream, context, token, metadata, base_ref, head_ref);
		} catch (error) {
			this.logService.error(`Failure in delegation: ${error}`);
			throw new Error(vscode.l10n.t('{0}', (error instanceof Error ? error.message : String(error))));
		}
	}

	private setWorkspaceContext(key: string, value: string) {
		this._extensionContext.workspaceState.update(`${this.WORKSPACE_CONTEXT_PREFIX}.${key}`, value);
	}

	private getWorkspaceContext(key: string): string | undefined {
		return this._extensionContext.workspaceState.get<string>(`${this.WORKSPACE_CONTEXT_PREFIX}.${key}`);
	}

	resetWorkspaceContext() {
		const keys =
			this._extensionContext.workspaceState.keys()
				.filter(key => key.startsWith(this.WORKSPACE_CONTEXT_PREFIX));
		for (const key of keys) {
			this.logService.debug(`[resetWorkspaceContext] ${key}`);
			this._extensionContext.workspaceState.update(key, undefined);
		}
	}

	private async detectedUncommittedChanges(): Promise<boolean> {
		const currentRepository = this._gitService.activeRepository?.get();
		if (!currentRepository) {
			return false;
		}
		const git = this._gitExtensionService.getExtensionApi();
		const repo = git?.getRepository(currentRepository?.rootUri);
		if (!repo) {
			return false;
		}
		return repo.state.workingTreeChanges.length > 0 || repo.state.indexChanges.length > 0;
	}

	/**
	 * Checks if the current base branch exists on the remote repository.
	 * Returns branch information including whether it's missing from remote, the base ref name, and the repository's default branch.
	 */
	private async checkBaseBranchPresentOnRemote(): Promise<{ missingOnRemote: boolean; baseRef: string; repoDefaultBranch: string } | undefined> {
		try {
			const repoId = await getRepoId(this._gitService);
			if (!repoId) {
				return undefined;
			}
			const { baseRef, repository, remoteName } = await this.gitOperationsManager.repoInfo();
			const remoteRepoInfo = await this._githubRepositoryService.getRepositoryInfo(repoId.org, repoId.repo);
			const remoteHasRef = await this.gitOperationsManager.checkIfRemoteHasRef(repository, remoteName, baseRef);
			if (remoteHasRef) {
				// Remote HAS the base branch, no action needed.
				return { missingOnRemote: false, baseRef, repoDefaultBranch: remoteRepoInfo.default_branch };
			}
			// Remote is MISSING the base branch
			return { missingOnRemote: true, baseRef, repoDefaultBranch: remoteRepoInfo.default_branch };
		} catch (error) {
			this.logService.debug(`Failed to check default branch: ${error}`);
			return undefined;
		}
	}

	/**
	 * Returns either all the data for a confirmation dialog, or undefined if no confirmation is needed.
	 * */
	private async buildConfirmation(context: vscode.ChatContext): Promise<{ title: string; message: string; buttons: string[] } | undefined> {
		const title: string = this.TITLE;
		const buttons: string[] = [this.CANCEL];
		let message: string = this.BASE_MESSAGE;

		const needsPermissiveAuth = !this._authenticationService.permissiveGitHubSession;
		const hasUncommittedChanges = await this.detectedUncommittedChanges();
		const baseBranchInfo = await this.checkBaseBranchPresentOnRemote();

		if (needsPermissiveAuth && hasUncommittedChanges) {
			message += '\n\n' + this.AUTHORIZE_MESSAGE;
			message += '\n\n' + this.COMMIT_MESSAGE;
			buttons.unshift(
				vscode.l10n.t('{0} and {1}', this.AUTHORIZE, this.COMMIT),
				this.AUTHORIZE,
			);
		} else if (needsPermissiveAuth && baseBranchInfo?.missingOnRemote) {
			const { baseRef, repoDefaultBranch } = baseBranchInfo;
			message += '\n\n' + this.AUTHORIZE_MESSAGE;
			message += '\n\n' + this.PUSH_BRANCH_MESSAGE(baseRef, repoDefaultBranch);
			buttons.unshift(
				vscode.l10n.t('{0} and {1}', this.AUTHORIZE, this.PUSH_BRANCH),
				this.AUTHORIZE,
			);
		} else if (needsPermissiveAuth) {
			message += '\n\n' + this.AUTHORIZE_MESSAGE;
			buttons.unshift(
				this.AUTHORIZE,
			);
		} else if (hasUncommittedChanges) {
			message += '\n\n' + this.COMMIT_MESSAGE;
			buttons.unshift(
				vscode.l10n.t('{0} and {1}', this.COMMIT, this.DELEGATE),
				this.DELEGATE,
			);
		} else if (baseBranchInfo?.missingOnRemote) {
			const { baseRef, repoDefaultBranch } = baseBranchInfo;
			message += '\n\n' + this.PUSH_BRANCH_MESSAGE(baseRef, repoDefaultBranch);
			buttons.unshift(
				vscode.l10n.t('{0} and {1}', this.PUSH_BRANCH, this.DELEGATE),
				this.DELEGATE,
			);
		}

		// Check if the message has been modified from the default
		const messageModified = message !== this.BASE_MESSAGE;

		// Only skip confirmation if neither buttons were modified nor message was modified
		if (buttons.length === 1 && !messageModified) {
			if (context.chatSessionContext?.isUntitled) {
				return; // Don't show the confirmation
			}
			const seenDelegationPromptBefore = this.getWorkspaceContext(SEEN_DELEGATION_PROMPT_KEY);
			if (seenDelegationPromptBefore) {
				return; // Don't show the confirmation
			}
		}

		if (buttons.length === 1) {
			// No other affirmative button added, so add generic one
			buttons.unshift(this.DELEGATE);
		}

		return { title, message, buttons };
	}

	private async chatParticipantImpl(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		if (token.isCancellationRequested) {
			stream.warning(vscode.l10n.t('Cloud session cancelled.'));
			return {};
		}

		if (request.acceptedConfirmationData || request.rejectedConfirmationData) {
			await this.handleConfirmationData(request, stream, context, token);
			this.setWorkspaceContext(SEEN_DELEGATION_PROMPT_KEY, 'yes');
			return {};
		}

		/* __GDPR__
			"copilotcloud.chat.invoke" : {
				"owner": "joshspicer",
				"comment": "Event sent when a Copilot Cloud chat request is made.",
				"hasChatSessionItem": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Invoked with a chat session item." },
				"isUntitled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Indicates if the chat session is untitled." }
			}
		*/
		this.telemetry.sendMSFTTelemetryEvent('copilotcloud.chat.invoke', {
			hasChatSessionItem: String(!!context.chatSessionContext?.chatSessionItem),
			isUntitled: String(context.chatSessionContext?.isUntitled)
		});

		// Follow up
		if (context.chatSessionContext && !context.chatSessionContext.isUntitled) {
			await this.handleFollowUp(request, context, stream, token);
			return {};
		}

		// New request
		const showConfirmation = await this.buildConfirmation(context);
		if (showConfirmation) {
			const { title, message, buttons } = showConfirmation;
			stream.confirmation(
				title,
				message,
				{
					metadata: {
						prompt: request.prompt,
						references: request.references,
						chatContext: context,
					} satisfies ConfirmationMetadata
				},
				buttons
			);
		} else {
			// No confirmation
			await this.delegate(
				request,
				stream,
				context,
				token,
				{
					prompt: request.prompt,
					references: request.references,
					chatContext: context
				} satisfies ConfirmationMetadata,
			);
		}
	}

	private async handleFollowUp(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		if (!context.chatSessionContext || context.chatSessionContext.isUntitled) {
			return {};
		}
		const { prompt } = request;
		if (!prompt || prompt.trim().length === 0) {
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

		stream.progress(vscode.l10n.t('Delegating'));

		const result = await this.addFollowUpToExistingPR(pullRequest.number, prompt);
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
	}

	/**
	 * Processes *supported* references, returning an LLM-friendly string representation and the filtered list of those references that were processed.
	 */
	private async extractReferences(references: readonly vscode.ChatPromptReference[] | undefined, pushedInProgressBranch: boolean): Promise<{ result: string; processedReferences: readonly vscode.ChatPromptReference[] }> {
		// 'file:///Users/jospicer/dev/joshbot/.github/workflows/build-vsix.yml'  -> '.github/workflows/build-vsix.yml'
		const fileRefs: string[] = [];
		const fullFileParts: string[] = [];
		const processedReferences: vscode.ChatPromptReference[] = [];
		const git = this._gitExtensionService.getExtensionApi();
		for (const ref of references || []) {
			if (ref.value instanceof vscode.Uri && ref.value.scheme === 'file') {
				const fileUri = ref.value;
				const repositoryForFile = git?.getRepository(fileUri);
				if (repositoryForFile) {
					const relativePath = pathLib.relative(repositoryForFile.rootUri.fsPath, fileUri.fsPath);
					const isInWorkingTree = repositoryForFile.state.workingTreeChanges.some(change => change.uri.fsPath === fileUri.fsPath);
					const isInIndex = repositoryForFile.state.indexChanges.some(change => change.uri.fsPath === fileUri.fsPath);
					if (!pushedInProgressBranch && (isInWorkingTree || isInIndex)) {
						try {
							// Show only the file diffs for modified files
							let diff: string;
							if (isInIndex) {
								diff = await repositoryForFile.diffIndexWithHEAD(fileUri.fsPath);
							} else {
								diff = await repositoryForFile.diffWithHEAD(fileUri.fsPath);
							}

							if (diff && diff.trim()) {
								fullFileParts.push(`<file-diff-start>${relativePath}</file-diff-start>`);
								fullFileParts.push(diff);
								fullFileParts.push(`<file-diff-end>${relativePath}</file-diff-end>`);
							} else {
								// If diff is empty, fall back to file reference
								fileRefs.push(` - ${relativePath}`);
							}
							processedReferences.push(ref);
						} catch (error) {
							this.logService.error(`Error reading file diff for reference: ${fileUri.toString()}: ${error}`);
						}
					} else {
						fileRefs.push(` - ${relativePath}`);
						processedReferences.push(ref);
					}
				}
			} else if (ref.value instanceof vscode.Uri && ref.value.scheme === 'untitled') {
				// Get full content of untitled file
				try {
					const document = await vscode.workspace.openTextDocument(ref.value);
					const content = document.getText();
					fullFileParts.push(`<file-start>${ref.value.path}</file-start>`);
					fullFileParts.push(content);
					fullFileParts.push(`<file-end>${ref.value.path}</file-end>`);
					processedReferences.push(ref);
				} catch (error) {
					this.logService.error(`Error reading untitled file content for reference: ${ref.value.toString()}: ${error}`);
				}
			}
		}

		const parts: string[] = [
			...(fullFileParts.length ? ['The user has attached the following uncommitted or modified files as relevant context:', ...fullFileParts] : []),
			...(fileRefs.length ? ['The user has attached the following file paths as relevant context:', ...fileRefs] : [])
		];

		this.logService.debug(`Cloud agent knew how to process ${processedReferences.length} of the ${references?.length || 0} provided references.`);
		return { result: parts.join('\n'), processedReferences };
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
					const sessionInfo = await this._octoKitService.getSessionInfo(sessionId, { createIfNone: true });
					if (!sessionInfo || token.isCancellationRequested) {
						complete();
						return;
					}

					// Get session logs
					const logs = await this._octoKitService.getSessionLogs(sessionId, { createIfNone: true });

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
			const contentBuilder = new ChatSessionContentBuilder(CopilotCloudSessionsProvider.TYPE, this._gitService, this._prFileChangesService);

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
									if (toolPart instanceof vscode.ChatResponseThinkingProgressPart) {
										stream.push(new vscode.ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
									}
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
										if (toolPart instanceof vscode.ChatResponseThinkingProgressPart) {
											stream.push(new vscode.ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
										}
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
			sessionInfo = await this._octoKitService.getSessionInfo(sessionId, { createIfNone: true });
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
			if (sessionInfo?.state === 'in_progress') {
				this.logService.trace('Session already in progress');
				this.refresh();
				return sessionInfo;
			}
			// Failure
			this.logService.trace('Failed to find queued session');
			return;
		}

		const maxWaitTime = 2 * 60 * 1_000; // 2 minutes
		const pollInterval = 3_000; // 3 seconds
		const startTime = Date.now();

		this.logService.trace(`Session ${sessionInfo.id} is queued, waiting for transition to in_progress...`);
		while (Date.now() - startTime < maxWaitTime && (!token || !token.isCancellationRequested)) {
			const sessionInfo = await this._octoKitService.getSessionInfo(sessionId, { createIfNone: true });
			if (sessionInfo?.state === 'in_progress') {
				this.logService.trace(`Session ${sessionInfo.id} now in progress.`);
				this.refresh();
				return sessionInfo;
			}
			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}
		this.logService.error(`Timed out waiting for session ${sessionId} to transition from queued to in_progress.`);
	}

	private async waitForNewSession(
		pullRequest: PullRequestSearchItem,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		waitForTransitionToInProgress: boolean = false
	): Promise<SessionInfo | undefined> {
		// Get the current number of sessions
		const initialSessions = await this._octoKitService.getCopilotSessionsForPR(pullRequest.fullDatabaseId.toString(), { createIfNone: true });
		const initialSessionCount = initialSessions.length;

		// Poll for a new session to start
		const maxWaitTime = 5 * 60 * 1000; // 5 minutes
		const pollInterval = 3000; // 3 seconds
		const startTime = Date.now();

		while (Date.now() - startTime < maxWaitTime && !token.isCancellationRequested) {
			const currentSessions = await this._octoKitService.getCopilotSessionsForPR(pullRequest.fullDatabaseId.toString(), { createIfNone: true });

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

	private async addFollowUpToExistingPR(pullRequestNumber: number, userPrompt: string, summary?: string): Promise<string | undefined> {
		try {
			const pr = await this.findPR(pullRequestNumber);
			if (!pr) {
				this.logService.error(`Could not find pull request #${pullRequestNumber}`);
				return;
			}
			// Add a comment tagging @copilot with the user's prompt
			const commentBody = `@copilot ${userPrompt} ${summary ? '\n\n' + summary : ''}`;

			const commentResult = await this._octoKitService.addPullRequestComment(pr.id, commentBody, { createIfNone: true });
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

	// https://github.com/github/sweagentd/blob/main/docs/adr/0001-create-job-api.md
	private validateRemoteAgentJobResponse(response: unknown): response is RemoteAgentJobResponse {
		return typeof response === 'object' && response !== null && 'job_id' in response && 'session_id' in response;
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
			const jobInfo = await this._octoKitService.getJobByJobId(owner, repo, jobId, 'vscode-copilot-chat', { createIfNone: true });
			if (jobInfo && jobInfo.pull_request && jobInfo.pull_request.number) {
				this.logService.trace(`Job ${jobId} now has pull request #${jobInfo.pull_request.number}`);
				this.refresh();
				return jobInfo;
			}
			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}

		this.logService.warn(`Timed out waiting for job ${jobId} to have pull request information`);
		return undefined;
	}

	private async invokeRemoteAgent(prompt: string, problemContext: string, token: vscode.CancellationToken, stream: vscode.ChatResponseStream, base_ref: string, customAgentName?: string, head_ref?: string): Promise<{ number: number; sessionId: string }> {
		const title = extractTitle(prompt, problemContext);
		const { problemStatement, isTruncated } = truncatePrompt(this.logService, prompt, problemContext);
		const repoId = await getRepoId(this._gitService);

		if (!repoId) {
			throw new Error(vscode.l10n.t('Unable to determine repository information. Please ensure you are working within a Git repository.'));
		}

		if (isTruncated) {
			stream.progress(vscode.l10n.t('Truncating context'));
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
				throw new Error(vscode.l10n.t('User cancelled due to truncation.'));
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

		stream?.progress(vscode.l10n.t('Delegating to cloud agent'));
		this.logService.trace(`[postCopilotAgentJob] Invoking cloud agent job with payload: ${JSON.stringify(payload)}`);
		const response = await this._octoKitService.postCopilotAgentJob(repoId.org, repoId.repo, JOBS_API_VERSION, payload, { createIfNone: true });
		this.logService.trace(`[postCopilotAgentJob] Received response from cloud agent job invocation: ${JSON.stringify(response)}`);
		if (!this.validateRemoteAgentJobResponse(response)) {
			const statusCode = response?.status;
			switch (statusCode) {
				case 422:
					// NOTE: Although earlier checks should prevent this, ensure that if we end up
					//       with a 422 from the API, we give a useful error message
					throw new Error(vscode.l10n.t('The cloud agent was unable to create a pull request with the specified base branch `{0}`. Please push branch to the remote and try again.', base_ref));
				default:
					throw new Error(vscode.l10n.t('Received invalid response {0} from cloud agent.', statusCode ? statusCode : ''));
			}
		}

		stream.progress(vscode.l10n.t('Creating pull request'));
		const jobInfo = await this.waitForJobWithPullRequest(repoId.org, repoId.repo, response.job_id, token);

		if (!jobInfo || !jobInfo.pull_request) {
			throw new Error(vscode.l10n.t('Failed to retrieve pull request information from job'));
		}

		const { number } = jobInfo.pull_request;
		if (!number || isNaN(number)) {
			throw new Error(vscode.l10n.t('Invalid pull request number received from cloud agent'));
		}
		return {
			number,
			sessionId: response.session_id
		};
	}
}
