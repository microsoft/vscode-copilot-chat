/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatLanguageModelToolReference, ChatPromptReference } from 'vscode';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { createFencedCodeBlock } from '../../../util/common/markdown';
import { isEqual } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IPromptVariablesService } from '../node/promptVariablesService';

export class PromptVariablesServiceImpl implements IPromptVariablesService {

	declare readonly _serviceBrand: undefined;

	private _fsService: IFileSystemService;
	private _workspaceService: IWorkspaceService;

	constructor(
		@IFileSystemService fsService: IFileSystemService,
		@IWorkspaceService workspaceService: IWorkspaceService,
	) {
		this._fsService = fsService;
		this._workspaceService = workspaceService;
	}

	async resolveVariablesInPrompt(message: string, variables: ChatPromptReference[]): Promise<{ message: string }> {
		for (const variable of variables) {
			let variableValue = variable.value;
			if (URI.isUri(variableValue)) {
				// check if the variableValue is already opened as Text Document
				const openedTextDocument = this._workspaceService.textDocuments.find(doc => isEqual(doc.uri, variableValue as URI));
				const fileContents = (openedTextDocument?.getText() ?? (await this._fsService.readFile(variableValue)).toString())
					.replace(/\r/g, ''); // Normalize newlines
				variableValue = createFencedCodeBlock('', fileContents);
			}

			if (variable.range) {
				message = message.slice(0, variable.range[0]) + `[#${variable.name}](#${variable.name}-context)` + message.slice(variable.range[1]);
			}
		}

		return { message };
	}

	async resolveToolReferencesInPrompt(message: string, toolReferences: ChatLanguageModelToolReference[]): Promise<string> {
		// It's part of the extension API contract that these are in reverse order by range
		let toolReferencesWithRange = toolReferences.filter(tr => !!tr.range) as Required<ChatLanguageModelToolReference>[];
		toolReferencesWithRange = toolReferencesWithRange.sort((a, b) => b.range[0] - a.range[0]);

		let previousRange: [start: number, end: number] | undefined;
		for (const toolReference of toolReferencesWithRange) {
			// Tool sets are passed as all the tools as references with the same ranges. For now, just ignore tool references that have the same range.
			// The tools are soreted by range, so we only need to look at the previous one.
			const range = toolReference.range;
			if (previousRange && range[0] === previousRange[0] && range[1] === previousRange[1]) {
				continue;
			}
			message = message.slice(0, toolReference.range[0]) + `#${toolReference.name}` + message.slice(toolReference.range[1]);
			previousRange = range;
		}
		return message;
	}
}
