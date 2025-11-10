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
import { ResourceSet } from '../../../../util/vs/base/common/map';
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
		const attachedFiles = new ResourceSet();
		// TODO@rebornix: filter out implicit references for now. Will need to figure out how to support `<reminder>` without poluting user prompt
		request.references.forEach(ref => {
			if (shouldExcludeReference(ref)) {
				return;
			}
			if (collectDiagnosticContent(ref.value, diagnosticTexts, files)) {
				return;
			}
			const uri = URI.isUri(ref.value) ? ref.value : isLocation(ref.value) ? ref.value.uri : undefined;
			if (!uri || uri.scheme !== 'file') {
				return;
			}
			const filePath = uri.fsPath;
			if (!attachedFiles.has(uri)) {
				attachedFiles.add(uri);
				files.push({ path: filePath, name: ref.name || path.basename(filePath) });
			}
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

function shouldExcludeReference(ref: vscode.ChatPromptReference): boolean {
	return ref.id.startsWith('vscode.prompt.instructions');
}

function collectDiagnosticContent(value: unknown, diagnosticTexts: string[], files: { path: string; name: string }[]): boolean {
	const attachedFiles = new ResourceSet();
	const diagnosticCollection = getChatReferenceDiagnostics(value);
	if (!diagnosticCollection.length) {
		return false;
	}

	let hasDiagnostics = false;
	// Handle diagnostic reference
	for (const [uri, diagnostics] of diagnosticCollection) {
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
			hasDiagnostics = true;
			if (!attachedFiles.has(uri)) {
				attachedFiles.add(uri);
				files.push({ path: uri.fsPath, name: path.basename(uri.fsPath) });
			}
		}
	}
	return hasDiagnostics;
}

function getChatReferenceDiagnostics(value: unknown): [vscode.Uri, readonly vscode.Diagnostic[]][] {
	if (isChatReferenceDiagnostic(value)) {
		return Array.from(value.diagnostics.values());
	}
	if (isDiagnosticCollection(value)) {
		const result: [vscode.Uri, readonly vscode.Diagnostic[]][] = [];
		value.forEach((uri, diagnostics) => {
			result.push([uri, diagnostics]);
		});
		return result;
	}
	return [];
}
function isChatReferenceDiagnostic(value: unknown): value is ChatReferenceDiagnostic {
	if (value instanceof ChatReferenceDiagnostic) {
		return true;
	}

	const possibleDiag = value as ChatReferenceDiagnostic;
	if (possibleDiag.diagnostics && Array.isArray(possibleDiag.diagnostics)) {
		return true;
	}
	return false;
}

function isDiagnosticCollection(value: unknown): value is vscode.DiagnosticCollection {
	const possibleDiag = value as vscode.DiagnosticCollection;
	if (possibleDiag.clear && typeof possibleDiag.clear === 'function' &&
		possibleDiag.delete && typeof possibleDiag.delete === 'function' &&
		possibleDiag.get && typeof possibleDiag.get === 'function' &&
		possibleDiag.set && typeof possibleDiag.set === 'function' &&
		possibleDiag.forEach && typeof possibleDiag.forEach === 'function') {
		return true;
	}

	return false;
}
