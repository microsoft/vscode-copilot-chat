/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { CancellationToken } from '../../completions-core/vscode-node/types/src';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

function resolveFilePath(filePath: string): vscode.Uri | undefined {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return undefined;
	}

	for (const folder of workspaceFolders) {
		const uri = vscode.Uri.joinPath(folder.uri, filePath);
		return uri;
	}

	return undefined;
}

function clampLine(line: number, document: vscode.TextDocument): number {
	const maxLine = document.lineCount;
	if (line < 1) {
		return 1;
	}
	if (line > maxLine) {
		return maxLine;
	}
	return line;
}

function centerLineInViewport(editor: vscode.TextEditor, line: number) {
	const clamped = clampLine(line, editor.document);
	const position = new vscode.Position(clamped - 1, 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(
		new vscode.Range(position, position),
		vscode.TextEditorRevealType.InCenter
	);
}
const DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor(
		'editor.findMatchHighlightBackground'
	),
	isWholeLine: true,
});

export interface IOpenFileParams {
	path: string;
	startLine?: number;
	endLine?: number;
}

export class OpenFileTool implements ICopilotTool<IOpenFileParams> {
	public static readonly toolName = ToolName.OpenFile;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IOpenFileParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		this._logService.info(`[OpenFileTool] Invoked with options: ${JSON.stringify(options)}`);

		const uri = resolveFilePath(options.input.path);
		if (!uri) {
			this._logService.warn(`[OpenFileTool] Failed to resolve path: ${options.input.path}`);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify(`{success: false, error: "Failed to resolve path: ${options.input.path}"}`))
			]);
		}
		this._logService.info(`[OpenFileTool] Resolved file URI: ${uri.toString()}`);

		// open the file
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document);

		// clear decorations
		editor.setDecorations(DECORATION_TYPE, []);

		// center a line
		const line = options.input.startLine ? clampLine(options.input.startLine, document) : 1;
		centerLineInViewport(editor, line);

		// highlight a line range
		if (options.input.startLine && options.input.endLine) {
			const start = clampLine(options.input.startLine, editor.document);
			const end = clampLine(options.input.endLine, editor.document);
			const range = new vscode.Range(start - 1, 0, end - 1, Number.MAX_VALUE);
			editor.setDecorations(DECORATION_TYPE, [range]);
		}

		this._logService.info(`[OpenFileTool] Successfully opened file and applied decorations if needed.`);
		return new LanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify({ success: true }))
		]);
	}
}

ToolRegistry.registerTool(OpenFileTool);