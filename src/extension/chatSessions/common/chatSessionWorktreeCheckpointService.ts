/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';

export const IChatSessionWorktreeCheckpointService = createServiceIdentifier<IChatSessionWorktreeCheckpointService>('IChatSessionWorktreeCheckpointService');

export interface IChatSessionWorktreeCheckpointService {
	readonly _serviceBrand: undefined;

	handleRequest(sessionId: string): Promise<void>;
	handleRequestCompleted(sessionId: string): Promise<void>;

	getWorktreeChanges(sessionId: string): Promise<readonly vscode.ChatSessionChangedFile2[] | undefined>;
	getWorktreeCheckpointSupport(sessionId: string): Promise<boolean>;
}
