/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptPiece } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { RelativePattern } from '../../../platform/filesystem/common/fileTypes';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { isAbsolute } from '../../../util/vs/base/common/path';
import { isEqual, normalizePath } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelToolResult, Location } from '../../../vscodeTypes';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';

export function checkCancellation(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

export async function toolTSX(insta: IInstantiationService, options: vscode.LanguageModelToolInvocationOptions<unknown>, piece: PromptPiece, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
	return new LanguageModelToolResult([
		new LanguageModelPromptTsxPart(
			await renderPromptElementJSON(insta, class extends PromptElement {
				render() {
					return piece;
				}
			}, {}, options.tokenizationOptions, token)
		)
	]);
}

export function formatUriForFileWidget(uriOrLocation: URI | Location): string {
	const uri = URI.isUri(uriOrLocation) ? uriOrLocation : uriOrLocation.uri;
	const rangePart = URI.isUri(uriOrLocation) ?
		'' :
		`#${uriOrLocation.range.start.line + 1}-${uriOrLocation.range.end.line + 1}`;

	// Empty link text -> rendered as file widget
	return `[](${uri.toString()}${rangePart})`;
}
export function inputGlobToPattern(query: string, workspaceService: IWorkspaceService): vscode.GlobPattern[] {
	let pattern: vscode.GlobPattern = query;
	if (isAbsolute(query)) {
		try {
			const relative = workspaceService.asRelativePath(query);
			if (relative !== query) {
				const workspaceFolder = workspaceService.getWorkspaceFolder(URI.file(query));
				if (workspaceFolder) {
					pattern = new RelativePattern(workspaceFolder, relative);
				}
			}
		} catch (e) {
			// ignore
		}
	}

	const patterns = [pattern];
	if (typeof pattern === 'string' && !pattern.endsWith('/**')) {
		patterns.push(pattern + '/**');
	} else if (typeof pattern !== 'string' && !pattern.pattern.endsWith('/**')) {
		patterns.push(new RelativePattern(pattern.baseUri, pattern.pattern + '/**'));
	}
	return patterns;
}

export function resolveToolInputPath(path: string, promptPathRepresentationService: IPromptPathRepresentationService): URI {
	const uri = promptPathRepresentationService.resolveFilePath(path);
	if (!uri) {
		throw new Error(`Invalid input path: ${path}. Be sure to use an absolute path.`);
	}

	return uri;
}

export async function assertFileOkForTool(accessor: ServicesAccessor, uri: URI): Promise<void> {
	const workspaceService = accessor.get(IWorkspaceService);
	const tabsAndEditorsService = accessor.get(ITabsAndEditorsService);
	const ignoreService = accessor.get(IIgnoreService);
	const promptPathRepresentationService = accessor.get(IPromptPathRepresentationService);

	if (!workspaceService.getWorkspaceFolder(normalizePath(uri))) {
		const fileOpenInSomeTab = tabsAndEditorsService.tabs.some(tab => isEqual(tab.uri, uri));
		if (!fileOpenInSomeTab) {
			throw new Error(`File ${promptPathRepresentationService.getFilePath(uri)} is outside of the workspace, and not open in an editor, and can't be read`);
		}
	}

	if (await ignoreService.isCopilotIgnored(uri)) {
		throw new Error(`File ${promptPathRepresentationService.getFilePath(uri)} is configured to be ignored by Copilot`);
	}
}