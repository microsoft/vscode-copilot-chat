/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { createDirectoryIfNotExists, IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { URI } from '../../../util/vs/base/common/uri';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

/**
 * Parameters for the vscode_commit_memory tool.
 */
export interface IVSCodeCommitMemoryParams {
	subject: string;
	fact: string;
	citations: string;
	reason: string;
	category: string;
	suggestedContext?: string;
}

/**
 * Memory entry format stored in JSON files.
 */
interface MemoryEntry {
	subject: string;
	fact: string;
	citations: string;
	reason: string;
	category: string;
	suggestedContext?: string;
	timestamp: string;
	id: string;
}

interface MemoryResult {
	success?: string;
	error?: string;
}

/**
 * Tool for committing memory to local .github/pending-memories/ directory.
 * This tool stores memories as JSON files that can be reviewed and integrated
 * into instruction files, hooks, skills, etc. with LLM assistance.
 */
class VSCodeCommitMemoryTool implements ICopilotTool<IVSCodeCommitMemoryParams> {
	public static readonly toolName = ToolName.VSCodeCommitMemory;

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IGitService private readonly gitService: IGitService,
		@ILogService private readonly logService: ILogService
	) { }

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IVSCodeCommitMemoryParams>, _token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: l10n.t`Committing memory to workspace`,
			pastTenseMessage: l10n.t`Committed memory to workspace`
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IVSCodeCommitMemoryParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const params = options.input;
		const result = await this._commitMemory(params);

		const resultText = result.error
			? `Error: ${result.error}`
			: result.success || '';

		return new LanguageModelToolResult([
			new LanguageModelTextPart(resultText)
		]);
	}

	/**
	 * Commit a memory to the .github/pending-memories/ directory.
	 */
	private async _commitMemory(params: IVSCodeCommitMemoryParams): Promise<MemoryResult> {
		try {
			// Get the workspace folder (prefer git root if available)
			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			if (!workspaceFolders || workspaceFolders.length === 0) {
				return { error: 'No workspace folder found. Please open a workspace to commit memory.' };
			}

			// Try to find git root, fall back to first workspace folder
			let targetFolder = workspaceFolders[0];
			try {
				const repo = await this.gitService.getRepository(targetFolder);
				if (repo?.rootUri) {
					targetFolder = repo.rootUri;
				}
			} catch (error) {
				this.logService.debug(`[VSCodeCommitMemoryTool] Could not get git repository, using workspace folder: ${error}`);
			}

			// Create the pending-memories directory
			const memoriesDir = URI.joinPath(targetFolder, '.github', 'pending-memories');
			await createDirectoryIfNotExists(this.fileSystemService, memoriesDir);

			// Generate unique ID and filename
			const id = generateUuid();
			const timestamp = new Date().toISOString();
			const filename = `memory-${Date.now()}-${id.substring(0, 8)}.json`;
			const filePath = URI.joinPath(memoriesDir, filename);

			// Create memory entry
			const entry: MemoryEntry = {
				subject: params.subject,
				fact: params.fact,
				citations: params.citations,
				reason: params.reason,
				category: params.category,
				suggestedContext: params.suggestedContext,
				timestamp,
				id
			};

			// Write to file
			const content = JSON.stringify(entry, null, 2);
			await this.fileSystemService.writeFile(filePath, new TextEncoder().encode(content));

			this.logService.info(`[VSCodeCommitMemoryTool] Committed memory to ${filePath.fsPath}`);

			return {
				success: `Successfully committed memory "${params.subject}" to ${filename}. This memory can be reviewed and integrated into instruction files, hooks, or skills.`
			};
		} catch (error) {
			this.logService.error(`[VSCodeCommitMemoryTool] Failed to commit memory: ${error}`);
			return { error: `Cannot commit memory: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
}

ToolRegistry.registerTool(VSCodeCommitMemoryTool);
