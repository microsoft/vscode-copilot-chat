/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { VSBuffer } from '../../../vs/base/common/buffer';
import { MarkdownString } from './markdownString';

export class ChatResponseMarkdownPart {
	value: vscode.MarkdownString;
	constructor(value: string | vscode.MarkdownString) {
		this.value = typeof value === 'string' ? new MarkdownString(value) : value;
	}
}

export class ChatResponseCodeblockUriPart {
	value: vscode.Uri;
	constructor(value: vscode.Uri) {
		this.value = value;
	}
}

export class ChatResponseFileTreePart {
	value: vscode.ChatResponseFileTree[];
	baseUri: vscode.Uri;
	constructor(value: vscode.ChatResponseFileTree[], baseUri: vscode.Uri) {
		this.value = value;
		this.baseUri = baseUri;
	}
}
export class ChatResponseAnchorPart {
	value: vscode.Uri | vscode.Location;
	value2: any;
	title?: string;
	constructor(value: vscode.Uri | vscode.Location, title?: string) {
		this.value = value;
		this.title = title;
	}
}

export class ChatResponseProgressPart {
	value: string;
	constructor(value: string) {
		this.value = value;
	}
}

export class ChatResponseProgressPart2 {
	value: string;
	task?: (progress: vscode.Progress<vscode.ChatResponseWarningPart>) => Thenable<string | void>;
	constructor(value: string, task?: (progress: vscode.Progress<vscode.ChatResponseWarningPart>) => Thenable<string | void>) {
		this.value = value;
		this.task = task;
	}
}

export class ChatResponseWarningPart {
	value: vscode.MarkdownString;
	constructor(value: string | vscode.MarkdownString) {
		this.value = typeof value === 'string' ? new MarkdownString(value) : value;
	}
}

export class ChatResponseReferencePart {
	value: vscode.Uri | vscode.Location;
	constructor(value: vscode.Uri | vscode.Location) {
		this.value = value;
	}
}

export class ChatResponseReferencePart2 {
	value: vscode.Uri | vscode.Location | { variableName: string; value?: vscode.Uri | vscode.Location };
	iconPath?: vscode.Uri | vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri };
	options?: { status?: { description: string; kind: vscode.ChatResponseReferencePartStatusKind } };
	constructor(value: vscode.Uri | vscode.Location | { variableName: string; value?: vscode.Uri | vscode.Location }, iconPath?: vscode.Uri | vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri }, options?: { status?: { description: string; kind: vscode.ChatResponseReferencePartStatusKind } }) {
		this.value = value;
		this.iconPath = iconPath;
		this.options = options;
	}
}

export class ChatResponseMovePart {

	readonly uri: vscode.Uri;
	readonly range: vscode.Range;

	constructor(uri: vscode.Uri, range: vscode.Range) {
		this.uri = uri;
		this.range = range;
	}
}

export class ChatResponseExtensionsPart {

	readonly extensions: string[];

	constructor(extensions: string[]) {
		this.extensions = extensions;
	}
}

export class ChatResponsePullRequestPart {
	readonly uri: vscode.Uri;
	readonly linkTag: string;
	readonly title: string;
	readonly description: string;
	readonly author: string;
	constructor(uri: vscode.Uri, title: string, description: string, author: string, linkTag: string) {
		this.uri = uri;
		this.title = title;
		this.description = description;
		this.author = author;
		this.linkTag = linkTag;
	}
}


export class ChatResponseCodeCitationPart {
	value: vscode.Uri;
	license: string;
	snippet: string;
	constructor(value: vscode.Uri, license: string, snippet: string) {
		this.value = value;
		this.license = license;
		this.snippet = snippet;
	}
}

export class ChatResponseCommandButtonPart {
	value: vscode.Command;
	constructor(value: vscode.Command) {
		this.value = value;
	}
}

export class ChatResponseMarkdownWithVulnerabilitiesPart {
	value: vscode.MarkdownString;
	vulnerabilities: vscode.ChatVulnerability[];
	constructor(value: string | vscode.MarkdownString, vulnerabilities: vscode.ChatVulnerability[]) {
		this.value = typeof value === 'string' ? new MarkdownString(value) : value;
		this.vulnerabilities = vulnerabilities;
	}
}

export class ChatResponseTextEditPart {
	uri: vscode.Uri;
	edits: vscode.TextEdit[];
	isDone?: boolean;
	constructor(uri: vscode.Uri, editsOrDone: vscode.TextEdit | vscode.TextEdit[] | true) {
		this.uri = uri;
		if (editsOrDone === true) {
			this.isDone = true;
			this.edits = [];
		} else {
			this.edits = Array.isArray(editsOrDone) ? editsOrDone : [editsOrDone];
		}
	}
}

export class ChatResponseNotebookEditPart implements vscode.ChatResponseNotebookEditPart {
	uri: vscode.Uri;
	edits: vscode.NotebookEdit[];
	isDone?: boolean;
	constructor(uri: vscode.Uri, editsOrDone: vscode.NotebookEdit | vscode.NotebookEdit[] | true) {
		this.uri = uri;
		if (editsOrDone === true) {
			this.isDone = true;
			this.edits = [];
		} else {
			this.edits = Array.isArray(editsOrDone) ? editsOrDone : [editsOrDone];

		}
	}
}

