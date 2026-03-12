/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { isScenarioAutomation } from '../../../platform/env/common/envService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { LanguageModelToolResult } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ICopilotTool } from '../common/toolsRegistry';
import { AutomationResponseStream, createAutomationPromptContext } from './automationResponseStream';

/**
 * Template-method base class that owns the automation guard for headless
 * (scenario-automation) mode.  Subclasses implement {@link doInvoke} with
 * their pure editing logic and never reference automation concepts.
 *
 * Class hierarchy:
 * ```
 * AbstractEditTool<T>
 *   ├── AbstractReplaceStringTool<T>
 *   │     ├── ReplaceStringTool
 *   │     └── MultiReplaceStringTool
 *   ├── ApplyPatchTool
 *   └── CreateFileTool
 * ```
 */
export abstract class AbstractEditTool<T> implements ICopilotTool<T> {
	protected _promptContext: IBuildPromptContext | undefined;

	protected abstract readonly workspaceService: IWorkspaceService;

	async resolveInput(input: T, promptContext: IBuildPromptContext): Promise<T> {
		this._promptContext = promptContext;
		return input;
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<T>,
		token: vscode.CancellationToken,
	): Promise<LanguageModelToolResult> {
		let automationStream: AutomationResponseStream | undefined;
		if (isScenarioAutomation && !this._promptContext) {
			const mock = createAutomationPromptContext();
			this._promptContext = mock.context;
			automationStream = mock.stream;
		}

		const result = await this.doInvoke(options, token);

		if (automationStream) {
			await automationStream.applyCollectedEdits(this.workspaceService);
		}

		return result;
	}

	protected abstract doInvoke(
		options: vscode.LanguageModelToolInvocationOptions<T>,
		token: vscode.CancellationToken,
	): Promise<LanguageModelToolResult>;
}
