/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ExtendedChatResponsePart } from 'vscode';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { ChatResponseTextEditPart, ChatResponseWorkspaceEditPart, TextEdit, WorkspaceEdit } from '../../../vscodeTypes';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { IBuildPromptContext } from '../../prompt/common/intents';

/**
 * A {@link ChatResponseStreamImpl} that collects text and workspace edit parts
 * pushed by tools, then applies them to disk via {@link IWorkspaceService} in a
 * single batch. Used in scenario‑automation (headless) mode where there is no
 * VS Code chat UI to stream edits into.
 *
 * **Usage pattern** (inside a tool's `invoke`):
 * ```ts
 * const mock = createAutomationPromptContext();
 * this._promptContext = mock.context;
 * // ... run normal tool code that streams edits to _promptContext.stream ...
 * await mock.stream.applyCollectedEdits(this.workspaceService);
 * ```
 */
export class AutomationResponseStream extends ChatResponseStreamImpl {
	private readonly _collectedTextEdits = new ResourceMap<TextEdit[]>();
	private readonly _collectedWorkspaceEdits: ChatResponseWorkspaceEditPart[] = [];

	constructor() {
		super(
			(part) => { this._collectPart(part); },
			() => { /* clearToPreviousToolInvocation — no-op */ },
			undefined,
			undefined,
			undefined,
			() => Promise.resolve(undefined),
		);
	}

	private _collectPart(part: ExtendedChatResponsePart): void {
		if (part instanceof ChatResponseTextEditPart) {
			if (!part.isDone && part.edits.length > 0) {
				const existing = this._collectedTextEdits.get(part.uri) ?? [];
				existing.push(...part.edits);
				this._collectedTextEdits.set(part.uri, existing);
			}
			// isDone signals are ignored — we flush all edits at once
		} else if (part instanceof ChatResponseWorkspaceEditPart) {
			this._collectedWorkspaceEdits.push(part);
		}
		// All other part types (markdown, anchors, etc.) are silently ignored
	}

	/**
	 * Build a {@link WorkspaceEdit} from everything collected and apply it.
	 *
	 * The caller is responsible for persisting documents to disk after this
	 * method returns (e.g. `vscode.workspace.saveAll(false)`) since there is
	 * no chat UI acceptance flow in automation mode.
	 */
	async applyCollectedEdits(workspaceService: IWorkspaceService): Promise<void> {
		const we = new WorkspaceEdit();

		// Text edits (insertions, replacements, deletions within files)
		for (const [uri, edits] of this._collectedTextEdits) {
			we.set(uri, edits);
		}

		// Workspace-level edits (file creations, deletions, renames)
		for (const wePart of this._collectedWorkspaceEdits) {
			for (const fileEdit of wePart.edits) {
				if (fileEdit.oldResource && !fileEdit.newResource) {
					we.deleteFile(fileEdit.oldResource);
				} else if (fileEdit.newResource && !fileEdit.oldResource) {
					we.createFile(fileEdit.newResource);
				} else if (fileEdit.oldResource && fileEdit.newResource) {
					we.renameFile(fileEdit.oldResource, fileEdit.newResource);
				}
			}
		}

		await workspaceService.applyEdit(we);
	}
}

interface AutomationPromptContextResult {
	context: IBuildPromptContext;
	stream: AutomationResponseStream;
}

/**
 * Creates a minimal {@link IBuildPromptContext} backed by an
 * {@link AutomationResponseStream} so that tools can run their normal
 * stream-based code path without a real VS Code chat session.
 */
export function createAutomationPromptContext(): AutomationPromptContextResult {
	const stream = new AutomationResponseStream();
	return {
		stream,
		context: {
			stream,
			query: '',
			history: [],
			chatVariables: new ChatVariablesCollection([]),
		},
	};
}
