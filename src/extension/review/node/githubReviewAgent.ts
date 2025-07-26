/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import * as readline from 'readline';
import type { TextDocument } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IEnvService } from '../../../platform/env/common/envService';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { normalizeFetchUrl } from '../../../platform/git/common/gitService';
import { Repository } from '../../../platform/git/vscode/git';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { Progress } from '../../../platform/notification/common/notificationService';
import { ReviewComment, ReviewRequest } from '../../../platform/review/common/reviewService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import * as path from '../../../util/vs/base/common/path';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { l10n, MarkdownString, Range, Uri } from '../../../vscodeTypes';
import { FeedbackResult } from '../../prompt/node/feedbackGenerator';


const testing = false;

export async function githubReview(
	logService: ILogService,
	gitExtensionService: IGitExtensionService,
	authService: IAuthenticationService,
	capiClientService: ICAPIClientService,
	domainService: IDomainService,
	fetcherService: IFetcherService,
	envService: IEnvService,
	ignoreService: IIgnoreService,
	workspaceService: IWorkspaceService,
	group: 'index' | 'workingTree' | 'all' | { repositoryRoot: string; commitMessages: string[]; patches: { patch: string; fileUri: string; previousFileUri?: string }[] },
	progress: Progress<ReviewComment[]>,
	cancellationToken: CancellationToken
): Promise<FeedbackResult> {
	const git = gitExtensionService.getExtensionApi();
	if (!git) {
		return { type: 'success', comments: [] };
	}
	const changes = (typeof group === 'string'
		? (await Promise.all(git.repositories.map(async repository => {
			const uris = new Set<Uri>();
			if (group === 'all' || group === 'index') {
				repository.state.indexChanges.forEach(c => uris.add(c.uri));
			}
			if (group === 'all' || group === 'workingTree') {
				repository.state.workingTreeChanges.forEach(c => uris.add(c.uri));
				repository.state.untrackedChanges.forEach(c => uris.add(c.uri));
			}
			const changes = await Promise.all(Array.from(uris).map(async uri => {
				const document = await workspaceService.openTextDocument(uri).then(undefined, () => undefined);
				if (!document) {
					return undefined; // Deleted files can be skipped.
				}
				const before = await (group === 'index' || group === 'all' ? repository.show('HEAD', uri.fsPath).catch(() => '') : repository.show('', uri.fsPath).catch(() => ''));
				const after = group === 'index' ? await (repository.show('', uri.fsPath).catch(() => '')) : document.getText();
				const relativePath = path.relative(repository.rootUri.fsPath, uri.fsPath);
				return {
					repository,
					uri,
					relativePath: process.platform === 'win32' ? relativePath.replace(/\\/g, '/') : relativePath,
					before,
					after,
					document,
				};
			}));
			return changes;
		}))).flat()
		: await Promise.all(group.patches.map(async patch => {
			const uri = Uri.parse(patch.fileUri);
			const document = await workspaceService.openTextDocument(uri).then(undefined, () => undefined);
			if (!document) {
				return undefined; // Deleted files can be skipped.
			}
			const after = document.getText();
			const before = reversePatch(after, patch.patch);
			const relativePath = path.relative(group.repositoryRoot, uri.fsPath);
			return {
				repository: git.getRepository(Uri.parse(group.repositoryRoot))!,
				relativePath: process.platform === 'win32' ? relativePath.replace(/\\/g, '/') : relativePath,
				before,
				after,
				document,
			};
		}))).filter((change): change is NonNullable<typeof change> => !!change);

	if (!changes.length) {
		return { type: 'success', comments: [] };
	}

	const ignored = await Promise.all(changes.map(i => ignoreService.isCopilotIgnored(i.document.uri)));
	const filteredChanges = changes.filter((_, i) => !ignored[i]);
	if (filteredChanges.length === 0) {
		logService.info('All input documents are ignored. Skipping feedback generation.');
		return {
			type: 'error',
			severity: 'info',
			reason: l10n.t('All input documents are ignored by configuration. Check your .copilotignore file.')
		};
	}
	logService.debug(`[github review agent] files: ${filteredChanges.map(change => change.relativePath).join(', ')}`);

	const { requestId, rl } = !testing ? await fetchComments(
		logService,
		authService,
		capiClientService,
		fetcherService,
		envService,
		filteredChanges[0].repository,
		filteredChanges.map(change => ({ path: change.relativePath, content: change.before })),
		filteredChanges.map(change => ({ path: change.relativePath, content: change.after })),
		cancellationToken,
	) : {
		requestId: 'test-request-id',
		rl: [
			'data: ...',
			'data: [DONE]',
		]
	};
	if (!rl || cancellationToken.isCancellationRequested) {
		return { type: 'cancelled' };
	}

	logService.info(`[github review agent] request id: ${requestId}`);

	const request: ReviewRequest = {
		source: 'githubReviewAgent',
		promptCount: -1,
		messageId: requestId || generateUuid(),
		inputType: 'change',
		inputRanges: [],
	};
	const references: ResponseReference[] = [];
	const comments: ReviewComment[] = [];
	for await (const line of rl) {
		if (cancellationToken.isCancellationRequested) {
			return { type: 'cancelled' };
		}
		logService.debug(`[github review agent] response line: ${line}`);
		const refs = parseLine(line);
		references.push(...refs);
		for (const ghComment of refs.filter(ref => ref.type === 'github.generated-pull-request-comment')) {
			const change = filteredChanges.find(change => change.relativePath === ghComment.data.path);
			if (!change) {
				continue;
			}
			const comment = createReviewComment(ghComment, request, change.document, comments.length);
			comments.push(comment);
			progress.report([comment]);
		}
	}
	const excludedComments = references.filter((ref): ref is ExcludedComment => ref.type === 'github.excluded-pull-request-comment')
		.map(ghComment => {
			const change = filteredChanges.find(change => change.relativePath === ghComment.data.path);
			return { ghComment, change };
		}).filter((item): item is { ghComment: ExcludedComment; change: NonNullable<typeof item.change> } => !!item.change)
		.map(({ ghComment, change }, i) => createReviewComment(ghComment, request, change.document, comments.length + i));
	const unsupportedLanguages = !comments.length ? [...new Set(references.filter((ref): ref is ExcludedFile => ref.type === 'github.excluded-file' && ref.data.reason === 'file_type_not_supported')
		.map(ref => ref.data.language))] : [];
	return { type: 'success', comments, excludedComments, reason: unsupportedLanguages.length ? l10n.t('Some of the submitted languages are currently not supported: {0}', unsupportedLanguages.join(', ')) : undefined };
}

