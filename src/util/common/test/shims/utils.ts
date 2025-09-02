/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
// eslint-disable-next-line import/no-restricted-paths
import { SnippetTextEdit } from '../../../vs/workbench/api/common/extHostTypes/snippetTextEdit';
// eslint-disable-next-line import/no-restricted-paths
import { Selection } from '../../../vs/workbench/api/common/extHostTypes/selection';
// eslint-disable-next-line import/no-restricted-paths
import { SnippetString } from '../../../vs/workbench/api/common/extHostTypes/snippetString';
// eslint-disable-next-line import/no-restricted-paths
import { Position } from '../../../vs/workbench/api/common/extHostTypes/position';
// eslint-disable-next-line import/no-restricted-paths
import { Range } from '../../../vs/workbench/api/common/extHostTypes/range';

export function isSnippetTextEdit(thing: any): thing is vscode.SnippetTextEdit {
	return SnippetTextEdit.isSnippetTextEdit(thing);
}

export function isPosition(thing: any): thing is vscode.Position {
	return Position.isPosition(thing);
}

export function isRange(thing: any): thing is vscode.Range {
	return Range.isRange(thing);
}

export function isSelection(thing: any): thing is vscode.Selection {
	return Selection.isSelection(thing);
}

export function isSnippetString(thing: any): thing is vscode.SnippetString {
	return SnippetString.isSnippetString(thing);
}
