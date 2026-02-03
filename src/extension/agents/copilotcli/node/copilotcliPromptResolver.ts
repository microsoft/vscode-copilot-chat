/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IIgnoreService } from '../../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { isLocation, toLocation } from '../../../../util/common/types';
import { raceCancellation } from '../../../../util/vs/base/common/async';
import { Schemas } from '../../../../util/vs/base/common/network';
import * as path from '../../../../util/vs/base/common/path';
import { relativePath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatReferenceBinaryData, ChatReferenceDiagnostic, FileType, Location } from '../../../../vscodeTypes';
import { ChatVariablesCollection, isPromptInstruction, PromptVariable } from '../../../prompt/common/chatVariablesCollection';
import { generateUserPrompt } from '../../../prompts/node/agent/copilotCLIPrompt';
import { ICopilotCLIImageSupport, isImageMimeType } from './copilotCLIImageSupport';

export class CopilotCLIPromptResolver {
	constructor(
		@ICopilotCLIImageSupport private readonly imageSupport: ICopilotCLIImageSupport,
		@ILogService private readonly logService: ILogService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IIgnoreService private readonly ignoreService: IIgnoreService,
	) { }

	/**
	 * Generates the final prompt for the Copilot CLI agent, resolving variables and preparing attachments.
	 * @param prompt Provide a prompt to override the request prompt
	 */
	public async resolvePrompt(request: vscode.ChatRequest, prompt: string | undefined, additionalReferences: vscode.ChatPromptReference[], isIsolationEnabled: boolean, workingDirectory: vscode.Uri | undefined, token: vscode.CancellationToken): Promise<{ prompt: string; attachments: Attachment[]; references: vscode.ChatPromptReference[] }> {
		const allReferences = request.references.concat(additionalReferences.filter(ref => !request.references.includes(ref)));
		prompt = prompt ?? request.prompt;
		if (prompt.startsWith('/')) {
			return { prompt, attachments: [], references: [] }; // likely a slash command, don't modify
		}
		const [variables, attachments] = await this.constructChatVariablesAndAttachments(new ChatVariablesCollection(allReferences), isIsolationEnabled, workingDirectory, token);
		if (token.isCancellationRequested) {
			return { prompt, attachments: [], references: [] };
		}
		prompt = await raceCancellation(generateUserPrompt(request, prompt, variables, this.instantiationService), token);
		const references = Array.from(variables).map(v => v.reference);
		return { prompt: prompt ?? '', attachments, references };
	}

	private async constructChatVariablesAndAttachments(variables: ChatVariablesCollection, isIsolationEnabled: boolean, workingDirectory: vscode.Uri | undefined, token: vscode.CancellationToken): Promise<[variables: ChatVariablesCollection, Attachment[]]> {
		const validReferences: vscode.ChatPromptReference[] = [];
		const fileFolderReferences: vscode.ChatPromptReference[] = [];
		await Promise.all(Array.from(variables).map(async variable => {
			// Unsupported references.
			if (isPromptInstruction(variable)) {
				return;
			}
			// If isolation is enabled, and we have workspace repo information, skip it.
			if (isIsolationEnabled && isWorkspaceRepoInformationItem(variable)) {
				return;
			}
			const variableRef = await this.translateWorkspaceRefToWorkingDirectoryRef(variable.reference, isIsolationEnabled, workingDirectory, token);
			// Images will be attached using regular attachments via Copilot CLI SDK.
			if (variableRef.value instanceof ChatReferenceBinaryData) {
				if (!isImageMimeType(variableRef.value.mimeType)) {
					validReferences.push(variableRef);
				}
				fileFolderReferences.push(variableRef);
				return;
			}
			if (isLocation(variableRef.value)) {
				validReferences.push(variableRef);
				return;
			}
			// Notebooks are not supported yet.
			if (URI.isUri(variableRef.value)) {
				if (await this.ignoreService.isCopilotIgnored(variableRef.value)) {
					return;
				}
				if (variableRef.value.scheme === Schemas.vscodeNotebookCellOutput || variableRef.value.scheme === Schemas.vscodeNotebookCellOutput) {
					return;
				}

				// Files and directories will be attached using regular attachments via Copilot CLI SDK.
				validReferences.push(variableRef);
				fileFolderReferences.push(variableRef);
				return;
			}

			validReferences.push(variableRef);
		}));

		const [attachments, imageAttachments] = await this.constructFileOrFolderAttachments(fileFolderReferences, token);
		// Re-add the images after we've copied them to the image store.
		imageAttachments.forEach(img => {
			if (img.type === 'file') {
				validReferences.push({
					name: img.displayName,
					value: URI.file(img.path),
					id: img.path,
				});
			}
		});
		variables = new ChatVariablesCollection(validReferences);
		return [variables, attachments];
	}


