/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { URI } from '../../../util/vs/base/common/uri';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';
import { AbstractReplaceStringTool } from './abstractReplaceStringTool';
import { resolveToolInputPath } from './toolUtils';

export interface IReplaceStringToolParams {
	explanation: string;
	filePath: string;
	oldString: string;
	newString: string;
}

export class ReplaceStringTool extends AbstractReplaceStringTool<IReplaceStringToolParams> {
	public static toolName = ToolName.ReplaceString;

	protected override urisForInput(input: IReplaceStringToolParams): readonly URI[] {
		return [resolveToolInputPath(input.filePath, this.promptPathRepresentationService)];
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IReplaceStringToolParams>, token: vscode.CancellationToken) {
		const prepared = await this.prepareEditsForFile(options, options.input, token);
		return this.applyAllEdits(options, [prepared], token);
	}

	protected override toolName(): ToolName {
		return ReplaceStringTool.toolName;
	}
}

ToolRegistry.registerTool(ReplaceStringTool);
