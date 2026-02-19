/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { resolveToolInputPath } from '../node/toolUtils';

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

export const DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor(
		'editor.findMatchHighlightBackground'
	),
	isWholeLine: true,
});

export interface IHighlightLinesParams {
	filePath: string;
	startLine: number;
	endLine: number;
}

export class HighlightLinesTool implements ICopilotTool<IHighlightLinesParams> {
	public static readonly toolName = ToolName.HighlightLines;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IHighlightLinesParams>, token: vscode.CancellationToken): Promise<LanguageModelToolResult> {
		this._logService.info(`[HighlightLinesTool] Invoked with options: ${JSON.stringify(options)}`);

		if (token.isCancellationRequested) {
			this._logService.info('[HighlightLinesTool] Cancelled before processing.');
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ success: false, error: 'Operation cancelled.' }))
			]);
		}

		// validate line numbers
		if (options.input.startLine < 1) {
			this._logService.warn(`[HighlightLinesTool] Invalid startLine: ${options.input.startLine}`);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ success: false, error: `Invalid startLine: ${options.input.startLine}` }))
			]);
		}
		if (options.input.endLine < 1) {
			this._logService.warn(`[HighlightLinesTool] Invalid endLine: ${options.input.endLine}`);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ success: false, error: `Invalid endLine: ${options.input.endLine}` }))
			]);
		}
		if (options.input.endLine < options.input.startLine) {
			this._logService.warn(`[HighlightLinesTool] endLine ${options.input.endLine} is less than startLine ${options.input.startLine}`);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ success: false, error: 'endLine must be greater than or equal to startLine' }))
			]);
		}

		// resolve the file path
		const uri = resolveToolInputPath(options.input.filePath, this.promptPathRepresentationService);
		if (!uri) {
			this._logService.warn(`[HighlightLinesTool] Failed to resolve path: ${options.input.filePath}`);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ success: false, error: `Failed to resolve path: ${options.input.filePath}` }))
			]);
		}
		this._logService.info(`[HighlightLinesTool] Resolved file URI: ${uri.toString()}`);

		// open the file
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document);

		// center a line
		const line = options.input.startLine ? clampLine(options.input.startLine, document) : 1;
		centerLineInViewport(editor, line);

		// highlight line range
		const start = clampLine(options.input.startLine, editor.document);
		const end = clampLine(options.input.endLine, editor.document);
		const range = new vscode.Range(start - 1, 0, end - 1, Number.MAX_VALUE);
		editor.setDecorations(DECORATION_TYPE, [range]);

		this._logService.info(`[HighlightLinesTool] Successfully opened file and applied decorations.`);
		return new LanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify({ success: true }))
		]);
	}
}

ToolRegistry.registerTool(HighlightLinesTool);