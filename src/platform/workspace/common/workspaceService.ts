/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event, FileSystem, NotebookData, NotebookDocument, NotebookDocumentChangeEvent, TextDocument, TextDocumentChangeEvent, TextEditorSelectionChangeEvent, Uri, WorkspaceEdit, WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode';
import { findNotebook } from '../../../util/common/notebooks';
import { createServiceIdentifier } from '../../../util/common/services';
import * as path from '../../../util/vs/base/common/path';
import { extUriBiasedIgnorePathCase, relativePath } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { NotebookDocumentSnapshot } from '../../editing/common/notebookDocumentSnapshot';
import { TextDocumentSnapshot } from '../../editing/common/textDocumentSnapshot';

export const IWorkspaceService = createServiceIdentifier<IWorkspaceService>('IWorkspaceService');

export interface IWorkspaceService {
	readonly _serviceBrand: undefined;
	textDocuments: readonly TextDocument[];
	notebookDocuments: readonly NotebookDocument[];
	readonly onDidOpenTextDocument: Event<TextDocument>;
	readonly onDidCloseTextDocument: Event<TextDocument>;
	readonly onDidOpenNotebookDocument: Event<NotebookDocument>;
	readonly onDidCloseNotebookDocument: Event<NotebookDocument>;
	readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>;
	readonly onDidChangeNotebookDocument: Event<NotebookDocumentChangeEvent>;
	readonly onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>;
	readonly onDidChangeTextEditorSelection: Event<TextEditorSelectionChangeEvent>;
	openTextDocument(uri: Uri): Promise<TextDocument>;
	fs: FileSystem;
	showTextDocument(document: TextDocument): Promise<void>;
	openTextDocumentAndSnapshot(uri: Uri): Promise<TextDocumentSnapshot>;
	openNotebookDocumentAndSnapshot(uri: Uri, format: 'xml' | 'json' | 'text'): Promise<NotebookDocumentSnapshot>;
	openNotebookDocument(uri: Uri): Promise<NotebookDocument>;
	openNotebookDocument(notebookType: string, content?: NotebookData): Promise<NotebookDocument>;
	getWorkspaceFolders(): URI[];
	getWorkspaceFolder(resource: URI): URI | undefined;
	getWorkspaceFolderName(workspaceFolderUri: URI): string;
	showWorkspaceFolderPicker(): Promise<WorkspaceFolder | undefined>;

	asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string;
	applyEdit(edit: WorkspaceEdit): Thenable<boolean>;

	/**
	 * Ensures that the workspace has fully loaded before returning. This is useful for
	 * virtual workspaces where we need to ensure that the contents of the workspace
	 * has been downloaded before we can use them.
	 */
	ensureWorkspaceIsFullyLoaded(): Promise<void>;
}

export abstract class AbstractWorkspaceService implements IWorkspaceService {
	declare readonly _serviceBrand: undefined;
	abstract textDocuments: readonly TextDocument[];
	abstract notebookDocuments: readonly NotebookDocument[];
	abstract readonly onDidOpenTextDocument: Event<TextDocument>;
	abstract readonly onDidCloseTextDocument: Event<TextDocument>;
	abstract readonly onDidOpenNotebookDocument: Event<NotebookDocument>;
	abstract readonly onDidCloseNotebookDocument: Event<NotebookDocument>;
	abstract readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>;
	abstract readonly onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>;
	abstract readonly onDidChangeNotebookDocument: Event<NotebookDocumentChangeEvent>;
	abstract readonly onDidChangeTextEditorSelection: Event<TextEditorSelectionChangeEvent>;
	abstract openTextDocument(uri: Uri): Promise<TextDocument>;
	abstract fs: FileSystem;
	abstract showTextDocument(document: TextDocument): Promise<void>;
	abstract openNotebookDocument(uri: Uri): Promise<NotebookDocument>;
	abstract openNotebookDocument(notebookType: string, content?: NotebookData): Promise<NotebookDocument>;
	abstract getWorkspaceFolders(): URI[];
	abstract ensureWorkspaceIsFullyLoaded(): Promise<void>;
	abstract showWorkspaceFolderPicker(): Promise<WorkspaceFolder | undefined>;
	abstract getWorkspaceFolderName(workspaceFolderUri: URI): string;
	abstract applyEdit(edit: WorkspaceEdit): Thenable<boolean>;
	asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string {
		// Copied from the implementation in vscode/extHostWorkspace.ts
		let resource: URI | undefined;
		let path: string = '';
		if (typeof pathOrUri === 'string') {
			resource = URI.file(pathOrUri);
			path = pathOrUri;
		} else if (typeof pathOrUri !== 'undefined') {
			resource = pathOrUri;
			path = pathOrUri.fsPath;
		}

		if (!resource) {
			return path;
		}

		const folder = this.getWorkspaceFolder(resource);

		if (!folder) {
			return path;
		}

		if (typeof includeWorkspaceFolder === 'undefined') {
			includeWorkspaceFolder = this.getWorkspaceFolders().length > 1;
		}

		let result = relativePath(folder, resource);
		if (includeWorkspaceFolder) {
			const name = this.getWorkspaceFolderName(folder);
			result = `${name}/${result}`;
		}
		return result!;
	}

	async openTextDocumentAndSnapshot(uri: Uri): Promise<TextDocumentSnapshot> {
		const doc = await this.openTextDocument(uri);
		return TextDocumentSnapshot.create(doc);
	}

	async openNotebookDocumentAndSnapshot(uri: Uri, format: 'xml' | 'json' | 'text'): Promise<NotebookDocumentSnapshot> {
		// Possible we have an untitled file opened as a notebook.
		const doc = findNotebook(uri, this.notebookDocuments) || await this.openNotebookDocument(uri);

		return NotebookDocumentSnapshot.create(doc, format);
	}

	getWorkspaceFolder(resource: URI): URI | undefined {
		return this.getWorkspaceFolders().find(folder => extUriBiasedIgnorePathCase.isEqualOrParent(resource, folder));
	}
}

export function getWorkspaceFileDisplayPath(workspaceService: IWorkspaceService, file: URI): string {
	const workspaceUri = workspaceService.getWorkspaceFolder(file);
	return workspaceUri ? path.posix.relative(workspaceUri.path, file.path) : file.path;
}
