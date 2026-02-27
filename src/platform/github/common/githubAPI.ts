/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';

export interface PullRequestSearchItem {
	id: string;
	number: number;
	title: string;
	state: string;
	url: string;
	createdAt: string;
	updatedAt: string;
	author: {
		login: string;
	} | null;
	repository: {
		owner: {
			login: string;
		};
		name: string;
	};
	additions: number;
	deletions: number;
	files: {
		totalCount: number;
	};
	fullDatabaseId: number;
	headRefOid: string;
	baseRefOid?: string;
	body: string;
}

export interface PullRequestSearchResult {
	search: {
		nodes: PullRequestSearchItem[];
		pageInfo: {
			hasNextPage: boolean;
			endCursor: string | null;
		};
		issueCount: number;
	};
}

export interface SessionInfo {
	id: string;
	name: string;
	user_id: number;
	agent_id: number;
	logs: string;
	logs_blob_id: string;
	state: 'completed' | 'in_progress' | 'failed' | 'queued';
	owner_id: number;
	repo_id: number;
	resource_type: string;
	resource_id: number;
	last_updated_at: string;
	created_at: string;
	completed_at: string;
	event_type: string;
	workflow_run_id: number;
	premium_requests: number;
	error: string | null;
	resource_global_id: string;
}

export interface PullRequestComment {
	id: string;
	body: string;
	createdAt: string;
	author: {
		login: string;
	};
	url: string;
}

export interface AssignableActor {
	__typename: string;
	login: string;
	avatarUrl?: string;
	url?: string;
}

export interface AssignableActorsResponse {
	repository: {
		suggestedActors?: {
			nodes: AssignableActor[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string | null;
			};
		};
		assignableUsers?: {
			nodes: AssignableActor[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string | null;
			};
		};
	};
}

