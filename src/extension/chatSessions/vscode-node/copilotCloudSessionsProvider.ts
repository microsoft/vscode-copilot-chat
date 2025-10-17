/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { ChatSessionItem } from 'vscode';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../platform/git/common/gitService';
import { PullRequestSearchItem, SessionInfo } from '../../../platform/github/common/githubAPI';
import { IOctoKitService, JobInfo, RemoteAgentJobPayload } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { UriHandlerPaths, UriHandlers } from '../vscode/chatSessionsUriHandler';
import { body_suffix, CONTINUE_TRUNCATION, extractTitle, formatBodyPlaceholder, getRepoId, JOBS_API_VERSION, RemoteAgentResult, SessionIdForPr, truncatePrompt } from '../vscode/copilotCodingAgentUtils';
import { ChatSessionContentBuilder } from './copilotCloudSessionContentBuilder';

type ConfirmationResult = { step: string; accepted: boolean; metadata?: CreatePromptMetadata /* | SomeOtherMetadata */ };

interface CreatePromptMetadata {
	prompt: string;
	history?: string;
	references?: vscode.ChatPromptReference[];
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

export class CopilotChatSessionsProvider extends Disposable implements vscode.ChatSessionContentProvider, vscode.ChatSessionItemProvider {
	public static readonly TYPE = 'copilot-cloud-agent';
	private readonly DELEGATE_MODAL_DETAILS = vscode.l10n.t('The agent will work asynchronously to create a pull request with your requested changes.');
	private readonly COPILOT = '@copilot';

	private readonly _onDidChangeChatSessionItems = this._register(new vscode.EventEmitter<void>());
	public onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;
	private readonly _onDidCommitChatSessionItem = this._register(new vscode.EventEmitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public onDidCommitChatSessionItem = this._onDidCommitChatSessionItem.event;
	private chatSessions: Map<number, PullRequestSearchItem> = new Map();
	private chatSessionItemsPromise: Promise<vscode.ChatSessionItem[]> | undefined;
	private readonly _onDidCommitChatSession = this._register(new vscode.EventEmitter<{ original: ChatSessionItem; modified: ChatSessionItem }>());
	readonly onDidCommitChatSession = this._onDidCommitChatSession.event;
	public chatParticipant = vscode.chat.createChatParticipant(CopilotChatSessionsProvider.TYPE, async (request, context, stream, token) =>
		await this.chatParticipantImpl(request, context, stream, token)
	);


	constructor(
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@IGitService private readonly _gitService: IGitService,
		@ITelemetryService private readonly telemetry: ITelemetryService,
		@ILogService private readonly logService: ILogService,
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService
	) {
		super();
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
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
			const pullRequests = await this._octoKitService.getCopilotPullRequestsForUser(repoId.org, repoId.repo);
			const sessionItems = await Promise.all(pullRequests.map(async pr => {
				const uri = await this.toOpenPullRequestWebviewUri({ owner: pr.repository.owner.login, repo: pr.repository.name, pullRequestNumber: pr.number });
				const prLinkTitle = vscode.l10n.t('Open pull request in VS Code');
				const description = new vscode.MarkdownString(`[#${pr.number}](${uri.toString()} "${prLinkTitle}")`);
				const session = {
					id: pr.number.toString(),
					resource: undefined,
					label: pr.title,
					status: this.getSessionState(pr.state),
					description,
					timing: {
						startTime: new Date(pr.updatedAt).getTime(),
					},
					statistics: {
						insertions: pr.additions,
						deletions: pr.deletions
					},
					fullDatabaseId: pr.fullDatabaseId.toString(),
				};
				this.chatSessions.set(pr.number, pr);
				return session;
			}));
			return sessionItems;
		})().finally(() => {
			this.chatSessionItemsPromise = undefined;
		});
		return this.chatSessionItemsPromise;
	}

	async provideChatSessionContent(sessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const indexedSessionId = SessionIdForPr.parse(sessionId);
		let pullRequestNumber: number | undefined;
		if (indexedSessionId) {
			pullRequestNumber = indexedSessionId.prNumber;
		}
		if (typeof pullRequestNumber === 'undefined') {
			pullRequestNumber = parseInt(sessionId);
			if (isNaN(pullRequestNumber)) {
				this.logService.error(`Invalid pull request number: ${sessionId}`);
				return this.createEmptySession();
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
			let prompt = jobInfo.problem_statement;
			const titleMatch = jobInfo.problem_statement.match(/TITLE: \s*(.*)/i);
			if (titleMatch && titleMatch[1]) {
				prompt = titleMatch[1].trim();
			} else {
				const split = jobInfo.problem_statement.split('\n');
				if (split.length > 0) {
					prompt = split[0].trim();
				}
			}
			return prompt.replace(/@copilot\s*/gi, '').trim();
		};
		if (!pr) {
			this.logService.error(`Session not found for ID: ${sessionId}`);
			return this.createEmptySession();
		}
		const sessions = await this._octoKitService.getCopilotSessionsForPR(pr.fullDatabaseId.toString());
		const sessionContentBuilder = new ChatSessionContentBuilder(CopilotChatSessionsProvider.TYPE, this._gitService);
		const history = await sessionContentBuilder.buildSessionHistory(getProblemStatement(sessions), sessions, pr, (sessionId: string) => this._octoKitService.getSessionLogs(sessionId));
		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined
		};
	}

