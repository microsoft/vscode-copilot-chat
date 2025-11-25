/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatPromptReference } from 'vscode';
import { createFilepathRegexp } from '../../../../util/common/markdown';
import * as path from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatReferenceDiagnostic, Location, Range } from '../../../../vscodeTypes';


/**
 * Parse the raw user prompt and extract diagnostics and file/line location references
 * contained inside a single <attachments>...</attachments> block.
 *
 * Recognized elements:
 *  - <error path="/abs/path.py" line=13 code="E001" severity="error">Message</error>
 *    -> Aggregated into ChatReferenceDiagnostic (maps uri -> Diagnostic[])
 *  - <attachment>Excerpt from /abs/path.py, lines X to Y: ...</attachment>
 *    or attachment blocks containing a `# filepath: /abs/path.py` comment
 *    -> Converted into vscode.Location objects.
 */
export function extractChatPromptReferences(prompt: string): {
	diagnostics: {
		id: string;
		range: undefined;
		name: string;
		value: ChatReferenceDiagnostic;
	}[];
	references: ChatPromptReference[];
} {
	return {
		diagnostics: extractDiagnostics(prompt),
		references: extractResources(prompt)
	};
}


/**
 * Parse the raw user prompt and extract diagnostics and file/line location references
 * contained inside a single <attachments>...</attachments> block.
 *
 * Recognized elements:
 *  - <error path="/abs/path.py" line=13 code="E001" severity="error">Message</error>
 *    -> Aggregated into ChatReferenceDiagnostic (maps uri -> Diagnostic[])
 *  - <attachment>Excerpt from /abs/path.py, lines X to Y: ...</attachment>
 *    or attachment blocks containing a `# filepath: /abs/path.py` comment
 *    -> Converted into vscode.Location objects.
 */
function extractResources(prompt: string): ChatPromptReference[] {
	const references: ChatPromptReference[] = [];

	const attachmentsBlockMatch = prompt.match(/<attachments>([\s\S]*?)<\/attachments>/i);
	if (!attachmentsBlockMatch) {
		return references;
	}
	const block = attachmentsBlockMatch[1];

	// Parse location excerpts (<attachment> blocks)
	const attachmentRegex = /<attachment[\s\S]*?>[\s\S]*?<\/attachment>/gi;
	for (let m; (m = attachmentRegex.exec(block));) {
		const content = m[0];
		let filePath: string | undefined;
		let providedId: string | undefined;
		const openingTagMatch = content.match(/<attachment\s+([^>]*)>/i);
		if (openingTagMatch) {
			const attrsStr = openingTagMatch[1];
			const idAttrMatch = attrsStr.match(/\bid\s*=\s*"([^"]+)"/);
			if (idAttrMatch) {
				providedId = idAttrMatch[1];
			}
		}

		// Attempt to extract fenced code block language
		const fenceMatch = content.match(/```([^\n`]+)\n([\s\S]*?)```/);
		const fencedLanguage = fenceMatch ? fenceMatch[1].trim() : undefined;
		const codeBlockBody = fenceMatch ? fenceMatch[2] : undefined;

		// If we have a code block body, scan its lines for a filepath comment using language-aware regex
		if (codeBlockBody) {
			const re = createFilepathRegexp(fencedLanguage);
			for (const line of codeBlockBody.split(/\r?\n/)) {
				const lineMatch = re.exec(line);
				if (lineMatch && lineMatch[1]) {
					filePath = lineMatch[1].trim();
					break;
				}
			}
		}

		// Fallback: look for classic '# filepath:' or 'Excerpt from' header if not found via regex
		if (!filePath) {
			const simpleMatch = content.match(/[#\/]{1,2}\s*filepath:\s*(\S+)/);
			if (simpleMatch) {
				filePath = simpleMatch[1];
			}
		}
		if (!filePath) {
			const excerptMatch = content.match(/Excerpt from ([^,]+),\s*lines\s+(\d+)\s+to\s+(\d+)/i);
			if (excerptMatch) { filePath = excerptMatch[1].trim(); }
		}

		const linesMatch = content.match(/Excerpt from [^,]+,\s*lines\s+(\d+)\s+to\s+(\d+)/i);
		if (!filePath || !linesMatch) { continue; }
		const startLine = parseInt(linesMatch[1], 10);
		const endLine = parseInt(linesMatch[2], 10);
		if (isNaN(startLine) || isNaN(endLine)) { continue; }
		const uri = URI.file(filePath);
		const location = new Location(uri, new Range(startLine - 1, 0, endLine - 1, 0));
		const locName = providedId ?? JSON.stringify(location);
		let range: [number, number] | undefined = undefined;
		let id = JSON.stringify(location);
		if (prompt.includes(`#${locName}`)) {
			const idx = prompt.indexOf(`#${locName}`);
			range = [idx, idx + locName.length];
		}
		if (locName.startsWith('sym:')) {
			id = `vscode.symbol/${JSON.stringify(location)}`;
		}
		references.push({
			id,
			name: locName,
			range,
			value: location
		});
	}

	// Parse self-closing resource-only attachments (<attachment id="..." filePath="/path" />)
	const selfClosingRegex = /<attachment\s+[^>]*\/>/gi;
	for (let m; (m = selfClosingRegex.exec(block));) {
		const tag = m[0];
		const attrs: Record<string, string> = {};
		for (const attrMatch of tag.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
			attrs[attrMatch[1]] = attrMatch[2];
		}
		const isFolder = attrs['folderPath'] !== undefined && attrs['folderPath'] !== '' && attrs['filePath'] === undefined;
		const fileOrFolderpath = attrs['filePath'] || attrs['folderPath'];
		if (!fileOrFolderpath) {
			continue;
		}
		// Ensure folders are represented with trailing path separator, this allows us to extract these as folders later on.
		const uri = URI.file(isFolder ? getFolderAttachmentPath(fileOrFolderpath) : fileOrFolderpath);
		const providedId = attrs['id'];
		const locName = providedId ?? uri.toString();
		let id = providedId ?? uri.toString();
		let range: [number, number] | undefined = undefined;
		if (providedId && prompt.includes(`#${providedId}`)) {
			const startIdx = prompt.indexOf(`#${providedId}`);
			range = [startIdx, startIdx + providedId.length];
		}
		if (providedId && providedId.startsWith('sym:')) {
			id = `vscode.symbol/${uri.toJSON()}`;
		}
		references.push({
			id,
			name: locName,
			range,
			value: uri
		});
	}

	return references;
}