function createReviewComment(ghComment: ResponseComment | ExcludedComment, request: ReviewRequest, document: TextDocument, index: number) {
	const fromLine = document.lineAt(ghComment.data.line - 1);
	const lastNonWhitespaceCharacterIndex = fromLine.text.trimEnd().length;
	const range = new Range(fromLine.lineNumber, fromLine.firstNonWhitespaceCharacterIndex, fromLine.lineNumber, lastNonWhitespaceCharacterIndex);
	const raw = ghComment.data.body;
	// Remove suggestion because that interfers with our own suggestion rendering later.
	const content = removeSuggestion(raw);
	const comment: ReviewComment = {
		request,
		document: TextDocumentSnapshot.create(document),
		uri: document.uri,
		languageId: document.languageId,
		range,
		body: new MarkdownString(content),
		kind: 'bug',
		severity: 'medium',
		originalIndex: index,
		actionCount: 0,
	};
	return comment;
}

const SUGGESTION_EXPRESSION = /```suggestion(\u0020*(\r\n|\n))((?<suggestion>[\s\S]*?)(\r\n|\n))?```/g;
function removeSuggestion(body: string) {
	return body.replaceAll(SUGGESTION_EXPRESSION, '');
}

// Represents the "before" or "after" state of a file, sent to the agent
interface FileState {
	// The path of the file
	path: string;
	// The file's contents. If the file does not exist in this state, this should be an empty string.
	content: string;
}