	private createEmptySession(): vscode.ChatSession {
		return {
			history: [],
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

	private getSessionState(state: string): vscode.ChatSessionStatus {
		switch (state) {
			case 'failed':
				return vscode.ChatSessionStatus.Failed;
			case 'in_progress': case 'queued':
				return vscode.ChatSessionStatus.InProgress;
			default:
				return vscode.ChatSessionStatus.Completed;
		}
	}

	private async toOpenPullRequestWebviewUri(params: {
		owner: string;
		repo: string;
		pullRequestNumber: number;
	}): Promise<vscode.Uri> {
		const query = JSON.stringify(params);
		const extensionId = UriHandlers[UriHandlerPaths.External_OpenPullRequestWebview];
		return await vscode.env.asExternalUri(vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: extensionId, path: UriHandlerPaths.External_OpenPullRequestWebview, query }));
	}

	private async chatParticipantImpl(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		const startSession = async (source: string, prompt: string, history?: string, references?: readonly vscode.ChatPromptReference[]) => {
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
			);
			if (result.state !== 'success') {
				this.logService.error(`Failed to provide new chat session item: ${result.error}${result.innerError ? `\nInner Error: ${result.innerError}` : ''}`);
				stream.warning(result.error);
				return;
			}
			return result.number;
		};

		const handleConfirmationData = async () => {
			const results: ConfirmationResult[] = [];
			results.push(...(request.acceptedConfirmationData?.map(data => ({ step: data.step, accepted: true, metadata: data?.metadata })) ?? []));
			results.push(...((request.rejectedConfirmationData ?? []).filter(data => !results.some(r => r.step === data.step)).map(data => ({ step: data.step, accepted: false, metadata: data?.metadata }))));
			for (const data of results) {
				switch (data.step) {
					case 'create':
						{
							if (!data.accepted) {
								stream.markdown(vscode.l10n.t('Coding agent request cancelled.'));
								return {};
							}
							const { prompt, history, references } = data.metadata as CreatePromptMetadata;
							const number = await startSession('chat', prompt, history, references);
							if (!number) {
								return {};
							}
							const pullRequest = await this.findPR(number);
							if (!pullRequest) {
								stream.warning(vscode.l10n.t('Could not find the associated pull request {0} for this chat session.', number));
								return {};
							}

							// TODO: handle card
							// const uri = await this.toOpenPullRequestWebviewUri({ owner: pullRequest.remote.owner, repo: pullRequest.remote.repositoryName, pullRequestNumber: pullRequest.number });
							// const plaintextBody = marked.parse(pullRequest.body, { renderer: new PlainTextRenderer(true), smartypants: true }).trim();
							// const card = new vscode.ChatResponsePullRequestPart(uri, pullRequest.title, plaintextBody, pullRequest.author.specialDisplayName ?? pullRequest.author.login, `#${pullRequest.number}`);
							// stream.push(card);
							stream.markdown(vscode.l10n.t('GitHub Copilot coding agent has begun working on your request. Follow its progress in the associated chat and pull request.'));
							vscode.window.showChatSession(CopilotChatSessionsProvider.TYPE, String(number), { viewColumn: vscode.ViewColumn.Active });
							break;
						}
					default:
						stream.warning(`Unknown confirmation step: ${data.step}\n\n`);
						break;
				}
			}
			return {};
		};

		if (request.acceptedConfirmationData || request.rejectedConfirmationData) {
			return await handleConfirmationData();
		}