/**
 * Parse the raw user prompt and extract diagnostics and file/line location references
 * contained inside a single <attachments>...</attachments> block.
 *
 * Recognized elements:
 *  - <error path="/abs/path.py" line=13 code="E001" severity="error">Message</error>
 *    -> Aggregated into ChatReferenceDiagnostic (maps uri -> Diagnostic[])
 *  - <attachment>Excerpt from /abs/path.py, lines X to Y: ...</attachment>
 *    or attachment blocks containing a `# filepath: /abs/path.py` comment
 *    -> Converted into vscode.Location objects.
 */
function extractDiagnostics(prompt: string): {
	id: string;
	range: undefined;
	name: string;
	value: ChatReferenceDiagnostic;
}[] {
	const diagnostics: {
		id: string;
		range: undefined;
		name: string;
		value: ChatReferenceDiagnostic;
	}[] = [];

	const attachmentsBlockMatch = prompt.match(/<attachments>([\s\S]*?)<\/attachments>/i);
	if (!attachmentsBlockMatch) {
		return diagnostics;
	}
	const block = attachmentsBlockMatch[1];

	// Parse diagnostics (<error ...> tags)
	const errorRegex = /<error\s+([^>]+)>([\s\S]*?)<\/error>/gi;
	const byFile = new Map<string, { uri: URI; diagnostics: { message: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: number; code?: string; source: string }[] }>();
	for (let m; (m = errorRegex.exec(block));) {
		const attrText = m[1];
		const message = m[2].trim();
		const attrs: Record<string, string> = {};
		for (const attrMatch of attrText.matchAll(/(\w+)="([^"]*)"/g)) {
			attrs[attrMatch[1]] = attrMatch[2];
		}
		// Support unquoted numeric attributes like line=13
		for (const attrMatch of attrText.matchAll(/(\w+)=([0-9]+)/g)) {
			if (!attrs[attrMatch[1]]) {
				attrs[attrMatch[1]] = attrMatch[2];
			}
		}
		const filePath = attrs['path'];
		const lineStr = attrs['line'];
		if (!filePath || !lineStr) { continue; }
		const lineNum = parseInt(lineStr, 10);
		if (isNaN(lineNum) || lineNum < 1) { continue; }
		const severityStr = (attrs['severity'] || 'error').toLowerCase();
		const severityMap: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
		const severity = severityMap[severityStr] ?? 0;
		const code = attrs['code'] && attrs['code'] !== 'undefined' ? attrs['code'] : undefined;
		const uri = URI.file(filePath);
		const range = { start: { line: lineNum - 1, character: 0 }, end: { line: lineNum - 1, character: 0 } };
		const entry = byFile.get(filePath) || { uri, diagnostics: [] };
		entry.diagnostics.push({ message, range, severity, code, source: 'prompt' });
		byFile.set(filePath, entry);
	}
	if (byFile.size) {
		for (const [, { uri, diagnostics: diags }] of byFile) {
			diags.forEach(diagnostic => {
				diagnostics.push({
					id: `${uri.toString()}:${diagnostic.range.start.line}`,
					name: diagnostic.message,
					range: undefined,
					value: {
						diagnostics: [
							[uri, [diagnostic]]
						]
					} as unknown as ChatReferenceDiagnostic
				});
			});
		}
	}

	return diagnostics;
}


export function getFolderAttachmentPath(folderPath: string): string {
	if (folderPath.endsWith('/') || folderPath.endsWith('\\')) {
		return folderPath;
	}
	return folderPath + path.sep;
}