// A generated pull request comment returned by the agent.
//
// NOTE: The shape of these return values is under active development and is likely to change.
//
// Example:
//
// {
//   "type": "github.generated-pull-request-comment",
//   "data": {
//     "path": "packages/issues/test/models/referrer_and_referenceable_model_test.rb",
//     "line": 82,
//     "body": "The word 'Out' should be 'Our'.\n```suggestion\n    # Our batched insert only hits the cross references table twice\n```",
//     "side": "RIGHT"
//   },
//   "id": "",
//   "is_implicit": false,
//   "metadata": {
//     "display_name": "",
//     "display_icon": "",
//     "display_url": ""
//   }
// }

type ResponseReference = ResponseComment | ExcludedComment | ExcludedFile | { type: 'unknown' };

interface ResponseComment {
	type: 'github.generated-pull-request-comment';
	data: {
		// The path of the file
		path: string;
		// The right-hand line number the comment relates to
		line: number;
		// The body of the comment, including a ```suggestion block if there is a suggested change
		body: string;
	};
}

interface ExcludedComment {
	type: 'github.excluded-pull-request-comment';
	data: {
		path: string;
		line: number;
		body: string;
		exclusion_reason: 'denylisted_type' | 'unknown';
	};
}

interface ExcludedFile {
	type: 'github.excluded-file';
	data: {
		file_path: string;
		language: string;
		reason: 'file_type_not_supported' | 'unknown';
	};
}

function parseLine(line: string): ResponseReference[] {

	if (line === 'data: [DONE]') { return []; }
	if (line === '') { return []; }

	const parsedLine = JSON.parse(line.replace('data: ', ''));

	if (Array.isArray(parsedLine.copilot_references) && parsedLine.copilot_references.length > 0) {
		return parsedLine.copilot_references.filter((ref: any) => ref.type) as ResponseReference[];
	} else {
		return [];
	}
}

async function fetchComments(logService: ILogService, authService: IAuthenticationService, capiClientService: ICAPIClientService, fetcherService: IFetcherService, envService: IEnvService, repository: Repository | undefined, baseFileContents: FileState[], headFileContents: FileState[], cancellationToken: CancellationToken) {
	const codingGuidlines = repository ? await loadCodingGuidelines(logService, authService, capiClientService, repository) : [];

	const requestBody = {
		messages: [{
			role: 'user',
			// This is the minimum reference required to get the agent to generate comments.
			// NOTE: The shape of these references is under active development and is likely to change.
			copilot_references: [
				{
					type: 'github.pull_request',
					id: '1',
					data: {
						type: 'pull-request',
						headFileContents,
						baseFileContents,
						// TODO: Refer to the repository so custom coding guidelines can be selected
					},
				},
				...codingGuidlines,
			],
		}]
	};

	const abort = fetcherService.makeAbortController();
	const disposable = cancellationToken.onCancellationRequested(() => abort.abort());
	let response: Response;
	try {
		const copilotToken = await authService.getCopilotToken();
		response = await capiClientService.makeRequest({
			method: 'POST',
			headers: {
				Authorization: 'Bearer ' + copilotToken.token,
				'X-Copilot-Code-Review-Mode': 'ide',
			},
			body: JSON.stringify(requestBody),
			signal: abort.signal,
		}, { type: RequestType.CodeReviewAgent });
	} catch (err) {
		if (fetcherService.isAbortError(err)) {
			return {
				requestId: undefined,
				rl: undefined,
			};
		}
		throw err;
	} finally {
		disposable.dispose();
	}

	const requestId = response.headers.get('x-github-request-id') || undefined;

	if (!response.ok) {
		if (response.status === 402) {
			const err = new Error(`You have reached your GitHub Copilot Code Review quota limit.`);
			(err as any).severity = 'info';
			throw err;
		}
		throw new Error(`Agent returned an unexpected HTTP ${response.status} error (request id ${requestId || 'unknown'}).`);
	}

	const responseBody = await response.body();
	if (!responseBody) {
		throw new Error(`Agent returned an unexpected response: got 200 OK, but response body was empty (request id ${requestId || 'unknown'}).`);
	}

	return {
		requestId,
		rl: readline.createInterface({ input: responseBody as NodeJS.ReadableStream }),
	};
}

