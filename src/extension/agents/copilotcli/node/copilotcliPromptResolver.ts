/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { isLocation } from '../../../../util/common/types';
import { raceCancellationError } from '../../../../util/vs/base/common/async';
import * as path from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatReferenceDiagnostic, FileType } from '../../../../vscodeTypes';

export class CopilotCLIPromptResolver {
	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) { }

	public async resolvePrompt(request: vscode.ChatRequest, token: vscode.CancellationToken): Promise<{ prompt: string; attachments: Attachment[] }> {
		if (request.prompt.startsWith('/')) {
			return { prompt: request.prompt, attachments: [] }; // likely a slash command, don't modify
		}

		const attachments: Attachment[] = [];
		const allRefsTexts: string[] = [];
		const diagnosticTexts: string[] = [];
		const files: { path: string; name: string }[] = [];
		// TODO@rebornix: filter out implicit references for now. Will need to figure out how to support `<reminder>` without poluting user prompt
		request.references.filter(ref => !ref.id.startsWith('vscode.prompt.instructions')).forEach(ref => {
			if (ref.value instanceof ChatReferenceDiagnostic) {
				// Handle diagnostic reference
				for (const [uri, diagnostics] of ref.value.diagnostics) {
					if (uri.scheme !== 'file') {
						continue;
					}
					for (const diagnostic of diagnostics) {
						const severityMap: { [key: number]: string } = {
							0: 'error',
							1: 'warning',
							2: 'info',
							3: 'hint'
						};
						const severity = severityMap[diagnostic.severity] ?? 'error';
						const code = (typeof diagnostic.code === 'object' && diagnostic.code !== null) ? diagnostic.code.value : diagnostic.code;
						const codeStr = code ? ` [${code}]` : '';
						const line = diagnostic.range.start.line + 1;
						diagnosticTexts.push(`- ${severity}${codeStr} at ${uri.fsPath}:${line}: ${diagnostic.message}`);
						files.push({ path: uri.fsPath, name: path.basename(uri.fsPath) });
					}
				}
			} else {
				const uri = URI.isUri(ref.value) ? ref.value : isLocation(ref.value) ? ref.value.uri : undefined;
				if (!uri || uri.scheme !== 'file') {
					return;
				}
				const filePath = uri.fsPath;
				files.push({ path: filePath, name: ref.name || path.basename(filePath) });
				const valueText = URI.isUri(ref.value) ?
					ref.value.fsPath :
					isLocation(ref.value) ?
						`${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}` :
						undefined;
				if (valueText && ref.range) {
					// Keep the original prompt untouched, just collect resolved paths
					const variableText = request.prompt.substring(ref.range[0], ref.range[1]);
					allRefsTexts.push(`- ${variableText} → ${valueText}`);
				}
			}
		});

		await Promise.all(files.map(async (file) => {
			try {
				const stat = await raceCancellationError(this.fileSystemService.stat(URI.file(file.path)), token);
				const type = stat.type === FileType.Directory ? 'directory' : stat.type === FileType.File ? 'file' : undefined;
				if (!type) {
					this.logService.error(`[CopilotCLIAgentManager] Ignoring attachment as its not a file/directory (${file.path})`);
					return;
				}
				attachments.push({
					type,
					displayName: file.name,
					path: file.path
				});
			} catch (error) {
				this.logService.error(`[CopilotCLIAgentManager] Failed to attach ${file.path}: ${error}`);
			}
		}));

		const reminderParts: string[] = [];
		if (allRefsTexts.length > 0) {
			reminderParts.push(`The user provided the following references:\n${allRefsTexts.join('\n')}`);
		}
		if (diagnosticTexts.length > 0) {
			reminderParts.push(`The user provided the following diagnostics:\n${diagnosticTexts.join('\n')}`);
		}

		let prompt = request.prompt;
		if (reminderParts.length > 0) {
			prompt = `<reminder>\n${reminderParts.join('\n\n')}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</reminder>\n\n${prompt}`;
		}

		return { prompt, attachments };
	}
}
