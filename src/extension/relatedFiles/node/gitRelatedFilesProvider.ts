/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Embedding, EmbeddingType, IEmbeddingsComputer, rankEmbeddings } from '../../../platform/embeddings/common/embeddingsComputer';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitService } from '../../../platform/git/common/gitService';
import { Commit } from '../../../platform/git/vscode/git';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { intersection, SetWithKey } from '../../../util/vs/base/common/collections';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap, ResourceSet } from '../../../util/vs/base/common/map';
import { basename, isEqual } from '../../../util/vs/base/common/resources';

interface ICommitWithChanges {
	repositoryRoot: vscode.Uri;
	commit: Commit;
	overlap: number;
	changedFiles: vscode.ChatRelatedFile[];
}

export class GitRelatedFilesProvider extends Disposable implements vscode.ChatRelatedFilesProvider {

	private cachePromise: Promise<void> | undefined;
	private readonly cachedCommitsByRepositoryRoot = new ResourceMap<Map<string, ICommitWithChanges>>();
	private readonly cachedCommitsWithEmbeddingsByRepositoryRoot = new ResourceMap<Map<string, readonly [ICommitWithChanges, Embedding]>>();

	constructor(
		@IGitService private readonly _gitService: IGitService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		if (this._configurationService.getConfig(ConfigKey.Internal.GitHistoryRelatedFilesUsingEmbeddings)) {
			// Index the latest 200 commits in the background
			// TODO@joyceerhl reindex incrementally when repository state changes
			// TODO@joyceerhl use only the changes from main branch?
			this.cachePromise = this.indexRecentCommits(200);
			this._register(this._workspaceService.onDidChangeWorkspaceFolders(() => {
				// Reindex if a folder is added to or removed from the workspace
				this.cachePromise = this.indexRecentCommits(200);
			}));
		}
	}

	private isEnabled() {
		return this._configurationService.getConfig(ConfigKey.GitHistoryRelatedFilesProvider) === true;
	}

	async provideRelatedFiles(chatRequest: vscode.ChatRequestDraft, token: vscode.CancellationToken): Promise<vscode.ChatRelatedFile[] | undefined> {
		if (!this.isEnabled()) {
			return;
		}

		if (chatRequest.files.length === 0 && !chatRequest.prompt) {
			return this.getChangedFiles();
		}

		// The user has not added any files to the working set, so we only have the prompt to go off of
		if (chatRequest.files.length === 0) {
			return this.getCommitsForPromptWithoutFiles(chatRequest, token);
		}

		if (this._configurationService.getConfig(ConfigKey.Internal.GitHistoryRelatedFilesUsingEmbeddings)) {
			return this.computeRelevantCommits(chatRequest, token);
		}

		return [...this.getChangedFiles(), ...await this.computeRelevantFiles(chatRequest)];
	}

	private getChangedFiles(): vscode.ChatRelatedFile[] {
		const changes = [];
		for (const repository of this._gitService.repositories) {
			if (!repository.changes) {
				continue;
			}
			changes.push(
				...repository.changes.indexChanges.map(c => ({ uri: c.uri, description: l10n.t('Git staged file') })),
				...repository.changes.untrackedChanges.map(c => ({ uri: c.uri, description: l10n.t('Git untracked file') })),
				...repository.changes.workingTree.map(c => ({ uri: c.uri, description: l10n.t('Git working tree file') })),
			);
		}
		return changes;
	}

	private async getCommitsForPromptWithoutFiles(chatRequest: vscode.ChatRequestDraft, token: vscode.CancellationToken) {
		if (chatRequest.prompt === '' || !this.cachePromise) {
			return undefined;
		}

		await this.cachePromise;

		// Calculate the embedding of the prompt
		// TODO@joyceerhl do local semantic search instead?
		const result = await this.computeCommitMessageEmbeddings([], chatRequest.prompt, token);
		if (!result) {
			return undefined;
		}

		// Do a semantic similarity search by query over the indexed commit messages
		const cachedCommits: (readonly [ICommitWithChanges, Embedding])[] = [];
		for (const repo of this.cachedCommitsWithEmbeddingsByRepositoryRoot.values()) {
			cachedCommits.push(...repo.values());
		}

		const ranked = rankEmbeddings<ICommitWithChanges>(result.promptEmbedding, cachedCommits, cachedCommits.length);
		const rerankedCommits = ranked.map((r) => r.value);

		// Suggest 10 files at most
		return this.getRelevantFilesFromCommits(rerankedCommits, chatRequest.files, 10);
	}

