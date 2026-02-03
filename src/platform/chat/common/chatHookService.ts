/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';

export const IChatHookService = createServiceIdentifier<IChatHookService>('IChatHookService');

export interface IChatHookService {
	readonly _serviceBrand: undefined;

	/**
	 * Execute all hooks of the specified type for the current chat session.
	 * Hooks are configured in hooks.json files in the workspace.
	 *
	 * @param options Hook execution options including the hook type and input data.
	 * @param token Optional cancellation token.
	 * @returns A promise that resolves to an array of hook execution results.
	 */
	executeHook(options: vscode.ChatHookExecutionOptions, token?: vscode.CancellationToken): Promise<vscode.ChatHookResult[]>;
}
