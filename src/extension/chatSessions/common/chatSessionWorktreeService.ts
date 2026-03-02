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

interface ChatSessionWorktreeBaseProperties {
	readonly baseCommit: string;
	readonly branchName: string;
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly changes?: readonly ChatSessionWorktreeFile[] | undefined;
}

interface ChatSessionWorktreePropertiesV1 extends ChatSessionWorktreeBaseProperties {
	readonly version: 1;
	readonly autoCommit: boolean;
}

interface ChatSessionWorktreePropertiesV2 extends ChatSessionWorktreeBaseProperties {
	readonly version: 2;
	readonly baseBranchName: string;
	readonly pullRequestUrl?: string;
}

export type ChatSessionWorktreeProperties = ChatSessionWorktreePropertiesV1 | ChatSessionWorktreePropertiesV2;

export const IChatSessionWorktreeService = createServiceIdentifier<IChatSessionWorktreeService>('IChatSessionWorktreeService');

export interface IChatSessionWorktreeService {
	readonly _serviceBrand: undefined;

	createWorktree(repositoryPath: vscode.Uri, stream?: vscode.ChatResponseStream, baseBranch?: string): Promise<ChatSessionWorktreeProperties | undefined>;

	getWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties | undefined>;
	getWorktreeProperties(folder: vscode.Uri): Promise<ChatSessionWorktreeProperties | undefined>;
	setWorktreeProperties(sessionId: string, properties: string | ChatSessionWorktreeProperties): Promise<void>;

	getWorktreeRepository(sessionId: string): Promise<RepoContext | undefined>;
	getWorktreePath(sessionId: string): Promise<vscode.Uri | undefined>;

	applyWorktreeChanges(sessionId: string): Promise<void>;
	getWorktreeChanges(sessionId: string): Promise<readonly ChatSessionWorktreeFile[] | undefined>;

	getSessionIdForWorktree(folder: vscode.Uri): Promise<string | undefined>;

	handleRequestCompleted(sessionId: string): Promise<void>;
}
