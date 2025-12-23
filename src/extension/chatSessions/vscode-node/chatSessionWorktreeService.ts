/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { derived, IObservable } from '../../../util/vs/base/common/observable';
import { basename } from '../../../util/vs/base/common/resources';

const CHAT_SESSION_WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';

interface ChatSessionWorktreeData {
	readonly data: string;
	readonly version: number;
}

interface ChatSessionWorktreePropertiesV1 {
	readonly baseCommit: string;
	readonly branchName: string;
	readonly repositoryPath: string;
	readonly worktreePath: string;
}

export type ChatSessionWorktreeProperties = ChatSessionWorktreePropertiesV1;

export const IChatSessionWorktreeService = createServiceIdentifier<IChatSessionWorktreeService>('IChatSessionWorktreeService');

export interface IChatSessionWorktreeService {
	readonly _serviceBrand: undefined;
	readonly isWorktreeSupportedObs: IObservable<boolean>;

	createWorktree(stream?: vscode.ChatResponseStream): Promise<ChatSessionWorktreeProperties | undefined>;

	getWorktreeProperties(sessionId: string): ChatSessionWorktreeProperties | undefined;
	setWorktreeProperties(sessionId: string, properties: string | ChatSessionWorktreeProperties): Promise<void>;

	getWorktreePath(sessionId: string): vscode.Uri | undefined;
	getWorktreeRelativePath(sessionId: string): string | undefined;
}

export class ChatSessionWorktreeService extends Disposable implements IChatSessionWorktreeService {
	declare _serviceBrand: undefined;

	readonly isWorktreeSupportedObs: IObservable<boolean>;

	private _sessionWorktrees: Map<string, string | ChatSessionWorktreeProperties> = new Map();

	constructor(
		@IGitService private readonly gitService: IGitService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.loadWorktreeProperties();

		this.isWorktreeSupportedObs = derived(reader => {
			const activeRepository = this.gitService.activeRepository.read(reader);
			return activeRepository !== undefined;
		});
	}

	private loadWorktreeProperties(): void {
		const data = this.extensionContext.globalState.get<Record<string, string | ChatSessionWorktreeData>>(CHAT_SESSION_WORKTREE_MEMENTO_KEY, {});

		for (const [key, value] of Object.entries(data)) {
			if (typeof value === 'string') {
				// Legacy worktree path
				this._sessionWorktrees.set(key, value);
			} else {
				if (value.version === 1) {
					// Worktree properties v1
					this._sessionWorktrees.set(key, JSON.parse(value.data) satisfies ChatSessionWorktreeProperties);
				} else {
					this.logService.warn(`Unsupported worktree properties version: ${value.version} for session ${key}`);
				}
			}
		}
	}

	async createWorktree(stream?: vscode.ChatResponseStream): Promise<ChatSessionWorktreeProperties | undefined> {
		if (!stream) {
			return this.tryCreateWorktree();
		}

		return new Promise<ChatSessionWorktreeProperties | undefined>((resolve) => {
			stream.progress(l10n.t('Creating isolated worktree for Background Agent session...'), async progress => {
				const result = await this.tryCreateWorktree(progress);
				resolve(result);
				if (result) {
					return l10n.t('Created isolated worktree at {0}', basename(vscode.Uri.file(result.worktreePath)));
				}
				return undefined;
			});
		});
	}

	private async tryCreateWorktree(progress?: vscode.Progress<vscode.ChatResponsePart>): Promise<ChatSessionWorktreeProperties | undefined> {
		try {
			const repository = this.gitService.activeRepository.get();
			if (!repository) {
				progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory')));
				return undefined;
			}

			const branchPrefix = vscode.workspace.getConfiguration('git').get<string>('branchPrefix') ?? '';
			const branch = `${branchPrefix}copilot-worktree-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
			const worktreePath = await this.gitService.createWorktree(repository.rootUri, { branch });
			if (worktreePath && repository.headCommitHash) {
				return {
					branchName: branch,
					baseCommit: repository.headCommitHash,
					repositoryPath: repository.rootUri.fsPath,
					worktreePath
				} satisfies ChatSessionWorktreeProperties;
			}
			progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory')));
			return undefined;
		} catch (error) {
			progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Error creating worktree for isolation: {0}', error instanceof Error ? error.message : String(error))));
			this.logService.error(error, 'Error creating worktree for isolation');
			return undefined;
		}
	}

	getWorktreeProperties(sessionId: string): ChatSessionWorktreeProperties | undefined {
		const properties = this._sessionWorktrees.get(sessionId);
		return typeof properties === 'string' ? undefined : properties;
	}

	async setWorktreeProperties(sessionId: string, properties: string | ChatSessionWorktreeProperties): Promise<void> {
		this._sessionWorktrees.set(sessionId, properties);

		const sessionWorktreesProperties = this.extensionContext.globalState.get<Record<string, string | ChatSessionWorktreeData>>(CHAT_SESSION_WORKTREE_MEMENTO_KEY, {});
		sessionWorktreesProperties[sessionId] = { data: JSON.stringify(properties), version: 1 };
		await this.extensionContext.globalState.update(CHAT_SESSION_WORKTREE_MEMENTO_KEY, sessionWorktreesProperties);
	}

	getWorktreePath(sessionId: string): vscode.Uri | undefined {
		const worktreeProperties = this._sessionWorktrees.get(sessionId);
		if (worktreeProperties === undefined) {
			return undefined;
		} else if (typeof worktreeProperties === 'string') {
			// Legacy worktree path
			return vscode.Uri.file(worktreeProperties);
		} else {
			// Worktree properties v1
			return vscode.Uri.file(worktreeProperties.worktreePath);
		}
	}

	getWorktreeRelativePath(sessionId: string): string | undefined {
		const worktreePath = this.getWorktreePath(sessionId);
		if (!worktreePath) {
			return undefined;
		}

		// TODO@rebornix, @osortega: read the workingtree name from git extension
		const lastIndex = worktreePath.fsPath.lastIndexOf('/');
		return worktreePath.fsPath.substring(lastIndex + 1);
	}
}
