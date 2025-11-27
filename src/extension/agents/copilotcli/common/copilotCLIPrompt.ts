/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatPromptReference } from 'vscode';
import { createFilepathRegexp } from '../../../../util/common/markdown';
import { Schemas } from '../../../../util/vs/base/common/network';
import * as path from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatReferenceDiagnostic, Diagnostic, DiagnosticSeverity, Location, Range } from '../../../../vscodeTypes';
import { PromptFileIdPrefix } from '../../../prompt/common/chatVariablesCollection';
import { isEqual } from '../../../../util/vs/base/common/resources';
import { Range as EditorRange } from '../../../../util/vs/editor/common/core/range';

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
export function extractChatPromptReferences(prompt: string): ChatPromptReference[] {
	// Preserve order of items as they appear inside <attachments>...
	const attachmentsBlockMatch = prompt.match(/<attachments>([\s\S]*?)<\/attachments>/i);
	if (!attachmentsBlockMatch) {
		// No attachments block; return combined results from legacy extractors
		return extractDiagnostics(prompt).concat(extractResources(prompt).concat(extractPromptReferences(prompt)));
	}
	const block = attachmentsBlockMatch[1];

	// Collect all tags with their positions, then delegate to specific extractors per tag
	const ordered: ChatPromptReference[] = [];
	const tagRegex = /<(attachment|error)\b[\s\S]*?(?:<\/(?:attachment|error)>|\/>)/gi;
	for (let m; (m = tagRegex.exec(block));) {
		const tagText = m[0];
		if (/^<attachment\b/i.test(tagText)) {
			// Distinguish prompt attachments vs resource attachments
			const promptIdMatch = tagText.match(/<attachment\s+id="(prompt:[^"]+)"[\s\S]*?>/i);
			const ref = promptIdMatch ? extractPromptReferencesFromTag(prompt, tagText) : extractResourcesFromTag(prompt, tagText);
			if (ref) {
				ordered.push(ref);
			}
		} else if (/^<error\b/i.test(tagText)) {
			const ref = extractDiagnosticsFromTag(tagText);
			if (!ref) {
				continue;
			}
			const previousRef = ordered.length > 0 ? ordered[ordered.length - 1] : undefined;
			if (!previousRef || !(previousRef.value instanceof ChatReferenceDiagnostic) || !(ref.value instanceof ChatReferenceDiagnostic) || !isEqual(previousRef.value.diagnostics[0][0], ref.value.diagnostics[0][0])) {
				ordered.push(ref);
				continue;
			}

			// Check if the diagnostics are in intersecting ranges.
			const currentDiagnosticRange = toEditorRange(ref.value.diagnostics[0][1][0].range);
			const previousDiagnosticRange = toEditorRange(previousRef.value.diagnostics[0][1][0].range);
			if (EditorRange.areIntersectingOrTouching(previousDiagnosticRange, currentDiagnosticRange)) {
				// Merge diagnostics into previous entry
				previousRef.value.diagnostics[0][1].push(...ref.value.diagnostics[0][1]);
			} else {
				ordered.push(ref);
			}
		}
	}
	return ordered;
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
		if (providedId && providedId.startsWith('prompt:')) {
			// Skip prompt file attachments, handled elsewhere
			continue;
		}
		const isUntitledFile = providedId?.startsWith('file:untitled-') || false;
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
		if (!filePath) { continue; }
		const startLine = linesMatch ? parseInt(linesMatch[1], 10) : undefined;
		const endLine = linesMatch ? parseInt(linesMatch[2], 10) : undefined;
		const uri = isUntitledFile && filePath.startsWith('untitled:') ? URI.from({ scheme: Schemas.untitled, path: filePath.substring('untitled:'.length) }) : URI.file(filePath);
		const location = (typeof startLine === 'undefined' || typeof endLine === 'undefined' || isNaN(startLine) || isNaN(endLine)) ? undefined : new Location(uri, new Range(startLine - 1, 0, endLine - 1, 0));

		const locName = providedId ?? (location ? JSON.stringify(location) : uri.toString());
		let range: [number, number] | undefined = undefined;
		let id = (location ? JSON.stringify(location) : uri.toString());
		if (prompt.includes(`#${locName}`)) {
			const idx = prompt.indexOf(`#${locName}`);
			range = [idx, idx + locName.length];
		}
		if (locName.startsWith('sym:')) {
			id = `vscode.symbol/${(location ? JSON.stringify(location) : uri.toString())}`;
		}
		references.push({
			id,
			name: locName,
			range,
			value: location ?? uri
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
 * Parse the raw user prompt and extract prompt file attachments
 * contained inside a single <attachments>...</attachments> block.
 *
 * Recognized elements:
 *  - <attachment id="prompt:...">Prompt instructions file:\n// filepath: ...\n...</attachment>
 *    -> Converted into ChatPromptReference with special id prefix "vscode.prompt.file__"
 */
function extractPromptReferences(prompt: string): ChatPromptReference[] {
	const references: ChatPromptReference[] = [];

	const attachmentsBlockMatch = prompt.match(/<attachments>([\s\S]*?)<\/attachments>/i);
	if (!attachmentsBlockMatch) {
		return references;
	}
	const block = attachmentsBlockMatch[1];

	// Parse prompt attachments (<attachment id="prompt:..."> blocks)
	const attachmentRegex = /<attachment\s+id="(prompt:[^"]+)">([\s\S]*?)<\/attachment>/gi;
	for (let m; (m = attachmentRegex.exec(block));) {
		const idAttr = m[1]; // e.g., "prompt:Untitled-1"
		const content = m[2];

		// Extract filepath from the content using various comment patterns
		let filePath: string | undefined;

		// Look for // filepath: or /// filepath: pattern
		const filepathMatch = content.match(/^\s*\/\/+\s*filepath:\s*(.+?)(?:\r?\n|$)/im);
		if (filepathMatch) {
			filePath = filepathMatch[1].trim();
		}

		if (!filePath) {
			// Fallback: look for # filepath: pattern
			const hashMatch = content.match(/^\s*#\s*filepath:\s*(.+?)(?:\r?\n|$)/im);
			if (hashMatch) {
				filePath = hashMatch[1].trim();
			}
		}

		if (!filePath) {
			continue;
		}

		// Parse URI from filepath (could be untitled: scheme or file path)
		let uri: URI;
		if (filePath.startsWith('untitled:')) {
			uri = URI.parse(filePath);
		} else {
			uri = URI.file(filePath);
		}

		// Create the special ID with prefix
		const id = `${PromptFileIdPrefix}__${uri.toString()}`;
		const name = idAttr;

		references.push({
			id,
			name,
			value: uri,
			modelDescription: 'Prompt instruction file'
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
function extractDiagnostics(prompt: string): ChatPromptReference[] {
	const diagnostics: ChatPromptReference[] = [];

	const attachmentsBlockMatch = prompt.match(/<attachments>([\s\S]*?)<\/attachments>/i);
	if (!attachmentsBlockMatch) {
		return diagnostics;
	}
	const block = attachmentsBlockMatch[1];

	// Parse diagnostics (<error ...> tags)
	const errorRegex = /<error\s+([^>]+)>([\s\S]*?)<\/error>/gi;
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
		const code = attrs['code'] && attrs['code'] !== 'undefined' ? attrs['code'] : undefined;
		const severityStr = (attrs['severity'] || 'error').toLowerCase();
		const severityMap: Record<string, number> = { error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning, info: DiagnosticSeverity.Information, hint: DiagnosticSeverity.Hint };
		const uri = URI.file(filePath);
		const range = new Range(lineNum - 1, 0, lineNum - 1, 0);
		const diagnostic = new Diagnostic(range, message, severityMap[severityStr]);
		diagnostic.code = code;
		diagnostics.push({
			id: `${uri.toString()}:${severityToString(diagnostic.severity)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`,
			name: diagnostic.message,
			range: undefined,
			value: new ChatReferenceDiagnostic([[uri, [diagnostic]]])
		});
	}

	return diagnostics;
}

function severityToString(severity: DiagnosticSeverity): string {
	switch (severity) {
		case DiagnosticSeverity.Error: return 'error';
		case DiagnosticSeverity.Warning: return 'warning';
		case DiagnosticSeverity.Information: return 'info';
		case DiagnosticSeverity.Hint: return 'hint';
		default: return '';
	}
}
// Single-tag extractors used by ordered parsing
function extractResourcesFromTag(prompt: string, tagText: string): ChatPromptReference | undefined {
	// Self-closing attachment
	if (/^<attachment\s+[^>]*\/>$/i.test(tagText.trim())) {
		const attrs: Record<string, string> = {};
		for (const attrMatch of tagText.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
			attrs[attrMatch[1]] = attrMatch[2];
		}
		const isFolder = attrs['folderPath'] !== undefined && attrs['folderPath'] !== '' && attrs['filePath'] === undefined;
		const fileOrFolderpath = attrs['filePath'] || attrs['folderPath'];
		if (!fileOrFolderpath) {
			return undefined;
		}
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
		return { id, name: locName, range, value: uri };
	}

	// Normal attachment with content
	const content = tagText;
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
	if (providedId && providedId.startsWith('prompt:')) {
		return undefined; // prompt attachments handled elsewhere
	}
	const isUntitledFile = providedId?.startsWith('file:untitled-') || false;
	const fenceMatch = content.match(/```([^\n`]+)\n([\s\S]*?)```/);
	const fencedLanguage = fenceMatch ? fenceMatch[1].trim() : undefined;
	const codeBlockBody = fenceMatch ? fenceMatch[2] : undefined;
	if (codeBlockBody) {
		const re = createFilepathRegexp(fencedLanguage);
		for (const line of codeBlockBody.split(/\r?\n/)) {
			const lineMatch = re.exec(line);
			if (lineMatch && lineMatch[1]) { filePath = lineMatch[1].trim(); break; }
		}
	}
	if (!filePath) {
		const simpleMatch = content.match(/[#\/]\s*filepath:\s*(\S+)/);
		if (simpleMatch) { filePath = simpleMatch[1]; }
	}
	if (!filePath) {
		const excerptMatch = content.match(/Excerpt from ([^,]+),\s*lines\s+(\d+)\s+to\s+(\d+)/i);
		if (excerptMatch) { filePath = excerptMatch[1].trim(); }
	}
	const linesMatch = content.match(/Excerpt from [^,]+,\s*lines\s+(\d+)\s+to\s+(\d+)/i);
	if (!filePath) { return undefined; }
	const startLine = linesMatch ? parseInt(linesMatch[1], 10) : undefined;
	const endLine = linesMatch ? parseInt(linesMatch[2], 10) : undefined;
	const uri = isUntitledFile && filePath.startsWith('untitled:') ? URI.from({ scheme: Schemas.untitled, path: filePath.substring('untitled:'.length) }) : URI.file(filePath);
	const location = (typeof startLine === 'undefined' || typeof endLine === 'undefined' || isNaN(startLine) || isNaN(endLine)) ? undefined : new Location(uri, new Range(startLine - 1, 0, endLine - 1, 0));
	const locName = providedId ?? (location ? JSON.stringify(location) : uri.toString());
	let range: [number, number] | undefined = undefined;
	let id = (location ? JSON.stringify(location) : uri.toString());
	if (prompt.includes(`#${locName}`)) {
		const idx = prompt.indexOf(`#${locName}`);
		range = [idx, idx + locName.length];
	}
	if (locName.startsWith('sym:')) { id = `vscode.symbol/${(location ? JSON.stringify(location) : uri.toString())}`; }
	return { id, name: locName, range, value: location ?? uri };
}

function extractPromptReferencesFromTag(prompt: string, tagText: string): ChatPromptReference | undefined {
	const idAttrMatch = tagText.match(/<attachment\s+id="(prompt:[^"]+)"[\s\S]*?>/i);
	if (!idAttrMatch) { return undefined; }
	const idAttr = idAttrMatch[1];
	const contentMatch = tagText.match(/<attachment[\s\S]*?>([\s\S]*?)<\/attachment>/i);
	const content = contentMatch ? contentMatch[1] : '';

	let filePath: string | undefined;
	const filepathMatch = content.match(/^\s*\/\/+\s*filepath:\s*(.+?)(?:\r?\n|$)/im);
	if (filepathMatch) { filePath = filepathMatch[1].trim(); }
	if (!filePath) {
		const hashMatch = content.match(/^\s*#\s*filepath:\s*(.+?)(?:\r?\n|$)/im);
		if (hashMatch) { filePath = hashMatch[1].trim(); }
	}
	if (!filePath) { return undefined; }
	let uri: URI;
	if (filePath.startsWith('untitled:')) { uri = URI.parse(filePath); } else { uri = URI.file(filePath); }
	const id = `${PromptFileIdPrefix}__${uri.toString()}`;
	const name = idAttr;
	return { id, name, value: uri, modelDescription: 'Prompt instruction file' };
}

function extractDiagnosticsFromTag(tagText: string): ChatPromptReference | undefined {
	const m = tagText.match(/<error\s+([^>]+)>([\s\S]*?)<\/error>/i);
	if (!m) { return undefined; }
	const attrText = m[1];
	const message = m[2].trim();
	const attrs: Record<string, string> = {};
	for (const attrMatch of attrText.matchAll(/(\w+)="([^"]*)"/g)) { attrs[attrMatch[1]] = attrMatch[2]; }
	for (const attrMatch of attrText.matchAll(/(\w+)=([0-9]+)/g)) { if (!attrs[attrMatch[1]]) { attrs[attrMatch[1]] = attrMatch[2]; } }
	const filePath = attrs['path'];
	const lineStr = attrs['line'];
	if (!filePath || !lineStr) { return undefined; }
	const lineNum = parseInt(lineStr, 10);
	if (isNaN(lineNum) || lineNum < 1) { return undefined; }
	const code = attrs['code'] && attrs['code'] !== 'undefined' ? attrs['code'] : undefined;
	const severityStr = (attrs['severity'] || 'error').toLowerCase();
	const severityMap: Record<string, number> = { error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning, info: DiagnosticSeverity.Information, hint: DiagnosticSeverity.Hint };
	const uri = URI.file(filePath);
	const range = new Range(lineNum - 1, 0, lineNum - 1, 0);
	const diagnostic = new Diagnostic(range, message, severityMap[severityStr]);
	diagnostic.code = code;
	return {
		id: `${uri.toString()}:${severityToString(diagnostic.severity)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`,
		name: diagnostic.message,
		range: undefined,
		value: new ChatReferenceDiagnostic([[uri, [diagnostic]]])
	} as ChatPromptReference;
}

function toEditorRange(range: Range): EditorRange {
	return new EditorRange(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}

export function getFolderAttachmentPath(folderPath: string): string {
	if (folderPath.endsWith('/') || folderPath.endsWith('\\')) {
		return folderPath;
	}
	return folderPath + path.sep;
}

