/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Context } from './context';
import { FileSystem } from './fileSystem';
import { CopilotTextDocument, ITextDocument, TextDocumentIdentifier, TextDocumentResult } from './textDocument';
import { TextDocumentManager } from './textDocumentManager';
import { isDocumentValid } from './util/documentEvaluation';
import { basename } from './util/uri';

export class FileReader {
	constructor(private readonly ctx: Context) { }

	getRelativePath(doc: TextDocumentIdentifier) {
		const documentManager = this.ctx.get(TextDocumentManager);
		return documentManager.getRelativePath(doc) ?? basename(doc.uri);
	}

	getOrReadTextDocument(doc: TextDocumentIdentifier): Promise<TextDocumentResult> {
		return this.readFile(doc.uri);
	}

	getOrReadTextDocumentWithFakeClientProperties(
		doc: TextDocumentIdentifier
	): Promise<TextDocumentResult<ITextDocument>> {
		return this.readFile(doc.uri);
	}

	/**
	 * @deprecated use `getOrReadTextDocument` instead
	 */
	protected async readFile(uri: string): Promise<TextDocumentResult<ITextDocument>> {
		const documentManager = this.ctx.get(TextDocumentManager);
		const documentResult = await documentManager.getTextDocumentWithValidation({ uri });
		if (documentResult.status !== 'notfound') {
			return documentResult;
		}
		try {
			const fileSizeMB = await this.getFileSizeMB(uri);
			// Note: the real production behavior actually blocks files larger than 5MB
			if (fileSizeMB > 1) {
				// Using notfound instead of invalid because of the mapping in statusFromTextDocumentResult
				return { status: 'notfound' as const, message: 'File too large' };
			}
			const text = await this.doReadFile(uri);

			// Note, that we check for blocked files even for empty files!
			const rcmResult = await isDocumentValid(this.ctx, { uri }, text);
			if (rcmResult.status === 'valid') {
				const doc = CopilotTextDocument.create(uri, 'UNKNOWN', -1, text);
				return { status: 'valid' as const, document: doc };
			}

			return rcmResult;
		} catch (e) {
			return { status: 'notfound' as const, message: 'File not found' };
		}
	}

	private async doReadFile(uri: string) {
		return await this.ctx.get(FileSystem).readFileString(uri);
	}

	private async getFileSizeMB(uri: string) {
		const stat = await this.ctx.get(FileSystem).stat(uri);
		return stat.size / 1024 / 1024;
	}
}