		if (context.chatSessionContext?.isUntitled) {
			/* Generate new coding agent session from an 'untitled' session */
			const number = await startSession(
				'untitledChatSession',
				context.chatSummary?.prompt ?? request.prompt,
				context.chatSummary?.history,
				request.references
			);
			if (!number) {
				return {};
			}
			// Tell UI to the new chat session
			this._onDidCommitChatSession.fire({
				original: context.chatSessionContext.chatSessionItem,
				modified: {
					id: String(number),
					resource: undefined,
					label: `Pull Request ${number}`
				}
			});
		} else if (context.chatSessionContext) {
			/* Follow up to an existing coding agent session */
			try {
				if (token.isCancellationRequested) {
					return {};
				}

				// Validate user input
				const userPrompt = request.prompt;
				if (!userPrompt || userPrompt.trim().length === 0) {
					stream.markdown(vscode.l10n.t('Please provide a message for the coding agent.'));
					return {};
				}

				stream.progress(vscode.l10n.t('Preparing'));

				const pullRequest = await this.findPR(parseInt(context.chatSessionContext.chatSessionItem.id, 10));
				if (!pullRequest) {
					stream.warning(vscode.l10n.t('Could not find the associated pull request {0} for this chat session.', context.chatSessionContext.chatSessionItem.id));
					return {};
				}

				stream.progress(vscode.l10n.t('Delegating request to coding agent'));

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
				stream.markdown(vscode.l10n.t('Coding agent has begun work on your request'));
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
				vscode.l10n.t('Delegate to coding agent'),
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

				// TODO: support file changes
				// await pullRequest.getFileChangesInfo();
				// const multiDiffPart = await this.getFileChangesMultiDiffPart(pullRequest);
				// if (multiDiffPart) {
				// 	stream.push(multiDiffPart);
				// }

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
			const contentBuilder = new ChatSessionContentBuilder(CopilotChatSessionsProvider.TYPE, this._gitService);

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
					stream.markdown(vscode.l10n.t('Timed out waiting for coding agent to begin work. Please try again shortly.'));
					return;
				}
				return inProgressSession;
			}

			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}

		stream.markdown(vscode.l10n.t('Timed out waiting for the coding agent to respond. The agent may still be processing your request.'));
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
			const commentBody = `${this.COPILOT} ${userPrompt} \n\n --- \n\n ${summary ?? ''}`;

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

	async invokeRemoteAgent(prompt: string, problemContext?: string, token?: vscode.CancellationToken, autoPushAndCommit = true, chatStream?: vscode.ChatResponseStream): Promise<RemoteAgentResult> {
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
		let head_ref: string | undefined; // This is the ref coding agent starts work from (omitted unless we push local changes)

		const hasChanges =
			autoPushAndCommit &&
			((currentRepository?.changes?.workingTree && currentRepository.changes.workingTree.length > 0) || (currentRepository?.changes?.indexChanges && currentRepository.changes.indexChanges.length > 0));
		if (hasChanges) {
			// TODO: support pending changes
			// if (!CopilotRemoteAgentConfig.getAutoCommitAndPushEnabled()) {
			// 	return { error: vscode.l10n.t('Uncommitted changes detected. Please commit or stash your changes before starting the remote agent. Enable \'{0}\' to push your changes automatically.', CODING_AGENT_AUTO_COMMIT_AND_PUSH), state: 'error' };
			// }
			// try {
			// 	chatStream?.progress(vscode.l10n.t('Waiting for local changes'));
			// 	head_ref = await this.gitOperationsManager.commitAndPushChanges(repoInfo);
			// } catch (error) {
			// 	return { error: vscode.l10n.t('Failed to commit and push changes. Please try again later.'), innerError: error.message, state: 'error' };
			// }
		}

		// try {
		// 	if (!(await ghRepository.hasBranch(base_ref))) {
		// 		if (!CopilotRemoteAgentConfig.getAutoCommitAndPushEnabled()) {
		// 			// We won't auto-push a branch if the user has disabled the setting
		// 			return { error: vscode.l10n.t('The branch \'{0}\' does not exist on the remote repository \'{1}/{2}\'. Please create the remote branch first.', base_ref, owner, repo), state: 'error' };
		// 		}
		// 		// Push the branch
		// 		Logger.appendLine(`Base ref needs to exist on remote.  Auto pushing base_ref '${base_ref}' to remote repository '${owner}/${repo}'`, CopilotRemoteAgentManager.ID);
		// 		await repository.push(remote.remoteName, base_ref, true);
		// 	}
		// } catch (error) {
		// 	return { error: vscode.l10n.t('Failed to configure base branch \'{0}\' does not exist on the remote repository \'{1}/{2}\'. Please create the remote branch first.', base_ref, owner, repo), state: 'error' };
		// }

		const title = extractTitle(prompt, problemContext);
		const { problemStatement, isTruncated } = truncatePrompt(this.logService, prompt, problemContext);

		if (isTruncated) {
			chatStream?.progress(vscode.l10n.t('Truncating context'));
			const truncationResult = await vscode.window.showWarningMessage(
				vscode.l10n.t('Prompt size exceeded'), { modal: true, detail: vscode.l10n.t('Your prompt will be truncated to fit within coding agent\'s context window. This may affect the quality of the response.') }, CONTINUE_TRUNCATION);
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
			pull_request: {
				title,
				body_placeholder: formatBodyPlaceholder(title),
				base_ref,
				body_suffix,
				...(head_ref && { head_ref })
			}
		};

		try {
			chatStream?.progress(vscode.l10n.t('Delegating to coding agent'));
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

			const webviewUri = await this.toOpenPullRequestWebviewUri({ owner: pullRequest.repository.owner.login, repo: pullRequest.repository.name, pullRequestNumber: number });
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
			return { error: vscode.l10n.t('Failed delegating to coding agent. Please try again later.'), innerError: error.message, state: 'error' };
		}
	}
}