	private async constructFileOrFolderAttachments(fileOrFolderReferences: vscode.ChatPromptReference[], token: vscode.CancellationToken): Promise<[Attachment[], image: Attachment[]]> {
		const attachments: Attachment[] = [];
		const images: Attachment[] = [];
		await Promise.all(fileOrFolderReferences.map(async ref => {
			if (ref.value instanceof ChatReferenceBinaryData) {
				if (!isImageMimeType(ref.value.mimeType)) {
					return;
				}
				// Handle image attachments
				try {
					const buffer = await ref.value.data();
					const uri = await this.imageSupport.storeImage(buffer, ref.value.mimeType);
					attachments.push({
						type: 'file',
						displayName: ref.name,
						path: uri.fsPath
					});
					images.push({
						type: 'file',
						displayName: ref.name,
						path: uri.fsPath
					});
				} catch (error) {
					this.logService.error(`[CopilotCLISession] Failed to store image: ${error}`);
				}
				return;
			}

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

		return [attachments, images];
	}

	private async translateWorkspaceRefToWorkingDirectoryRef(ref: vscode.ChatPromptReference, isIsolationEnabled: boolean, workingDirectory: vscode.Uri | undefined, token: vscode.CancellationToken): Promise<vscode.ChatPromptReference> {
		try {
			if (!isIsolationEnabled || !workingDirectory || ref.value instanceof ChatReferenceBinaryData) {
				return ref;
			}

			if (isLocation(ref.value)) {
				const uri = await this.translateWorkspaceUriToWorkingDirectoryUri(ref.value.uri, workingDirectory, token);
				const loc = new Location(uri, toLocation(ref.value)!.range);
				return {
					...ref,
					value: loc
				};
			} else if (URI.isUri(ref.value)) {
				const uri = await this.translateWorkspaceUriToWorkingDirectoryUri(ref.value, workingDirectory, token);
				return {
					...ref,
					value: uri
				};
			} else if (ref.value instanceof ChatReferenceDiagnostic) {
				const diagnostics = await Promise.all(ref.value.diagnostics.map(async ([uri, diags]) => {
					const translatedUri = await this.translateWorkspaceUriToWorkingDirectoryUri(uri, workingDirectory, token);
					return [translatedUri, diags] as [vscode.Uri, vscode.Diagnostic[]];
				}));
				return {
					...ref,
					value: new ChatReferenceDiagnostic(diagnostics)
				};
			}
			return ref;
		} catch (error) {
			this.logService.error(error, `[CopilotCLISession] Failed to translate workspace reference`);
			return ref;
		}
	}

	private async translateWorkspaceUriToWorkingDirectoryUri(uri: vscode.Uri, workingDirectory: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.Uri> {
		const workspaceFolder = this.workspaceService.getWorkspaceFolder(uri);
		if (!workspaceFolder) {
			return uri;
		}
		const rel = relativePath(workspaceFolder, uri);
		if (!rel) {
			return uri;
		}
		const segments = rel.split('/');
		const candidate = URI.joinPath(workingDirectory, ...segments);
		const candidateStat = await raceCancellation(this.fileSystemService.stat(candidate), token).catch(() => undefined);
		return candidateStat ? candidate : uri;
	}
}

/**
 * Never include this variable in Copilot CLI prompts when using git worktrees (isolation).
 * This causes issues as the repository information will not match the worktree state.
 * https://github.com/microsoft/vscode/issues/279865
 */
function isWorkspaceRepoInformationItem(variable: PromptVariable): boolean {
	const ref = variable.reference;
	if (typeof ref.value !== 'string') {
		return false;
	}
	if (!ref.modelDescription) {
		return false;
	}
	return (
		(ref.modelDescription).startsWith('Information about one of the current repositories') || (ref.modelDescription).startsWith('Information about the current repository'))
		&&
		ref.value.startsWith('Repository name:');
}
