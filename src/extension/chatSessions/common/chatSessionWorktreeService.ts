/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { RepoContext } from '../../../platform/git/common/gitService';
import { createServiceIdentifier } from '../../../util/common/services';
import { IObservable } from '../../../util/vs/base/common/observable';

export interface ChatSessionWorktreeData {
	readonly data: string;
	readonly version: number;
}

interface ChatSessionWorktreePropertiesV1 {
	readonly autoCommit: boolean;
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

	getSessionRepository(sessionId: string): RepoContext | undefined;
	setSessionRepository(sessionId: string, repositoryPath: string): Promise<void>;
	deleteSessionRepository(sessionId: string): Promise<void>;

	createWorktree(sessionId: string | undefined, stream?: vscode.ChatResponseStream): Promise<ChatSessionWorktreeProperties | undefined>;

	getWorktreeProperties(sessionId: string): ChatSessionWorktreeProperties | undefined;
	setWorktreeProperties(sessionId: string, properties: string | ChatSessionWorktreeProperties): Promise<void>;

	getWorktreeRepository(sessionId: string): Promise<RepoContext | undefined>;
	getWorktreePath(sessionId: string): vscode.Uri | undefined;

	applyWorktreeChanges(sessionId: string): Promise<void>;
	getWorktreeChanges(sessionId: string): Promise<vscode.ChatSessionChangedFile[] | undefined>;

	handleRequestCompleted(sessionId: string): Promise<void>;
}
