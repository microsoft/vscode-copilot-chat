/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import * as protocol from '../common/serverProtocol';

enum ExecutionTarget {
	Semantic,
	Syntax
}

type ExecConfig = {
	readonly lowPriority?: boolean;
	readonly nonRecoverable?: boolean;
	readonly cancelOnResourceChange?: vscode.Uri;
	readonly executionTarget?: ExecutionTarget;
};

type PrepareNesRenameRequestArgs = Omit<protocol.PrepareNesRenameRequestArgs, 'file' | 'projectFileName' | 'line' | 'offset'> & {
	file: vscode.Uri;
	line: number;
	offset: number;
};

namespace PrepareNesRenameRequestArgs {
	export function create(document: vscode.TextDocument, position: vscode.Position, oldName: string, newName: string, startTime: number, timeBudget: number): PrepareNesRenameRequestArgs {
		return {
			file: vscode.Uri.file(document.fileName),
			line: position.line + 1,
			offset: position.character + 1,
			oldName: oldName,
			newName: newName,
			startTime: startTime,
			timeBudget: timeBudget
		};
	}
}

export class NesRenameContribution implements vscode.Disposable {

	private _isActivated: Promise<boolean> | undefined;
	private disposables: DisposableStore;

	private static readonly ExecConfig: ExecConfig = { executionTarget: ExecutionTarget.Semantic };

	constructor(
		@ILogService readonly logService: ILogService,
	) {
		this.disposables = new DisposableStore();
		this.disposables.add(vscode.commands.registerCommand('github.copilot.nes.prepareRename', async (uri: vscode.Uri | undefined, position: vscode.Position | undefined, oldName: string | undefined, newName: string | undefined): Promise<protocol.RenameKind> => {
			const params = await this.resolveParams(uri, position, oldName, newName);
			if (params === undefined) {
				return protocol.RenameKind.no;
			}
			const document = params.document;
			position = params.position;
			oldName = params.oldName;
			newName = params.newName;

			const activated = await this.isActivated(document);
			if (!activated) {
				return protocol.RenameKind.no;
			}

			const args: PrepareNesRenameRequestArgs = PrepareNesRenameRequestArgs.create(document, position, oldName, newName, Date.now(), 300);

			const tokenSource = new vscode.CancellationTokenSource();
			try {
				const result = await vscode.commands.executeCommand<protocol.PrepareNesRenameResponse>('typescript.tsserverRequest', '_.copilot.prepareNesRename', args, NesRenameContribution.ExecConfig, tokenSource.token);
				if (protocol.PrepareNesRenameResponse.isError(result)) {
					this.logService.error('Prepare NES Rename error:', result.message);
					return protocol.RenameKind.no;
				} else if (protocol.PrepareNesRenameResponse.isOk(result)) {
					this.logService.info(`Prepare NES Rename result for ${oldName} to ${newName}: ${result.body.canRename}`);
					return result.body.canRename;
				} else {
					return protocol.RenameKind.no;
				}
			} finally {
				tokenSource.dispose();
			}
		}));
		this.disposables.add(vscode.commands.registerCommand('github.copilot.debug.validateNesRename', async () => {
			const params = await this.getUserParams();
			if (params === undefined) {
				return;
			}
			const { document, position, oldName, newName } = params;
			const activated = await this.isActivated(document);
			if (!activated) {
				vscode.window.showErrorMessage('TypeScript NES Rename plugin is not activated.');
				return;
			}

			const args: PrepareNesRenameRequestArgs = PrepareNesRenameRequestArgs.create(document, position, oldName, newName, Date.now(), 300);
			const tokenSource = new vscode.CancellationTokenSource();
			try {
				const result = await vscode.commands.executeCommand<protocol.PrepareNesRenameResponse>('typescript.tsserverRequest', '_.copilot.prepareNesRename', args, NesRenameContribution.ExecConfig, tokenSource.token);
				if (protocol.PrepareNesRenameResponse.isError(result)) {
					vscode.window.showErrorMessage(`Prepare NES Rename error: ${result.message}`);
				} else if (protocol.PrepareNesRenameResponse.isOk(result)) {
					vscode.window.showInformationMessage(`Prepare NES Rename result for '${oldName}' to '${newName}': ${result.body.canRename}`);
				}
			} finally {
				tokenSource.dispose();
			}
		}));
	}

	public dispose(): void {
		this.disposables.dispose();
	}

	private async isActivated(documentOrLanguageId: vscode.TextDocument | string): Promise<boolean> {
		const languageId = typeof documentOrLanguageId === 'string' ? documentOrLanguageId : documentOrLanguageId.languageId;
		if (languageId !== 'typescript' && languageId !== 'typescriptreact') {
			return false;
		}
		if (this._isActivated === undefined) {
			this._isActivated = this.doIsTypeScriptActivated(languageId);
		}
		return this._isActivated;
	}

	private async doIsTypeScriptActivated(languageId: string): Promise<boolean> {
		let activated = false;

		try {
			// Check that the TypeScript extension is installed and runs in the same extension host.
			const typeScriptExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
			if (typeScriptExtension === undefined) {
				return false;
			}

			// Make sure the TypeScript extension is activated.
			await typeScriptExtension.activate();

			// Send a ping request to see if the TS server plugin got installed correctly.
			const response: protocol.PingResponse | undefined = await vscode.commands.executeCommand('typescript.tsserverRequest', '_.copilot.ping', NesRenameContribution.ExecConfig, new vscode.CancellationTokenSource().token);
			if (response !== undefined) {
				if (response.body?.kind === 'ok') {
					this.logService.info('TypeScript server plugin activated.');
					activated = true;
				} else {
					this.logService.error('TypeScript server plugin not activated:', response.body?.message ?? 'Message not provided.');
				}
			} else {
				this.logService.error('TypeScript server plugin not activated:', 'No ping response received.');
			}
		} catch (error) {
			this.logService.error('Error pinging TypeScript server plugin:', error);
		}

		return activated;
	}

	private resolveParams(uri: vscode.Uri | undefined, position: vscode.Position | undefined, oldName: string | undefined, newName: string | undefined): { document: vscode.TextDocument; position: vscode.Position; oldName: string; newName: string } | undefined {
		if (uri === undefined) {
			return undefined;
		}
		const document = this.getDocument(uri);
		if (document !== undefined && position !== undefined && typeof oldName === 'string' && typeof newName === 'string') {
			return { document, position, oldName, newName };
		} else {
			return undefined;
		}
	}

	private getDocument(uri: vscode.Uri, token?: vscode.CancellationToken): vscode.TextDocument | undefined {
		let document: vscode.TextDocument | undefined;
		if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) {
			document = vscode.window.activeTextEditor.document;
		} else {
			document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
		}
		return document;
	}

	private async getUserParams(): Promise<{ document: vscode.TextDocument; position: vscode.Position; oldName: string; newName: string } | undefined> {
		if (vscode.window.activeTextEditor === undefined) {
			return undefined;
		}
		const document = vscode.window.activeTextEditor.document;
		const position = vscode.window.activeTextEditor.selection.active;
		const wordRange = document.getWordRangeAtPosition(position);
		if (wordRange === undefined) {
			return undefined;
		}
		const oldName = document.getText(wordRange);
		const newName = await vscode.window.showInputBox({ prompt: 'Enter the new name for NES rename' });
		if (newName === undefined || newName.length === 0) {
			return undefined;
		}
		return { document, position, oldName, newName };
	}
}