export class ChatResponseConfirmationPart {
	title: string;
	message: string;
	data: any;
	buttons: string[] | undefined;
	constructor(title: string, message: string, data: any, buttons?: string[]) {
		this.title = title;
		this.message = message;
		this.data = data;
		this.buttons = buttons;
	}
}

export class ChatPrepareToolInvocationPart {
	toolName: string;
	/**
	 * @param toolName The name of the tool being prepared for invocation.
	 */
	constructor(toolName: string) {
		this.toolName = toolName;
	}
}

export class ChatRequestTurn implements vscode.ChatRequestTurn {
	constructor(
		readonly prompt: string,
		readonly command: string | undefined,
		readonly references: vscode.ChatPromptReference[],
		readonly participant: string,
		readonly toolReferences: vscode.ChatLanguageModelToolReference[]
	) { }
}

export class ChatResponseTurn implements vscode.ChatResponseTurn {

	constructor(
		readonly response: ReadonlyArray<ChatResponseMarkdownPart | ChatResponseFileTreePart | ChatResponseAnchorPart | ChatResponseCommandButtonPart>,
		readonly result: vscode.ChatResult,
		readonly participant: string,
		readonly command?: string
	) { }
}

export class ChatRequestEditorData {
	constructor(
		readonly document: vscode.TextDocument,
		readonly selection: vscode.Selection,
		readonly wholeRange: vscode.Range,
	) { }
}

export class ChatRequestNotebookData {
	constructor(
		readonly cell: vscode.TextDocument
	) { }
}


export class ChatReferenceDiagnostic {
	constructor(
		readonly diagnostics: [vscode.Uri, vscode.Diagnostic[]][]
	) { }
}


export class ChatReferenceBinaryData {
	constructor(
		readonly mimeType: string,
		readonly data: () => Thenable<Uint8Array>
	) { }
}

export class LanguageModelToolResult {
	constructor(public content: (LanguageModelTextPart | LanguageModelPromptTsxPart | unknown)[]) { }
}

export class LanguageModelToolResult2 {
	constructor(public content: (LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown)[]) { }
}

export class LanguageModelTextPart implements vscode.LanguageModelTextPart {
	value: string;

	constructor(value: string) {
		this.value = value;

	}
}

export enum ToolResultAudience {
	Assistant = 0,
	User = 1,
}

export class LanguageModelTextPart2 extends LanguageModelTextPart {
	audience: ToolResultAudience[] | undefined;
	constructor(value: string, audience?: ToolResultAudience[]) {
		super(value);
		this.audience = audience;
	}
}
export class LanguageModelDataPart implements vscode.LanguageModelDataPart {
	mimeType: string;
	data: Uint8Array<ArrayBufferLike>;

	constructor(data: Uint8Array, mimeType: string) {
		this.mimeType = mimeType;
		this.data = data;
	}

	static image(data: Uint8Array<ArrayBufferLike>, mimeType: string): vscode.LanguageModelDataPart {
		return new LanguageModelDataPart(data, mimeType);
	}

	static json(value: object): vscode.LanguageModelDataPart {
		const rawStr = JSON.stringify(value, undefined, '\t');
		return new LanguageModelDataPart(VSBuffer.fromString(rawStr).buffer, 'json');
	}

	static text(value: string): vscode.LanguageModelDataPart {
		return new LanguageModelDataPart(VSBuffer.fromString(value).buffer, 'text/plain');
	}
}

export class LanguageModelDataPart2 extends LanguageModelDataPart {
	audience: ToolResultAudience[] | undefined;
	constructor(data: Uint8Array, mimeType: string, audience?: ToolResultAudience[]) {
		super(data, mimeType);
		this.audience = audience;
	}
}

export enum ChatImageMimeType {
	PNG = 'image/png',
	JPEG = 'image/jpeg',
	GIF = 'image/gif',
	WEBP = 'image/webp',
	BMP = 'image/bmp',
}

export class LanguageModelPromptTsxPart {
	value: unknown;

	constructor(value: unknown) {
		this.value = value;
	}
}

export enum ExcludeSettingOptions {
	None = 1,
	FilesExclude = 2,
	SearchAndFilesExclude = 3
}

export class TextSearchMatch2 {
	constructor(public uri: vscode.Uri, public ranges: { sourceRange: vscode.Range; previewRange: vscode.Range }[], public previewText: string) { }
}

export class AISearchKeyword {
	constructor(public keyword: string) { }
}

export enum ChatErrorLevel {
	Info = 0,
	Warning = 1,
	Error = 2
}

export enum ChatRequestEditedFileEventKind {
	Keep = 1,
	Undo = 2,
	UserModification = 3,
}

export enum ChatResponseClearToPreviousToolInvocationReason {
	NoReason = 0,
	FilteredContentRetry = 1,
	CopyrightContentRetry = 2,
}

export class LanguageModelToolExtensionSource implements vscode.LanguageModelToolExtensionSource {
	constructor(public readonly id: string, public readonly label: string) { }
}

export class LanguageModelToolMCPSource implements vscode.LanguageModelToolMCPSource {
	constructor(public readonly label: string, public readonly name: string, public readonly instructions: string | undefined) { }
}
