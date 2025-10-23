/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Context } from './context';
import { FileSystem } from './fileSystem';
import {
	INotebookDocument,
	IRange,
	ITextDocument,
	TextDocumentIdentifier,
	TextDocumentResult,
	TextDocumentValidation,
} from './textDocument';
import { isDocumentValid } from './util/documentEvaluation';
import { Event } from './util/event';
import { basename, normalizeUri } from './util/uri';
import { TextDocumentItem, VersionedTextDocumentIdentifier, WorkspaceFolder } from '../../types/src';

/**
 * An interface describing an individual change in the text of a document.
 */
interface TextDocumentContentChangeEvent {
	/**
	 * The range that got replaced.
	 */
	readonly range: IRange;
	/**
	 * The offset of the range that got replaced.
	 */
	readonly rangeOffset: number;
	/**
	 * The length of the range that got replaced.
	 */
	readonly rangeLength: number;
	/**
	 * The new text for the range.
	 */
	readonly text: string;
}

/**
 * An event describing a document open.
 * @public KEEPING FOR TESTS
 */
export interface TextDocumentOpenEvent {
	/**
	 * The affected document.
	 */
	readonly document: TextDocumentItem;
}

/**
 * An event describing a transactional document change.
 * @public KEEPING FOR TESTS
 */
export interface TextDocumentChangeEvent {
	/**
	 * The affected document.
	 */
	readonly document: VersionedTextDocumentIdentifier;

	/**
	 * An array of content changes.
	 */
	readonly contentChanges: readonly TextDocumentContentChangeEvent[];
}

/**
 * An event describing a document close.
 * @public KEEPING FOR TESTS
 */
export interface TextDocumentCloseEvent {
	readonly document: TextDocumentIdentifier;
}

/** @public KEEPING FOR TESTS */
export interface TextDocumentFocusedEvent {
	readonly document?: TextDocumentIdentifier;
}

export interface WorkspaceFoldersChangeEvent {
	readonly workspaceFolders: WorkspaceFolder[];
	readonly added: WorkspaceFolder[];
	readonly removed: WorkspaceFolder[];
}

export abstract class TextDocumentManager {
	abstract onDidChangeTextDocument: Event<TextDocumentChangeEvent>;
	abstract onDidOpenTextDocument: Event<TextDocumentOpenEvent>;
	abstract onDidCloseTextDocument: Event<TextDocumentCloseEvent>;

	abstract onDidFocusTextDocument: Event<TextDocumentFocusedEvent>;
	abstract onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>;

	/**
	 * Get all open text documents, skipping content exclusions and other validations.
	 */
	abstract getTextDocumentsUnsafe(): ITextDocument[];

	constructor(protected ctx: Context) { }

	async textDocuments(): Promise<ITextDocument[]> {
		const documents = this.getTextDocumentsUnsafe();
		const filteredDocuments: ITextDocument[] = [];
		for (const doc of documents) {
			const result = await isDocumentValid(this.ctx, doc, doc.getText());
			// Only return valid documents
			if (result.status === 'valid') {
				filteredDocuments.push(doc);
			}
		}
		return filteredDocuments;
	}

	/**
	 * Get the text document for the given URI, skipping content exclusions and other validations.
	 */
	getTextDocumentUnsafe(docId: TextDocumentIdentifier): ITextDocument | undefined {
		const uri = normalizeUri(docId.uri);
		return this.getTextDocumentsUnsafe().find(t => t.uri === uri);
	}

	/**
	 * Get the text document for the given URI, checking content exclusions and other validations.
	 */
	async getTextDocument(docId: TextDocumentIdentifier): Promise<ITextDocument | undefined> {
		return this.getTextDocumentWithValidation(docId).then(result => {
			if (result.status === 'valid') {
				return result.document;
			}
			return undefined;
		});
	}

	private validateTextDocument(docId: TextDocumentIdentifier, text: string) {
		return isDocumentValid(this.ctx, docId, text);
	}

	/**
	 * Get a TextDocumentValidation for the given document URI.  Unlike other methods, this supports reading the
	 * document from disk.
	 */
	async getTextDocumentValidation(docId: TextDocumentIdentifier): Promise<TextDocumentValidation> {
		try {
			const text =
				this.getTextDocumentUnsafe(docId)?.getText() ?? (await this.readTextDocumentFromDisk(docId.uri));
			if (text === undefined) { return this.notFoundResult(docId); }
			return this.validateTextDocument(docId, text);
		} catch (err) {
			return this.notFoundResult(docId);
		}
	}

	/**
	 * Get a TextDocumentResult for the given document URI.
	 */
	async getTextDocumentWithValidation(docId: TextDocumentIdentifier): Promise<TextDocumentResult<ITextDocument>> {
		const document = this.getTextDocumentUnsafe(docId);
		if (!document) { return this.notFoundResult(docId); }
		const result = await this.validateTextDocument(docId, document.getText());
		return result.status === 'valid' ? { status: 'valid', document } : result;
	}

	private notFoundResult({ uri }: TextDocumentIdentifier): { status: 'notfound'; message: string } {
		return {
			status: 'notfound',
			message: `Document for URI could not be found: ${uri}`,
		};
	}

	/**
	 * Implements ability to open a text document that is currently not open (and not tracked by the document manager).
	 *
	 * This is usually used with asychronous operations like the postInsertion callbacks that
	 * analyze a document long time after the user interacted with it.
	 */
	protected async readTextDocumentFromDisk(uri: string): Promise<string | undefined> {
		try {
			const fileStat = await this.ctx.get(FileSystem).stat(uri);
			if (fileStat.size > 5 * 1024 * 1024) {
				return undefined;
			}
		} catch (e) {
			// ignore if file does not exist
			return undefined;
		}
		return await this.ctx.get(FileSystem).readFileString(uri);
	}

	/**
	 * If `TextDocument` represents notebook returns `INotebookDocument` instance, otherwise returns `undefined`
	 */
	abstract findNotebook(doc: TextDocumentIdentifier): INotebookDocument | undefined;

	abstract getWorkspaceFolders(): WorkspaceFolder[];

	getWorkspaceFolder(doc: TextDocumentIdentifier) {
		const uri = normalizeUri(doc.uri);
		return this.getWorkspaceFolders().find(f => uri.startsWith(normalizeUri(f.uri)));
	}

	/**
	 * Get the path of the given document relative to one of the workspace folders,
	 * or its basename if it is not under any of the workspace folders.
	 * Returns `undefined` if the file is untitled.
	 */
	getRelativePath(doc: TextDocumentIdentifier): string | undefined {
		if (doc.uri.startsWith('untitled:')) {
			// matches the internal implementation of .isUntitled on vscode.TextDocument
			// and example URLs in the LSP spec
			return undefined;
		}
		const uri = normalizeUri(doc.uri);
		for (const folder of this.getWorkspaceFolders()) {
			const parentURI = normalizeUri(folder.uri)
				.replace(/[#?].*/, '')
				.replace(/\/?$/, '/');
			if (uri.startsWith(parentURI)) {
				return uri.slice(parentURI.length);
			}
		}
		return basename(uri);
	}
}