	private getRelevantFilesFromCommits(commits: ICommitWithChanges[], workingSetFiles: readonly vscode.Uri[], limit: number) {
		const relatedFiles: vscode.ChatRelatedFile[] = [];
		const files = new ResourceSet();
		for (const file of commits.map((c) => c.changedFiles).flat()) {
			if (files.has(file.uri) || workingSetFiles.find((f) => isEqual(f, file.uri))) {
				continue;
			}
			files.add(file.uri);
			relatedFiles.push(file);
			if (files.size >= limit) {
				break;
			}
		}
		return relatedFiles;
	}

	private async computeCommitMessageEmbeddings(commits: ICommitWithChanges[], prompt: undefined, token?: vscode.CancellationToken): Promise<{ promptEmbedding: undefined; commitsWithEmbeddings: ReadonlyArray<readonly [ICommitWithChanges, Embedding]> } | undefined>;
	private async computeCommitMessageEmbeddings(commits: ICommitWithChanges[], prompt: string, token?: vscode.CancellationToken): Promise<{ promptEmbedding: Embedding; commitsWithEmbeddings: ReadonlyArray<readonly [ICommitWithChanges, Embedding]> } | undefined>;
	private async computeCommitMessageEmbeddings(commits: ICommitWithChanges[], prompt?: string, token?: vscode.CancellationToken): Promise<{ promptEmbedding: Embedding | undefined; commitsWithEmbeddings: ReadonlyArray<readonly [ICommitWithChanges, Embedding]> } | undefined> {

		// Separate the commits into ones that we already have cached embeddings for and ones we need to compute embeddings for
		const commitsToComputeEmbeddingsFor: ICommitWithChanges[] = [];
		const cachedCommitsWithEmbeddings: (readonly [ICommitWithChanges, Embedding])[] = [];
		for (const commit of commits) {
			const cached = this.getCachedCommitWithEmbedding(commit.repositoryRoot, commit.commit);
			if (cached) {
				cachedCommitsWithEmbeddings.push(cached);
			} else {
				commitsToComputeEmbeddingsFor.push(commit);
			}
		}

		// Calculate the embeddings for the commits we don't have cached embeddings for
		const commitMessages = commitsToComputeEmbeddingsFor.map((commit) => commit.commit.message);
		const text = prompt ? [prompt, ...commitMessages] : commitMessages;
		const result = await this._embeddingsComputer.computeEmbeddings(EmbeddingType.text3small_512, text, {}, new TelemetryCorrelationId('GitRelatedFilesProvider::computeCommitMessageEmbeddings'), token);

		const embeddings = result.values;
		const promptEmbedding = prompt ? embeddings[0] : undefined;
		const commitEmbeddings = prompt ? embeddings.slice(1) : embeddings;

		// Merge the embeddings we just calculated with the cached ones
		const commitsWithEmbeddings = cachedCommitsWithEmbeddings;
		for (let i = 0; i < commitMessages.length; i++) {
			const commit = commits[i];
			const embedding = commitEmbeddings[i];

			// Add the embeddings we just calculated to the cache
			const repoMap = this.cachedCommitsWithEmbeddingsByRepositoryRoot.get(commit.repositoryRoot) ?? new Map<string, readonly [ICommitWithChanges, Embedding]>();
			repoMap.set(commit.commit.hash, [commit, embedding]);
			this.cachedCommitsWithEmbeddingsByRepositoryRoot.set(commit.repositoryRoot, repoMap);

			// Add them to the result
			commitsWithEmbeddings.push([commit, embedding]);
		}

		return {
			promptEmbedding,
			commitsWithEmbeddings
		};
	}

	private getCachedCommitWithEmbedding(repositoryRoot: vscode.Uri, commit: Commit): readonly [ICommitWithChanges, Embedding] | undefined {
		const repoMap = this.cachedCommitsWithEmbeddingsByRepositoryRoot.get(repositoryRoot);
		return repoMap?.get(commit.hash);
	}

