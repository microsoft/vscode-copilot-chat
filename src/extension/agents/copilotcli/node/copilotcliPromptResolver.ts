/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IIgnoreService } from '../../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../../platform/log/common/logService';
import { isLocation } from '../../../../util/common/types';
import { raceCancellation } from '../../../../util/vs/base/common/async';
import { Schemas } from '../../../../util/vs/base/common/network';
import * as path from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatReferenceBinaryData, FileType } from '../../../../vscodeTypes';
import { ChatVariablesCollection, isPromptFile, isPromptInstruction } from '../../../prompt/common/chatVariablesCollection';
import { generateUserPrompt } from '../../../prompts/node/agent/copilotCLIPrompt';

// Use dynamic import to work around ESLint restrictions
const vscodeRuntime = import('vscode');

export class CopilotCLIPromptResolver {
	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IIgnoreService private readonly ignoreService: IIgnoreService,
	) { }

	public async resolvePrompt(request: vscode.ChatRequest, token: vscode.CancellationToken): Promise<{ prompt: string; attachments: Attachment[] }> {
		if (request.prompt.startsWith('/')) {
			return { prompt: request.prompt, attachments: [] }; // likely a slash command, don't modify
		}
		const [variables, attachments, untitledFilesContext] = await this.constructChatVariablesAndAttachments(new ChatVariablesCollection(request.references), token);
		if (token.isCancellationRequested) {
			return { prompt: request.prompt, attachments: [] };
		}
		let prompt = await raceCancellation(generateUserPrompt(request, variables, this.instantiationService), token);

		// Append untitled file context to the prompt if present
		if (untitledFilesContext && prompt) {
			prompt = `${prompt}\n\n${untitledFilesContext}`;
		}

		return { prompt: prompt ?? '', attachments };
	}

	private async constructChatVariablesAndAttachments(variables: ChatVariablesCollection, token: vscode.CancellationToken): Promise<[variables: ChatVariablesCollection, Attachment[], untitledFilesContext: string | undefined]> {
		const validReferences: vscode.ChatPromptReference[] = [];
		const fileFolderReferences: vscode.ChatPromptReference[] = [];
		const untitledFileReferences: vscode.ChatPromptReference[] = [];

		for (const variable of variables) {
			// Unsupported references.
			if (isPromptInstruction(variable) || isPromptFile(variable)) {
				continue;
			}
			// Images will be attached using regular attachments via Copilot CLI SDK.
			if (variable.value instanceof ChatReferenceBinaryData) {
				continue;
			}
			if (isLocation(variable.value)) {
				validReferences.push(variable.reference);
				continue;
			}
			// Notebooks are not supported yet.
			if (URI.isUri(variable.value)) {
				if (variable.value.scheme === Schemas.vscodeNotebookCellOutput || variable.value.scheme === Schemas.vscodeNotebookCellOutput) {
					continue;
				}

				// Handle untitled files separately
				if (variable.value.scheme === 'untitled') {
					validReferences.push(variable.reference);
					untitledFileReferences.push(variable.reference);
					continue;
				}

				// Files and directories will be attached using regular attachments via Copilot CLI SDK.
				validReferences.push(variable.reference);
				fileFolderReferences.push(variable.reference);
				continue;
			}

			validReferences.push(variable.reference);
		}

		variables = new ChatVariablesCollection(validReferences);
		const attachments = await this.constructFileOrFolderAttachments(fileFolderReferences, token);
		const untitledFilesContext = await this.extractUntitledFileContent(untitledFileReferences, token);
		return [variables, attachments, untitledFilesContext];
	}


	private async constructFileOrFolderAttachments(fileOrFolderReferences: vscode.ChatPromptReference[], token: vscode.CancellationToken): Promise<Attachment[]> {
		const attachments: Attachment[] = [];
		await Promise.all(fileOrFolderReferences.map(async ref => {
			const uri = ref.value;
			if (!URI.isUri(uri)) {
				return;
			}

			// Skip untitled files - they will be handled in constructChatVariablesAndAttachments
			if (uri.scheme === 'untitled') {
				return;
			}

			if (await this.ignoreService.isCopilotIgnored(uri)) {
				return;
			}

			try {
				const stat = await raceCancellation(this.fileSystemService.stat(uri), token);
				if (!stat) {
					return;
				}
				const type = stat.type === FileType.Directory ? 'directory' : stat.type === FileType.File ? 'file' : undefined;
				if (!type) {
					this.logService.error(`[CopilotCLISession] Ignoring attachment as it's not a file/directory (${uri.fsPath})`);
					return;
				}
				attachments.push({
					type,
					displayName: ref.name || path.basename(uri.fsPath),
					path: uri.fsPath
				});
			} catch (error) {
				this.logService.error(`[CopilotCLISession] Failed to attach ${uri.fsPath}: ${error}`);
			}
		}));

		return attachments;
	}

	private async extractUntitledFileContent(untitledFileReferences: vscode.ChatPromptReference[], token: vscode.CancellationToken): Promise<string | undefined> {
		if (!untitledFileReferences || untitledFileReferences.length === 0) {
			return undefined;
		}

		const fullFileParts: string[] = [];
		const vscodeMod = await vscodeRuntime;

		for (const ref of untitledFileReferences) {
			if (!URI.isUri(ref.value) || ref.value.scheme !== 'untitled') {
				continue;
			}

			try {
				const document = await vscodeMod.workspace.openTextDocument(ref.value);
				const content = document.getText();
				fullFileParts.push(`<file-start>${ref.value.path}</file-start>`);
				fullFileParts.push(content);
				fullFileParts.push(`<file-end>${ref.value.path}</file-end>`);
			} catch (error) {
				this.logService.error(`Error reading untitled file content for reference: ${ref.value.toString()}: ${error}`);
			}
		}

		if (fullFileParts.length === 0) {
			return undefined;
		}

		return ['The user has attached the following untitled files as relevant context:', ...fullFileParts].join('\n');
	}
}
