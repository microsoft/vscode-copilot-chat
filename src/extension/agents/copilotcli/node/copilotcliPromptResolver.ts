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
import { ChatVariablesCollection, isPromptInstruction } from '../../../prompt/common/chatVariablesCollection';
import { generateUserPrompt } from '../../../prompts/node/agent/copilotCLIPrompt';

export class CopilotCLIPromptResolver {
	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IIgnoreService private readonly ignoreService: IIgnoreService,
	) { }

	/**
	 * Generates the final prompt for the Copilot CLI agent, resolving variables and preparing attachments.
	 * @param request
	 * @param prompt Provide a prompt to override the request prompt
	 * @param additionalReferences
	 * @param token
	 * @returns
	 */
	public async resolvePrompt(request: vscode.ChatRequest, prompt: string | undefined, additionalReferences: vscode.ChatPromptReference[], token: vscode.CancellationToken): Promise<{ prompt: string; attachments: Attachment[] }> {
		const references = request.references.concat(additionalReferences);
		prompt = prompt ?? request.prompt;
		if (prompt.startsWith('/')) {
			return { prompt, attachments: [] }; // likely a slash command, don't modify
		}
		const [variables, attachments] = await this.constructChatVariablesAndAttachments(new ChatVariablesCollection(references), token);
		if (token.isCancellationRequested) {
			return { prompt, attachments: [] };
		}
		prompt = await raceCancellation(generateUserPrompt(request, prompt, variables, this.instantiationService), token);
		return { prompt: prompt ?? '', attachments };
	}

	private async constructChatVariablesAndAttachments(variables: ChatVariablesCollection, token: vscode.CancellationToken): Promise<[variables: ChatVariablesCollection, Attachment[]]> {
		const validReferences: vscode.ChatPromptReference[] = [];
		const fileFolderReferences: vscode.ChatPromptReference[] = [];
		await Promise.all(Array.from(variables).map(async variable => {
			// Unsupported references.
			if (isPromptInstruction(variable)) {
				return;
			}
			// Images will be attached using regular attachments via Copilot CLI SDK.
			if (variable.value instanceof ChatReferenceBinaryData) {
				return;
			}
			if (isLocation(variable.value)) {
				validReferences.push(variable.reference);
				return;
			}
			// Notebooks are not supported yet.
			if (URI.isUri(variable.value)) {
				if (await this.ignoreService.isCopilotIgnored(variable.value)) {
					return;
				}
				if (variable.value.scheme === Schemas.vscodeNotebookCellOutput || variable.value.scheme === Schemas.vscodeNotebookCellOutput) {
					return;
				}

				// Files and directories will be attached using regular attachments via Copilot CLI SDK.
				validReferences.push(variable.reference);
				fileFolderReferences.push(variable.reference);
				return;
			}

			validReferences.push(variable.reference);
		}));

		variables = new ChatVariablesCollection(validReferences);
		const attachments = await this.constructFileOrFolderAttachments(fileFolderReferences, token);
		return [variables, attachments];
	}


	private async constructFileOrFolderAttachments(fileOrFolderReferences: vscode.ChatPromptReference[], token: vscode.CancellationToken): Promise<Attachment[]> {
		const attachments: Attachment[] = [];
		await Promise.all(fileOrFolderReferences.map(async ref => {
			const uri = ref.value;
			if (!URI.isUri(uri)) {
				return;
			}
			// Attachment of Source control items.
			if (uri.scheme === 'scm-history-item') {
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
}
