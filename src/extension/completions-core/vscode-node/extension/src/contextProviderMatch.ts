/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../lib/src/context';
import { isDocumentValid } from '../../lib/src/util/documentEvaluation';
import { DocumentContext } from '../../types/src';
import { languages, workspace } from 'vscode';
import { DocumentSelector } from 'vscode-languageserver-protocol';

export async function contextProviderMatch(
	ctx: Context,
	documentSelector: DocumentSelector,
	documentContext: DocumentContext
): Promise<number> {
	const vscDoc = workspace.textDocuments.find(td => td.uri.toString() === documentContext.uri);
	if (!vscDoc) {
		return 0;
	}

	const result = await isDocumentValid(ctx, documentContext, vscDoc.getText());
	if (result.status !== 'valid') {
		return 0;
	}

	return languages.match(documentSelector, vscDoc);
}
