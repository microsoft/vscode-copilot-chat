/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { isScenarioAutomation } from '../../../platform/env/common/envService';
import { count } from '../../../util/vs/base/common/strings';
import { MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';
import { formatUriForFileWidget } from '../common/toolUtils';
import { AbstractReplaceStringTool, IAbstractReplaceStringInput } from './abstractReplaceStringTool';
import { AutomationResponseStream, createAutomationPromptContext } from './automationResponseStream';
import { resolveToolInputPath } from './toolUtils';

export interface IReplaceStringToolParams {
	explanation: string;
	filePath: string;
	oldString: string;
	newString: string;
}

export class ReplaceStringTool<T extends IReplaceStringToolParams = IReplaceStringToolParams> extends AbstractReplaceStringTool<T> {
	public static toolName = ToolName.ReplaceString;

	protected extractReplaceInputs(input: T): IAbstractReplaceStringInput[] {
		return [{
			filePath: input.filePath,
			oldString: input.oldString,
			newString: input.newString,
		}];
	}

	async handleToolStream(options: vscode.LanguageModelToolInvocationStreamOptions<IReplaceStringToolParams>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolStreamResult> {
		const partialInput = options.rawInput as Partial<IReplaceStringToolParams> | undefined;

		let invocationMessage: MarkdownString;
		if (partialInput && typeof partialInput === 'object') {
			const oldString = partialInput.oldString;
			const newString = partialInput.newString;
			const filePath = partialInput.filePath;

			const oldLineCount = oldString !== undefined ? count(oldString, '\n') + 1 : undefined;
			const newLineCount = newString !== undefined ? count(newString, '\n') + 1 : undefined;

			if (filePath) {
				const uri = resolveToolInputPath(filePath, this.promptPathRepresentationService);
				const fileRef = formatUriForFileWidget(uri);

				if (oldLineCount !== undefined && newLineCount !== undefined) {
					invocationMessage = new MarkdownString(l10n.t`Replacing ${oldLineCount} lines with ${newLineCount} lines in ${fileRef}`);
				} else if (oldLineCount !== undefined) {
					invocationMessage = new MarkdownString(l10n.t`Replacing ${oldLineCount} lines in ${fileRef}`);
				} else {
					invocationMessage = new MarkdownString(l10n.t`Editing ${fileRef}`);
				}
			} else {
				if (oldLineCount !== undefined && newLineCount !== undefined) {
					invocationMessage = new MarkdownString(l10n.t`Replacing ${oldLineCount} lines with ${newLineCount} lines`);
				} else if (oldLineCount !== undefined) {
					invocationMessage = new MarkdownString(l10n.t`Replacing ${oldLineCount} lines`);
				} else {
					invocationMessage = new MarkdownString(l10n.t`Editing file`);
				}
			}
		} else {
			invocationMessage = new MarkdownString(l10n.t`Editing file`);
		}

		return { invocationMessage };
	}


	async invoke(options: vscode.LanguageModelToolInvocationOptions<T>, token: vscode.CancellationToken) {
		// Automation guard: inject mock context so _promptContext is always set
		let automationStream: AutomationResponseStream | undefined;
		if (isScenarioAutomation && !this._promptContext) {
			const mock = createAutomationPromptContext();
			this._promptContext = mock.context;
			automationStream = mock.stream;
		}

		const prepared = await this.prepareEdits(options, token);
		const result = await this.applyAllEdits(options, prepared, token);

		// Flush collected edits to disk in automation mode
		if (automationStream) {
			await automationStream.applyCollectedEdits(this.workspaceService);
		}

		return result;
	}

	protected override toolName(): ToolName {
		return ReplaceStringTool.toolName;
	}
}

ToolRegistry.registerTool(ReplaceStringTool);
