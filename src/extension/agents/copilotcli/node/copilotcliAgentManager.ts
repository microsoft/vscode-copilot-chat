/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, ModelProvider } from '@github/copilot/sdk';
import * as fs from 'fs/promises';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { isLocation } from '../../../../util/common/types';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatReferenceDiagnostic } from '../../../../vscodeTypes';
import { ICopilotCLISessionService } from './copilotcliSessionService';

export class CopilotCLIAgentManager extends Disposable {
	constructor(
		@ILogService private readonly logService: ILogService,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) {
		super();
	}


	async handleRequest(
		copilotcliSessionId: string | undefined,
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		modelId: ModelProvider | undefined,
		token: vscode.CancellationToken
	): Promise<{ copilotcliSessionId: string | undefined }> {
		const isNewSession = !copilotcliSessionId;
		const sessionIdForLog = copilotcliSessionId ?? 'new';
		this.logService.trace(`[CopilotCLIAgentManager] Handling request for sessionId=${sessionIdForLog}.`);

		const { prompt, attachments } = await this.resolvePrompt(request);
		// Check if we already have a session wrapper
		const session = await this.sessionService.getOrCreateSession(copilotcliSessionId, prompt, modelId);

		if (isNewSession) {
			this.sessionService.setPendingRequest(session.sessionId);
		}
		await session.invoke(prompt, attachments, request.toolInvocationToken, stream, modelId, token);

		return { copilotcliSessionId: session.sessionId };
	}

	private async resolvePrompt(request: vscode.ChatRequest): Promise<{ prompt: string; attachments: Attachment[] }> {
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
				const stat = await fs.stat(file.path);
				const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined;
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
