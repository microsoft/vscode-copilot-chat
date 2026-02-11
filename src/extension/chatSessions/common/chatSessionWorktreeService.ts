/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { RepoContext } from '../../../platform/git/common/gitService';
import { createServiceIdentifier } from '../../../util/common/services';

export interface ChatSessionWorktreeFile {
	readonly filePath: string;
	readonly originalFilePath: string | undefined;
	readonly modifiedFilePath: string | undefined;
	readonly statistics: {
		readonly additions: number;
		readonly deletions: number;
	};
}

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
	readonly changes?: readonly ChatSessionWorktreeFile[] | undefined;
}

export type ChatSessionWorktreeProperties = ChatSessionWorktreePropertiesV1;

export const IChatSessionWorktreeService = createServiceIdentifier<IChatSessionWorktreeService>('IChatSessionWorktreeService');

export interface IChatSessionWorktreeService {
	readonly _serviceBrand: undefined;

	createWorktree(repositoryPath: vscode.Uri, stream?: vscode.ChatResponseStream): Promise<ChatSessionWorktreeProperties | undefined>;

	getWorktreeProperties(sessionId: string): ChatSessionWorktreeProperties | undefined;
	getWorktreeProperties(folder: vscode.Uri): ChatSessionWorktreeProperties | undefined;
	setWorktreeProperties(sessionId: string, properties: string | ChatSessionWorktreeProperties): Promise<void>;

	getWorktreeRepository(sessionId: string): Promise<RepoContext | undefined>;
	getWorktreePath(sessionId: string): vscode.Uri | undefined;

	applyWorktreeChanges(sessionId: string): Promise<void>;
	getWorktreeChanges(sessionId: string): Promise<readonly ChatSessionWorktreeFile[] | undefined>;

	handleRequestCompleted(sessionId: string): Promise<void>;
}
