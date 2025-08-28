/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FileSystem, NotebookData, NotebookDocument, NotebookDocumentChangeEvent, TextDocument, TextDocumentChangeEvent, TextEditorSelectionChangeEvent, Uri, WorkspaceFoldersChangeEvent } from 'vscode';
import { Emitter } from '../../../util/vs/base/common/event';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { AbstractWorkspaceService } from '../../workspace/common/workspaceService';

export class TestWorkspaceService extends AbstractWorkspaceService implements IDisposable {
	override fs!: FileSystem;
	private readonly disposables = new DisposableStore();

	public readonly didOpenTextDocumentEmitter = this.disposables.add(new Emitter<TextDocument>());
	public readonly didCloseTextDocumentEmitter = this.disposables.add(new Emitter<TextDocument>());
	public readonly didOpenNotebookDocumentEmitter = this.disposables.add(new Emitter<NotebookDocument>());
	public readonly didCloseNotebookDocumentEmitter = this.disposables.add(new Emitter<NotebookDocument>());
	public readonly didChangeTextDocumentEmitter = this.disposables.add(new Emitter<TextDocumentChangeEvent>());
	public readonly didChangeWorkspaceFoldersEmitter = this.disposables.add(new Emitter<WorkspaceFoldersChangeEvent>());
	public readonly didChangeNotebookDocumentEmitter = this.disposables.add(new Emitter<NotebookDocumentChangeEvent>());
	public readonly didChangeTextEditorSelectionEmitter = this.disposables.add(new Emitter<TextEditorSelectionChangeEvent>());

	public override readonly onDidChangeTextDocument = this.didChangeTextDocumentEmitter.event;
	public override readonly onDidCloseTextDocument = this.didCloseTextDocumentEmitter.event;
	public override readonly onDidOpenNotebookDocument = this.didOpenNotebookDocumentEmitter.event;
	public override readonly onDidCloseNotebookDocument = this.didCloseNotebookDocumentEmitter.event;
	public override readonly onDidOpenTextDocument = this.didOpenTextDocumentEmitter.event;
	public override readonly onDidChangeWorkspaceFolders = this.didChangeWorkspaceFoldersEmitter.event;
	public override readonly onDidChangeNotebookDocument = this.didChangeNotebookDocumentEmitter.event;
	public override readonly onDidChangeTextEditorSelection = this.didChangeTextEditorSelectionEmitter.event;

	private readonly workspaceFolder: URI[];
	private readonly _textDocuments: TextDocument[] = [];
	private readonly _notebookDocuments: NotebookDocument[] = [];

	constructor(workspaceFolders: URI[] = [], textDocuments: TextDocument[] = [], notebookDocuments: NotebookDocument[] = []) {
		super();
		this.workspaceFolder = workspaceFolders;
		this._textDocuments = textDocuments;
		this._notebookDocuments = notebookDocuments;
	}

	get textDocuments(): TextDocument[] {
		return this._textDocuments;
	}

	override showTextDocument(document: TextDocument): Promise<void> {
		return Promise.resolve();
	}

	override async openTextDocument(uri: Uri): Promise<TextDocument> {
		const doc = this.textDocuments.find(d => d.uri.toString() === uri.toString());
		if (doc) {
			return doc;
		}

		throw new Error(`Unknown document: ${uri}`);
	}

	override async openNotebookDocument(uri: Uri): Promise<NotebookDocument>;
	override async openNotebookDocument(notebookType: string, content?: NotebookData): Promise<NotebookDocument>;
	override async openNotebookDocument(arg1: Uri | string, arg2?: NotebookData): Promise<NotebookDocument> {
		if (typeof arg1 === 'string') {
			// Handle the overload for notebookType and content
			throw new Error('Not implemented');
		} else {
			const notebook = this.notebookDocuments.find(d => d.uri.toString() === arg1.toString());
			if (notebook) {
				return notebook;
			}

			throw new Error(`Unknown notebook: ${arg1}`);
		}
	}

	get notebookDocuments(): readonly NotebookDocument[] {
		return this._notebookDocuments;
	}

	getWorkspaceFolders(): URI[] {
		return this.workspaceFolder;
	}

	override getWorkspaceFolderName(workspaceFolderUri: URI): string {
		return 'default';
	}

	override ensureWorkspaceIsFullyLoaded(): Promise<void> {
		// We aren't using virtual workspaces here, so we can just return
		return Promise.resolve();
	}

	showWorkspaceFolderPicker(): Promise<undefined> {
		return Promise.resolve(undefined);
	}

	override applyEdit(): Promise<boolean> {
		return Promise.resolve(true);
	}

	public dispose() {
		this.disposables.dispose();
	}
}