	private async computeRelevantFiles(chatRequest: vscode.ChatRequestDraft): Promise<vscode.ChatRelatedFile[]> {
		const commitsModifyingRequestFiles = await Promise.all(chatRequest.files.map((uri) => this._gitService.log(uri, { path: uri.fsPath }).then(commits => ({ uri, commits }))));

		// KEY: a potentially relevant file file
		// VALUE: resource map from working set file URI to commits that coedited it
		const candidateFiles = new ResourceMap<ResourceMap<SetWithKey<Commit>>>();
		const seenCommits = new Set<string>();

		// For each of the files in the chat request, look up all the files that were modified with it in the same commit
		for (const { uri, commits } of commitsModifyingRequestFiles) {
			if (!commits) {
				continue;
			}

			for (const commit of commits) {
				// Don't process the same commit twice
				if (seenCommits.has(commit.hash)) {
					continue;
				}
				seenCommits.add(commit.hash);

				const repository = await this._gitService.getRepository(uri);
				const repositoryRoot = repository?.rootUri;
				if (!repositoryRoot) { // Shouldn't happen
					continue;
				}

				const commitWithChanges = await this.getCommitWithChanges(commit, repositoryRoot, uri, chatRequest);
				for (const changedFile of commitWithChanges.changedFiles) {
					if (!isEqual(uri, changedFile.uri)) {
						// Add to the existing set of working set files for this candidate related file
						const workingSetFiles = candidateFiles.get(changedFile.uri) ?? new ResourceMap();

						// Add the commit to the set of commits that coedited this file
						const commitsForWorkingSetFile = workingSetFiles.get(uri) ?? new SetWithKey<Commit>([], (c) => c.hash);
						commitsForWorkingSetFile.add(commit);

						workingSetFiles.set(uri, commitsForWorkingSetFile);
						candidateFiles.set(changedFile.uri, workingSetFiles);
					}
				}
			}
		}

		// Sort the candidate files by the number of associated working set files and the frequency with which this file was edited with the working set files
		const files: { uri: vscode.Uri; associatedWorkingSetFiles: ResourceSet; coeditingCommits: SetWithKey<Commit> }[] = [];
		for (const [candidateFile, coeditedFiles] of candidateFiles) {
			const coeditedCommits = new SetWithKey<Commit>([], (c) => c.hash);
			for (const commits of coeditedFiles.values()) {
				for (const commit of commits) {
					coeditedCommits.add(commit);
				}
			}

			const associatedWorkingSetFiles = new ResourceSet([...coeditedFiles.keys()]);
			files.push({ uri: candidateFile, associatedWorkingSetFiles, coeditingCommits: coeditedCommits });
		}
		const sortedFiles = files.sort((a, b) => (b.associatedWorkingSetFiles.size + b.coeditingCommits.size) - (a.associatedWorkingSetFiles.size + a.coeditingCommits.size));

		return sortedFiles.slice(0, 10).map((f) => {
			const fileBasename = basename([...f.associatedWorkingSetFiles.values()][0]);
			return {
				uri: f.uri, description:
					f.associatedWorkingSetFiles.size === 1
						? l10n.t('Often edited with {0}', fileBasename)
						: l10n.t('Often edited with {0} and {1} other files in your working set', fileBasename, f.associatedWorkingSetFiles.size)
			};
		});
	}

	// Look for all commits that touch the files in this request and rank their relevance to the prompt using
	// embeddings and the overlap between the commit's changelist and the working set contents
	private async computeRelevantCommits(chatRequest: vscode.ChatRequestDraft, token: vscode.CancellationToken): Promise<vscode.ChatRelatedFile[] | undefined> {

		await this.cachePromise;
		const commitsModifyingRequestFiles = await Promise.all(chatRequest.files.map((uri) => this._gitService.log(uri, { path: uri.fsPath }).then(commits => ({ uri, commits }))));
		const seenCommits = new Set<string>();
		const commitsWithChanges: ICommitWithChanges[] = [];
		for (const { uri, commits } of commitsModifyingRequestFiles) {
			if (!commits) {
				continue;
			}

			for (const commit of commits) {
				if (seenCommits.has(commit.hash)) {
					continue;
				}
				seenCommits.add(commit.hash);

				const repository = await this._gitService.getRepository(uri);
				const repositoryRoot = repository?.rootUri;
				if (!repositoryRoot) { // Shouldn't happen
					continue;
				}

				// Skip potentially expensive git log if we already have the commit in the cache
				const cachedCommit = this.getCachedCommitWithEmbedding(repositoryRoot, commit);
				if (!cachedCommit) {
					const commitWithChanges = await this.getCommitWithChanges(commit, repositoryRoot, uri, chatRequest);
					commitsWithChanges.push(commitWithChanges);
				} else {
					commitsWithChanges.push(cachedCommit[0]);
				}
			}
		}

		// We want to prioritize commits that modify multiple files from the request
		// Note, overlap should always be at least 1 since this came from a git log over the attached files
		const sortedCommits = commitsWithChanges
			.sort((a, b) => b.overlap - a.overlap);

		// TODO@joyceerhl what if one of the working set files isn't present in a commit that is otherwise highly relevant based on commit message?
		const commitsWithLargestOverlap = sortedCommits.filter((commit) => commit.overlap === sortedCommits[0].overlap);

		// Break ties by reranking based on commit messages which seem most relevant to the request
		const rerankedCommits = await this.rankCommitsByMessageRelevance(chatRequest, commitsWithLargestOverlap, token);

		// Suggest 10 files at most
		return this.getRelevantFilesFromCommits(rerankedCommits, chatRequest.files, 10);
	}

