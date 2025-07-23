/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatResponseReferencePartStatusKind } from '@vscode/prompt-tsx';
import type { ChatResponseFileTree, ChatResponseStream, ChatVulnerability, Command, ExtendedChatResponsePart, Location, NotebookEdit, Progress, Uri } from 'vscode';
import { ChatPrepareToolInvocationPart, ChatResponseAnchorPart, ChatResponseClearReason, ChatResponseCodeblockUriPart, ChatResponseCodeCitationPart, ChatResponseCommandButtonPart, ChatResponseConfirmationPart, ChatResponseFileTreePart, ChatResponseMarkdownPart, ChatResponseMarkdownWithVulnerabilitiesPart, ChatResponseNotebookEditPart, ChatResponseProgressPart, ChatResponseProgressPart2, ChatResponseReferencePart, ChatResponseReferencePart2, ChatResponseTextEditPart, ChatResponseWarningPart, MarkdownString, TextEdit } from '../../vscodeTypes';
import type { ThemeIcon } from '../vs/base/common/themables';


export interface FinalizableChatResponseStream extends ChatResponseStream {
	finalize(): Promise<void>;
}


export function tryFinalizeResponseStream(stream: ChatResponseStream | FinalizableChatResponseStream) {
	if (typeof (stream as FinalizableChatResponseStream).finalize === 'function') {
		return (stream as FinalizableChatResponseStream).finalize();
	}
}
/**
 * A `ChatResponseStream` that forwards all calls to a single callback.
 */
export class ChatResponseStreamImpl implements FinalizableChatResponseStream {

	public static spy(stream: ChatResponseStream, callback: (part: ExtendedChatResponsePart) => void, finalize?: () => void): ChatResponseStreamImpl {
		return new ChatResponseStreamImpl(
			(value) => {
				callback(value);
				stream.push(value);
			}, (reason) => {
				stream.clear(reason);
			}, () => {
				finalize?.();
				return tryFinalizeResponseStream(stream);
			}
		);
	}

	public static filter(stream: ChatResponseStream, callback: (part: ExtendedChatResponsePart) => boolean, finalize?: () => void): ChatResponseStreamImpl {
		return new ChatResponseStreamImpl((value) => {
			if (callback(value)) {
				stream.push(value);
			}
		}, (reason) => {
			stream.clear(reason);
		}, () => {
			finalize?.();
			return tryFinalizeResponseStream(stream);
		});
	}

	constructor(
		private readonly _push: (part: ExtendedChatResponsePart) => void,
		private readonly _clear: (reason: ChatResponseClearReason) => void,
		private readonly _finalize?: () => void | Promise<void>,
	) { }

	async finalize(): Promise<void> {
		await this._finalize?.();
	}

	clear(reason: ChatResponseClearReason): void {
		this._clear(reason);
	}

	markdown(value: string | MarkdownString): void {
		this._push(new ChatResponseMarkdownPart(value));
	}

	anchor(value: Uri | Location, title?: string | undefined): void {
		this._push(new ChatResponseAnchorPart(value, title));
	}

	button(command: Command): void {
		this._push(new ChatResponseCommandButtonPart(command));
	}

	filetree(value: ChatResponseFileTree[], baseUri: Uri): void {
		this._push(new ChatResponseFileTreePart(value, baseUri));
	}

	progress(value: string, task?: (progress: Progress<ChatResponseWarningPart | ChatResponseReferencePart>) => Thenable<string | void>): void {
		if (typeof task === 'undefined') {
			this._push(new ChatResponseProgressPart(value));
		} else {
			this._push(new ChatResponseProgressPart2(value, task));
		}
	}

	reference(value: Uri | Location | { variableName: string; value?: Uri | Location }, iconPath?: Uri | ThemeIcon | { light: Uri; dark: Uri }): void {
		this._push(new ChatResponseReferencePart(value as any, iconPath));
	}

	reference2(value: Uri | Location | { variableName: string; value?: Uri | Location }, iconPath?: Uri | ThemeIcon | { light: Uri; dark: Uri }, options?: { status?: { description: string; kind: ChatResponseReferencePartStatusKind } }): void {
		this._push(new ChatResponseReferencePart2(value as any, iconPath, options));
	}

	codeCitation(value: Uri, license: string, snippet: string): void {
		this._push(new ChatResponseCodeCitationPart(value, license, snippet));
	}

	push(part: ExtendedChatResponsePart): void {
		this._push(part);
	}

	textEdit(target: Uri, editsOrDone: TextEdit | TextEdit[] | true): void {
		if (Array.isArray(editsOrDone) || editsOrDone instanceof TextEdit) {
			this._push(new ChatResponseTextEditPart(target, editsOrDone));
		} else {
			const part = new ChatResponseTextEditPart(target, []);
			part.isDone = true;
			this._push(part);
		}
	}

	notebookEdit(target: Uri, editsOrDone: NotebookEdit | NotebookEdit[] | true): void {
		if (editsOrDone === true) {
			this._push(new ChatResponseNotebookEditPart(target, true));
		} else if (Array.isArray(editsOrDone)) {
			this._push(new ChatResponseNotebookEditPart(target, editsOrDone));
		} else {
			this._push(new ChatResponseNotebookEditPart(target, editsOrDone));
		}
	}

	markdownWithVulnerabilities(value: string | MarkdownString, vulnerabilities: ChatVulnerability[]): void {
		this._push(new ChatResponseMarkdownWithVulnerabilitiesPart(value, vulnerabilities));
	}

	codeblockUri(value: Uri, isEdit?: boolean): void {
		try {
			this._push(new ChatResponseCodeblockUriPart(value, isEdit));
		} catch { } // TODO@joyceerhl remove try/catch
	}

	confirmation(title: string, message: string, data: any, buttons?: string[]): void {
		this._push(new ChatResponseConfirmationPart(title, message, data, buttons));
	}

	warning(value: string | MarkdownString): void {
		this._push(new ChatResponseWarningPart(value));
	}

	prepareToolInvocation(toolName: string): void {
		this._push(new ChatPrepareToolInvocationPart(toolName));
	}
}