function reversePatch(after: string, diff: string) {
	const patch = parsePatch(diff.split(/\r?\n/));
	const patchedLines = reverseParsedPatch(after.split(/\r?\n/), patch);
	return patchedLines.join('\n');
}

interface LineChange {
	beforeLineNumber: number;
	content: string;
	type: 'add' | 'remove';
}

function parsePatch(patchLines: string[]): LineChange[] {
	const changes: LineChange[] = [];
	let beforeLineNumber = -1;

	for (const line of patchLines) {
		if (line.startsWith('@@')) {
			const match = /@@ -(\d+),\d+ \+\d+,\d+ @@/.exec(line);
			if (match) {
				beforeLineNumber = parseInt(match[1], 10);
			}
		} else if (beforeLineNumber !== -1) {
			if (line.startsWith('+')) {
				changes.push({ beforeLineNumber, content: line.slice(1), type: 'add' });
			} else if (line.startsWith('-')) {
				changes.push({ beforeLineNumber, content: line.slice(1), type: 'remove' });
				beforeLineNumber++;
			} else {
				beforeLineNumber++;
			}
		}
	}

	return changes;
}

function reverseParsedPatch(fileLines: string[], patch: LineChange[]): string[] {
	for (const change of patch) {
		if (change.type === 'add') {
			fileLines.splice(change.beforeLineNumber - 1, 1);
		} else if (change.type === 'remove') {
			fileLines.splice(change.beforeLineNumber - 1, 0, change.content);
		}
	}

	return fileLines;
}

async function loadCodingGuidelines(logService: ILogService, authService: IAuthenticationService, capiClientService: ICAPIClientService, repository: Repository) {
	const { state } = repository;
	const remote = state.HEAD?.upstream?.remote || state.HEAD?.remote;
	const pushUrl = remote && state.remotes.find(r => r.name === remote)?.pushUrl || state.remotes.find(r => r.pushUrl)?.pushUrl;
	if (!pushUrl) {
		return [];
	}
	const normalized = new URL(normalizeFetchUrl(pushUrl));
	if (normalized.hostname !== 'github.com') {
		return [];
	}
	const pathSegments = normalized.pathname.split('/');
	const owner = pathSegments[1];
	const repo = pathSegments[2].endsWith('.git') ? pathSegments[2].substring(0, pathSegments[2].length - 4) : pathSegments[2];
	const ghToken = (await authService.getAnyGitHubSession())?.accessToken;
	if (!ghToken) {
		logService.info(`Failed to fetch coding guidelines for ${owner}/${repo}: Not signed in.`);
		return [];
	}
	const response = await capiClientService.makeRequest<Response>({
		headers: {
			'Authorization': `Bearer ${ghToken}`
		},
	}, { type: RequestType.CodingGuidelines, repoWithOwner: `${owner}/${repo}` });

	const requestId = response.headers.get('x-github-request-id') || undefined;
	logService.info(`[github review agent] coding guidelines request id: ${requestId}`);

	if (!response.ok) {
		if (response.status !== 404) { // 404: No coding guidelines or user not part of coding guidelines feature flag.
			logService.info(`Failed to fetch coding guidelines for ${owner}/${repo}: ${response.statusText}`);
		}
		return [];
	}

	const text = await response.text();
	logService.debug(`[github review agent] coding guidelines: ${text}`);
	const codingGuidelines = JSON.parse(text) as { name: string; description: string; filePatterns: string }[];
	const codingGuidelineRefs = codingGuidelines.map((input, index) => ({
		type: "github.coding_guideline",
		id: `${index + 2}`,
		data: {
			id: index + 2,
			type: "coding-guideline",
			name: input.name,
			description: input.description,
			filePatterns: input.filePatterns,
		},
	}));
	return codingGuidelineRefs;
}