	private async rankCommitsByMessageRelevance(chatRequest: vscode.ChatRequestDraft, commits: ICommitWithChanges[], token: vscode.CancellationToken): Promise<ICommitWithChanges[]> {
		if (chatRequest.prompt === '') {
			return commits;
		}

		const result = await this.computeCommitMessageEmbeddings(commits, chatRequest.prompt, token);
		if (!result) {
			return commits;
		}

		const { promptEmbedding, commitsWithEmbeddings } = result;
		const ranked = rankEmbeddings<ICommitWithChanges>(promptEmbedding, commitsWithEmbeddings, commits.length);
		return ranked.map((r) => r.value);
	}

	private cacheAndReturnCommit(commitWithChanges: ICommitWithChanges) {
		let repoMap = this.cachedCommitsByRepositoryRoot.get(commitWithChanges.repositoryRoot);
		if (!repoMap) {
			repoMap = new Map<string, ICommitWithChanges>();
			this.cachedCommitsByRepositoryRoot.set(commitWithChanges.repositoryRoot, repoMap);
		}
		repoMap.set(commitWithChanges.commit.hash, commitWithChanges);
		return commitWithChanges;
	}

	private async getCommitWithChanges(commit: Commit, repositoryRoot: vscode.Uri, fileUri?: vscode.Uri, chatRequest?: vscode.ChatRequestDraft): Promise<ICommitWithChanges> {
		const cachedCommit = this.cachedCommitsByRepositoryRoot.get(repositoryRoot)?.get(commit.hash);
		if (cachedCommit) {
			return cachedCommit;
		}

		const filesChangedInCommit = new ResourceSet();
		const parentCommit = commit.parents[0];
		if (!parentCommit) {
			// This is the first commit in the history
			// TODO@joyceerhl Git extension needs to expose Repository#getEmptyTree
			return this.cacheAndReturnCommit({ commit, repositoryRoot, overlap: 0, changedFiles: [] });
		}
		const changes = await this._gitService.diffBetween(fileUri ?? repositoryRoot, parentCommit, commit.hash);
		if (!changes) {
			// Empty commit
			return this.cacheAndReturnCommit({ commit, repositoryRoot, overlap: 0, changedFiles: [] });
		}

		const changedFiles: vscode.ChatRelatedFile[] = [];
		for (const change of changes) {
			try {
				// Make sure the file still exists, it could have been deleted in a later commit
				await this._fileSystemService.stat(change.uri);
				filesChangedInCommit.add(change.uri);
				changedFiles.push({
					uri: change.uri,
					description: l10n.t('Previously edited together in related Git commit {0} ("{1}")', commit.hash.substring(0, 8), commit.message.split('\n')[0])
				});
			} catch { }
		}

		const overlap = chatRequest ? intersection(filesChangedInCommit, chatRequest.files).size : 0;
		return this.cacheAndReturnCommit({ commit, repositoryRoot, overlap, changedFiles });
	}

	private async indexRecentCommits(limit: number): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		await this._gitService.initialize();

		const repositories = new ResourceSet();
		for (const folder of this._workspaceService.getWorkspaceFolders()) {
			const repository = await this._gitService.getRepository(folder);
			if (repository) {
				repositories.add(repository.rootUri);
			}
		}

		for (const repositoryRoot of repositories) {
			let repoMap = this.cachedCommitsWithEmbeddingsByRepositoryRoot.get(repositoryRoot);
			if (repoMap) {
				continue;
			}
			repoMap = new Map<string, readonly [ICommitWithChanges, Embedding]>();
			this.cachedCommitsWithEmbeddingsByRepositoryRoot.set(repositoryRoot, repoMap); // Record that we already tried to index commits in this repo

			const commits = await this._gitService.log(repositoryRoot, { maxEntries: Math.round(limit / repositories.size) });
			if (!commits) {
				continue;
			}

			// Get changes
			const commitsWithChanges = await Promise.all(commits.map((commit) => this.getCommitWithChanges(commit, repositoryRoot)));

			// Get embeddings for commit messages
			const res = await this.computeCommitMessageEmbeddings(commitsWithChanges, undefined);
			if (res) {
				for (const commit of res.commitsWithEmbeddings) {
					repoMap.set(commit[0].commit.hash, commit);
				}
				this.cachedCommitsWithEmbeddingsByRepositoryRoot.set(repositoryRoot, repoMap);
			}
		}
	}
}
