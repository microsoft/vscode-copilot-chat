/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptPiece } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICustomInstructionsService, IInstructionIndexFile } from '../../../platform/customInstructions/common/customInstructionsService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { RelativePattern } from '../../../platform/filesystem/common/fileTypes';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Schemas } from '../../../util/vs/base/common/network';
import { isAbsolute } from '../../../util/vs/base/common/path';
import { extUriBiasedIgnorePathCase, isEqual, normalizePath } from '../../../util/vs/base/common/resources';
import { isString } from '../../../util/vs/base/common/types';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { isPromptInstructionText } from '../../prompt/common/chatVariablesCollection';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { IChatDiskSessionResources } from '../../prompts/common/chatDiskSessionResources';
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

/**
 * Converts a user input glob or file path into a VS Code glob pattern or RelativePattern.
 *
 * @param query The user input glob or file path.
 * @param workspaceService The workspace service used to resolve relative paths.
 * @param modelFamily The language model family (e.g., 'gpt-4.1'). If set to 'gpt-4.1', a workaround is applied:
 *   GPT-4.1 struggles to append '/**' to patterns, so this function adds an additional pattern with '/**' appended.
 *   Other models do not require this workaround.
 * @returns An array of glob patterns suitable for use in file matching.
 */
export function inputGlobToPattern(query: string, workspaceService: IWorkspaceService, modelFamily: string | undefined): vscode.GlobPattern[] {
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

	// For gpt-4.1, it struggles to append /** to the pattern itself, so here we work around it by
	// adding a second pattern with /** appended.
	// Other models are smart enough to append the /** suffix so they don't need this workaround.
	if (modelFamily === 'gpt-4.1') {
		if (typeof pattern === 'string' && !pattern.endsWith('/**')) {
			patterns.push(pattern + '/**');
		} else if (typeof pattern !== 'string' && !pattern.pattern.endsWith('/**')) {
			patterns.push(new RelativePattern(pattern.baseUri, pattern.pattern + '/**'));
		}
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

export async function isFileOkForTool(accessor: ServicesAccessor, uri: URI, buildPromptContext?: IBuildPromptContext): Promise<boolean> {
	try {
		await assertFileOkForTool(accessor, uri, buildPromptContext);
		return true;
	} catch {
		return false;
	}
}

export interface AssertFileOkForToolOptions {
	readOnly?: boolean;
}

export async function assertFileOkForTool(accessor: ServicesAccessor, uri: URI, buildPromptContext?: IBuildPromptContext, options?: AssertFileOkForToolOptions): Promise<void> {
	const workspaceService = accessor.get(IWorkspaceService);
	const tabsAndEditorsService = accessor.get(ITabsAndEditorsService);
	const promptPathRepresentationService = accessor.get(IPromptPathRepresentationService);
	const customInstructionsService = accessor.get(ICustomInstructionsService);
	const diskSessionResources = accessor.get(IChatDiskSessionResources);
	const configurationService = accessor.get(IConfigurationService);

	await assertFileNotContentExcluded(accessor, uri);

	const normalizedUri = normalizePath(uri);
	if (workspaceService.getWorkspaceFolder(normalizedUri)) {
		return;
	}
	if (options?.readOnly && isUriUnderAdditionalReadAccessPaths(normalizedUri, configurationService)) {
		return;
	}
	if (uri.scheme === Schemas.untitled) {
		return;
	}
	const fileOpenInSomeTab = tabsAndEditorsService.tabs.some(tab => isEqual(tab.uri, uri));
	if (fileOpenInSomeTab) {
		return;
	}
	if (diskSessionResources.isSessionResourceUri(normalizedUri)) {
		return;
	}
	if (buildPromptContext) {
		const instructionIndexFile = getInstructionsIndexFile(buildPromptContext, customInstructionsService);
		if (instructionIndexFile) {
			if (instructionIndexFile.instructions.has(normalizedUri) || instructionIndexFile.skills.has(normalizedUri)) {
				return;
			}
			// Check if the URI is under any skill folder (e.g., nested files like primitives/agents.md)
			for (const skillFolderUri of instructionIndexFile.skillFolders) {
				if (extUriBiasedIgnorePathCase.isEqualOrParent(normalizedUri, skillFolderUri)) {
					return;
				}
			}
		}
	} else {
		if (await customInstructionsService.isExternalInstructionsFile(normalizedUri)) {
			return;
		}
	}
	throw new Error(`File ${promptPathRepresentationService.getFilePath(normalizedUri)} is outside of the workspace, and not open in an editor, and can't be read`);
}

let cachedInstructionIndexFile: { requestId: string; file: IInstructionIndexFile } | undefined;

function getInstructionsIndexFile(buildPromptContext: IBuildPromptContext, customInstructionsService: ICustomInstructionsService): IInstructionIndexFile | undefined {
	if (!buildPromptContext.requestId) {
		return undefined;
	}

	if (cachedInstructionIndexFile?.requestId === buildPromptContext.requestId) {
		return cachedInstructionIndexFile.file;
	}

	const indexVariable = buildPromptContext.chatVariables.find(isPromptInstructionText);
	if (indexVariable && isString(indexVariable.value)) {
		const indexFile = customInstructionsService.parseInstructionIndexFile(indexVariable.value);
		cachedInstructionIndexFile = { requestId: buildPromptContext.requestId, file: indexFile };
		return indexFile;
	}
	cachedInstructionIndexFile = undefined;
	return undefined;

}

export async function assertFileNotContentExcluded(accessor: ServicesAccessor, uri: URI): Promise<void> {
	const ignoreService = accessor.get(IIgnoreService);
	const promptPathRepresentationService = accessor.get(IPromptPathRepresentationService);

	if (await ignoreService.isCopilotIgnored(uri)) {
		throw new Error(`File ${promptPathRepresentationService.getFilePath(uri)} is configured to be ignored by Copilot`);
	}
}

export async function isFileExternalAndNeedsConfirmation(accessor: ServicesAccessor, uri: URI, options?: { readOnly?: boolean }): Promise<boolean> {
	const workspaceService = accessor.get(IWorkspaceService);
	const tabsAndEditorsService = accessor.get(ITabsAndEditorsService);
	const customInstructionsService = accessor.get(ICustomInstructionsService);
	const diskSessionResources = accessor.get(IChatDiskSessionResources);
	const configurationService = accessor.get(IConfigurationService);
	const fileSystemService = accessor.get(IFileSystemService);

	const normalizedUri = normalizePath(uri);

	// Not external if: in workspace, untitled, instructions file, session resource, or open in editor
	if (workspaceService.getWorkspaceFolder(normalizedUri)) {
		return false;
	}
	if (options?.readOnly && isUriUnderAdditionalReadAccessPaths(normalizedUri, configurationService)) {
		return false;
	}
	if (uri.scheme === Schemas.untitled || uri.scheme === 'vscode-chat-response-resource') {
		return false;
	}
	if (await customInstructionsService.isExternalInstructionsFile(normalizedUri)) {
		return false;
	}
	if (diskSessionResources.isSessionResourceUri(normalizedUri)) {
		return false;
	}
	if (tabsAndEditorsService.tabs.some(tab => isEqual(tab.uri, uri))) {
		return false;
	}

	// At this point, getWorkspaceFolder() returned undefined, which could mean:
	// 1. The file is genuinely external to the workspace
	// 2. The file is within workspace folder structure but doesn't exist (path normalization issue)
	//
	// To distinguish between these cases, we check if the file exists.
	// If it doesn't exist, we treat it as "not external" so that:
	// - No confusing confirmation dialog is shown
	// - The actual tool invocation will fail with a proper "file not found" error
	//
	// This fixes the issue where non-existent workspace files (e.g., /workspace/.loop/file.md)
	// were incorrectly treated as external and prompted for confirmation.
	const fileExists = await fileSystemService.stat(normalizedUri).then(() => true).catch(() => false);
	if (!fileExists) {
		return false;
	}

	return true;
}

export function isDirExternalAndNeedsConfirmation(accessor: ServicesAccessor, uri: URI, buildPromptContext?: IBuildPromptContext, options?: { readOnly?: boolean }): boolean {
	const workspaceService = accessor.get(IWorkspaceService);
	const customInstructionsService = accessor.get(ICustomInstructionsService);
	const configurationService = accessor.get(IConfigurationService);

	const normalizedUri = normalizePath(uri);

	// Not external if: in workspace or external instructions folder
	if (workspaceService.getWorkspaceFolder(normalizedUri)) {
		return false;
	}
	if (options?.readOnly && isUriUnderAdditionalReadAccessPaths(normalizedUri, configurationService)) {
		return false;
	}
	if (buildPromptContext) {
		const instructionIndexFile = getInstructionsIndexFile(buildPromptContext, customInstructionsService);
		if (instructionIndexFile && instructionIndexFile.skillFolders.has(normalizedUri)) {
			return false;
		}
	} else {
		if (customInstructionsService.isExternalInstructionsFolder(normalizedUri)) {
			return false;
		}
	}
	return true;
}

function isUriUnderAdditionalReadAccessPaths(uri: URI, configurationService: IConfigurationService): boolean {
	const paths = configurationService.getConfig(ConfigKey.AdditionalReadAccessPaths);
	for (const p of paths) {
		const folderUri = normalizePath(URI.file(p));
		if (extUriBiasedIgnorePathCase.isEqualOrParent(uri, folderUri)) {
			return true;
		}
	}
	return false;
}