export async function makeGitHubAPIRequest(
	fetcherService: IFetcherService,
	logService: ILogService,
	telemetry: ITelemetryService,
	host: string,
	routeSlug: string,
	method: 'GET' | 'POST',
	token: string | undefined,
	body?: unknown,
	version?: string,
	type: 'json' | 'text' = 'json',
	userAgent?: string,
	returnStatusCodeOnError: boolean = false,
	silent404: boolean = false) {
	const headers: { [key: string]: string } = {
		'Accept': 'application/vnd.github+json',
	};
	if (token) {
		headers['Authorization'] = `Bearer ${token}`;
	}
	if (version) {
		headers['X-GitHub-Api-Version'] = version;
	}
	if (userAgent) {
		headers['User-Agent'] = userAgent;
	}

	const response = await fetcherService.fetch(`${host}/${routeSlug}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined
	});
	if (!response.ok) {
		if (!(silent404 && response.status === 404)) {
			logService.error(`[GitHubAPI] ${method} ${host}/${routeSlug} - Status: ${response?.status}`);
		}
		if (returnStatusCodeOnError) {
			return { status: response.status };
		}
		return undefined;
	}

	try {
		const result = type === 'json' ? await response.json() : await response.text();
		const rateLimit = Number(response.headers.get('x-ratelimit-remaining'));
		const logMessage = `[RateLimit] REST rate limit remaining: ${rateLimit}, ${routeSlug}`;
		if (rateLimit < 1000) {
			// Danger zone
			logService.warn(logMessage);
			telemetry.sendMSFTTelemetryEvent('githubAPI.approachingRateLimit', { rateLimit: rateLimit.toString() });
		} else {
			logService.debug(logMessage);
		}
		return result;
	} catch {
		return undefined;
	}
}

export async function makeGitHubGraphQLRequest(fetcherService: IFetcherService, logService: ILogService, telemetry: ITelemetryService, host: string, query: string, token: string | undefined, variables?: unknown) {
	const headers: { [key: string]: string } = {
		'Accept': 'application/vnd.github+json',
		'Content-Type': 'application/json',
	};
	if (token) {
		headers['Authorization'] = `Bearer ${token}`;
	}

	const body = JSON.stringify({
		query,
		variables
	});

	const response = await fetcherService.fetch(`${host}/graphql`, {
		method: 'POST',
		headers,
		body
	});

	if (!response.ok) {
		return undefined;
	}

	try {
		const result = await response.json();
		const rateLimit = Number(response.headers.get('x-ratelimit-remaining'));
		const logMessage = `[RateLimit] GraphQL rate limit remaining: ${rateLimit}, query: ${query}`;
		if (rateLimit < 1000) {
			// Danger zone
			logService.warn(logMessage);
			telemetry.sendMSFTTelemetryEvent('githubAPI.approachingRateLimit', { rateLimit: rateLimit.toString() });
		} else {
			logService.debug(logMessage);
		}
		return result;
	} catch {
		return undefined;
	}
}

export async function makeSearchGraphQLRequest(
	fetcherService: IFetcherService,
	logService: ILogService,
	telemetry: ITelemetryService,
	host: string,
	token: string | undefined,
	searchQuery: string,
	first: number = 20,
): Promise<PullRequestSearchItem[]> {
	const query = `
		query FetchCopilotAgentPullRequests($searchQuery: String!, $first: Int!, $after: String) {
			search(query: $searchQuery, type: ISSUE, first: $first, after: $after) {
				nodes {
					... on PullRequest {
						number
						id
						fullDatabaseId
						headRefOid
						baseRefOid
						title
						state
						url
						createdAt
						updatedAt
						additions
						deletions
						files {
							totalCount
						}
						author {
							login
						}
						repository {
							owner {
								login
							}
							name
						}
						body
					}
				}
				pageInfo {
					hasNextPage
					endCursor
				}
				issueCount
			}
		}
	`;

	logService.debug(`[FolderRepositoryManager+0] Fetch pull request category ${searchQuery}`);

	const variables = {
		searchQuery,
		first
	};

	// TODO: Handle rate limiting
	//       result.errors[0]
	//         {type: 'RATE_LIMIT', code: 'graphql_rate_limit', message: 'API rate limit already exceeded for user ID xxxxxxx.'}

	const result = await makeGitHubGraphQLRequest(fetcherService, logService, telemetry, host, query, token, variables);

	return result.data?.search?.nodes ?? [];
}

export async function getPullRequestFromGlobalId(
	fetcherService: IFetcherService,
	logService: ILogService,
	telemetry: ITelemetryService,
	host: string,
	token: string | undefined,
	globalId: string,
): Promise<PullRequestSearchItem | null> {
	const query = `
		query GetPullRequestGlobal($globalId: ID!) {
			node(id: $globalId) {
				... on PullRequest {
					number
					id
					fullDatabaseId
					headRefOid
					baseRefOid
					title
					state
					url
					createdAt
					updatedAt
					additions
					deletions
					files {
						totalCount
					}
					author {
						login
					}
					repository {
						owner {
							login
						}
						name
					}
					body
				}
			}
		}
	`;

	logService.debug(`[GitHubAPI] Fetch pull request by global ID ${globalId}`);

	const variables = {
		globalId,
	};

	const result = await makeGitHubGraphQLRequest(fetcherService, logService, telemetry, host, query, token, variables);

	return result?.data?.node;
}

export async function addPullRequestCommentGraphQLRequest(
	fetcherService: IFetcherService,
	logService: ILogService,
	telemetry: ITelemetryService,
	host: string,
	token: string | undefined,
	pullRequestId: string,
	commentBody: string,
): Promise<PullRequestComment | null> {
	const mutation = `
		mutation AddPullRequestComment($pullRequestId: ID!, $body: String!) {
			addComment(input: {subjectId: $pullRequestId, body: $body}) {
				commentEdge {
					node {
						id
						body
						createdAt
						author {
							login
						}
						url
					}
				}
			}
		}
	`;

	logService.debug(`[GitHubAPI] Adding comment to pull request ${pullRequestId}`);

	const variables = {
		pullRequestId,
		body: commentBody
	};

	const result = await makeGitHubGraphQLRequest(fetcherService, logService, telemetry, host, mutation, token, variables);

	return result?.data?.addComment?.commentEdge?.node || null;
}

export async function closePullRequest(
	fetcherService: IFetcherService,
	logService: ILogService,
	telemetry: ITelemetryService,
	host: string,
	token: string | undefined,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<boolean> {
	logService.debug(`[GitHubAPI] Closing pull request ${owner}/${repo}#${pullNumber}`);

	const result = await makeGitHubAPIRequest(
		fetcherService,
		logService,
		telemetry,
		host,
		`repos/${owner}/${repo}/pulls/${pullNumber}`,
		'POST',
		token,
		{ state: 'closed' },
		'2022-11-28'
	);

	const success = result?.state === 'closed';
	if (success) {
		logService.debug(`[GitHubAPI] Successfully closed pull request ${owner}/${repo}#${pullNumber}`);
	} else {
		logService.error(`[GitHubAPI] Failed to close pull request ${owner}/${repo}#${pullNumber}. Its state is ${result?.state}`);
	}
	return success;
}

export async function makeGitHubAPIRequestWithPagination(
	fetcherService: IFetcherService,
	logService: ILogService,
	host: string,
	path: string,
	nwo: string,
	token: string,
): Promise<SessionInfo[]> {
	let hasNextPage = false;
	const sessionInfos: SessionInfo[] = [];
	const page_size = 20;
	let page = 1;
	do {
		const response = await fetcherService.fetch(
			`${host}/${path}?page_size=${page_size}&page_number=${page}&resource_state=draft,open&repo_nwo=${nwo}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/json',
				},
			});
		if (!response.ok) {
			logService.error(`[GitHubAPI] Failed to fetch sessions: ${response.status} ${response.statusText}`);
			return sessionInfos;
		}
		const sessions = await response.json();
		sessionInfos.push(...sessions.sessions);
		hasNextPage = sessions.sessions.length === page_size;
		page++;
	} while (hasNextPage);

	return sessionInfos;
}

/**
 * Fetches assignable actors (users/bots) for a repository using suggestedActors API.
 * This is the preferred API as it filters by capability (CAN_BE_ASSIGNED).
 */
export async function getAssignableActorsWithSuggestedActors(
	fetcherService: IFetcherService,
	logService: ILogService,
	telemetry: ITelemetryService,
	host: string,
	token: string | undefined,
	owner: string,
	repo: string,
): Promise<AssignableActor[]> {
	const query = `
		query GetSuggestedActors($owner: String!, $name: String!, $first: Int!, $after: String) {
			repository(owner: $owner, name: $name) {
				suggestedActors(
					first: $first
					after: $after
					capabilities: [CAN_BE_ASSIGNED]
				) {
					nodes {
						__typename
						login
						avatarUrl
						url
					}
					pageInfo {
						hasNextPage
						endCursor
					}
				}
			}
		}
	`;

	const actors: AssignableActor[] = [];
	let after: string | null = null;
	let hasNextPage = true;

	while (hasNextPage) {
		const variables = {
			owner,
			name: repo,
			first: 100,
			after,
		};

		const result = await makeGitHubGraphQLRequest(fetcherService, logService, telemetry, host, query, token, variables);

		if (!result?.data?.repository?.suggestedActors) {
			break;
		}

		const data = result.data.repository.suggestedActors;
		actors.push(...data.nodes);
		hasNextPage = data.pageInfo.hasNextPage;
		after = data.pageInfo.endCursor;
	}

	return actors;
}

/**
 * Fetches assignable users for a repository using assignableUsers API.
 * This is a fallback for older GitHub Enterprise Server instances that don't support suggestedActors.
 */
export async function getAssignableActorsWithAssignableUsers(
	fetcherService: IFetcherService,
	logService: ILogService,
	telemetry: ITelemetryService,
	host: string,
	token: string | undefined,
	owner: string,
	repo: string,
): Promise<AssignableActor[]> {
	const query = `
		query GetAssignableUsers($owner: String!, $name: String!, $first: Int!, $after: String) {
			repository(owner: $owner, name: $name) {
				assignableUsers(first: $first, after: $after) {
					nodes {
						__typename
						login
						avatarUrl
						url
					}
					pageInfo {
						hasNextPage
						endCursor
					}
				}
			}
		}
	`;

	const actors: AssignableActor[] = [];
	let after: string | null = null;
	let hasNextPage = true;

	while (hasNextPage) {
		const variables = {
			owner,
			name: repo,
			first: 100,
			after,
		};

		const result = await makeGitHubGraphQLRequest(fetcherService, logService, telemetry, host, query, token, variables);

		if (!result?.data?.repository?.assignableUsers) {
			break;
		}

		const data = result.data.repository.assignableUsers;
		actors.push(...data.nodes);
		hasNextPage = data.pageInfo.hasNextPage;
		after = data.pageInfo.endCursor;
	}

	return actors;
}
