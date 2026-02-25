/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelDataPart, LanguageModelPromptTsxPart, LanguageModelTextPart } from '../../../vscodeTypes';
import { renderDataPartToString, renderToolResultToStringNoBudget } from '../../prompt/vscode-node/requestLoggerToolResult';
import { IToolResultContentRenderer } from '../common/toolResultRenderer';

export class ToolResultContentRenderer implements IToolResultContentRenderer {
	readonly _serviceBrand: undefined;

	async renderToolResultContent(content: Iterable<unknown>): Promise<string[]> {
		const parts: string[] = [];
		for (const part of content) {
			if (part instanceof LanguageModelTextPart) {
				parts.push(part.value);
			} else if (part instanceof LanguageModelPromptTsxPart) {
				try {
					parts.push(await renderToolResultToStringNoBudget(part));
				} catch {
					parts.push(String(part.value));
				}
			} else if (part instanceof LanguageModelDataPart) {
				parts.push(renderDataPartToString(part));
			}
		}
		return parts;
	}
}
