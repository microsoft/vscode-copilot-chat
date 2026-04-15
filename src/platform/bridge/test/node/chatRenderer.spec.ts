/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, test, vi } from 'vitest';
import { Script } from 'vm';

type AssistantExtraPayload = {
	readonly kind: string;
	readonly [key: string]: unknown;
};

type AssistantCommandPayload = {
	readonly commandId: string;
	readonly args: readonly unknown[] | undefined;
};

type ChatRendererPrototype = {
	appendAssistantExtra(this: TestRendererContext, turnId: string, extra: AssistantExtraPayload): void;
	uriLabel(this: unknown, uri: string): string;
};

type ChatRendererConstructor = {
	readonly prototype: ChatRendererPrototype;
};

type TestRendererEntry = {
	readonly extrasHost: TestElement;
	readonly extraKeys: Set<string>;
	readonly editExtraItems: Map<string, TestElement>;
};

type TestRendererContext = {
	startAssistantTurn(turnId: string): TestRendererEntry;
	scrollToBottom(): void;
	uriLabel(uri: string): string;
	commandRunner: (command: AssistantCommandPayload) => void;
};

class TestElement {
	readonly childNodes: TestElement[] = [];
	textContent = '';
	href = '';
	target = '';
	rel = '';
	type = '';

	private readonly listeners = new Map<string, Array<() => void>>();
	private classTokens = new Set<string>();
	private _className = '';

	readonly classList = {
		add: (...tokens: string[]) => {
			for (const token of tokens) {
				if (token.trim().length > 0) {
					this.classTokens.add(token);
				}
			}
			this.syncClassName();
		},
		remove: (...tokens: string[]) => {
			for (const token of tokens) {
				this.classTokens.delete(token);
			}
			this.syncClassName();
		},
		toggle: (token: string, force?: boolean) => {
			const shouldAdd = force === undefined ? !this.classTokens.has(token) : force;
			if (shouldAdd) {
				this.classTokens.add(token);
			} else {
				this.classTokens.delete(token);
			}
			this.syncClassName();
			return this.classTokens.has(token);
		},
		contains: (token: string) => this.classTokens.has(token),
		[Symbol.iterator]: () => this.classTokens.values(),
	};

	get className(): string {
		return this._className;
	}

	set className(value: string) {
		this._className = value;
		this.classTokens = new Set(value.split(/\s+/).map(token => token.trim()).filter(Boolean));
	}

	appendChild(child: TestElement): TestElement {
		this.childNodes.push(child);
		return child;
	}

	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type);
		if (listeners) {
			listeners.push(listener);
			return;
		}

		this.listeners.set(type, [listener]);
	}

	click(): void {
		for (const listener of this.listeners.get('click') ?? []) {
			listener();
		}
	}

	querySelector(selector: string): TestElement | null {
		if (!selector.startsWith('.')) {
			return null;
		}

		const className = selector.slice(1);
		for (const child of this.childNodes) {
			if (child.classList.contains(className)) {
				return child;
			}

			const nested = child.querySelector(selector);
			if (nested) {
				return nested;
			}
		}

		return null;
	}

	private syncClassName(): void {
		this._className = Array.from(this.classTokens.values()).join(' ');
	}
}

class TestDocument {
	createElement(_tagName: string): TestElement {
		return new TestElement();
	}
}

function loadChatRenderer(document: TestDocument): ChatRendererConstructor {
	const rendererScriptPath = path.resolve(process.cwd(), 'pwa/js/chat-renderer.js');
	const rendererScript = readFileSync(rendererScriptPath, 'utf8');
	const windowObject: { ChatRenderer?: unknown } = {};

	const sandbox = {
		window: windowObject,
		document,
		navigator: { clipboard: { writeText: async () => undefined } },
		URL,
		console,
	};

	new Script(rendererScript, { filename: rendererScriptPath }).runInNewContext(sandbox);
	if (typeof windowObject.ChatRenderer !== 'function') {
		throw new Error('ChatRenderer was not attached to window by the PWA renderer script.');
	}

	return windowObject.ChatRenderer as ChatRendererConstructor;
}

function createRendererContext(rendererPrototype: ChatRendererPrototype): { context: TestRendererContext; entry: TestRendererEntry; commandCalls: AssistantCommandPayload[] } {
	const entry: TestRendererEntry = {
		extrasHost: new TestElement(),
		extraKeys: new Set(),
		editExtraItems: new Map(),
	};

	const commandCalls: AssistantCommandPayload[] = [];
	const context: TestRendererContext = {
		startAssistantTurn: () => entry,
		scrollToBottom: vi.fn(),
		uriLabel: uri => rendererPrototype.uriLabel.call(undefined, uri),
		commandRunner: command => {
			commandCalls.push(command);
		},
	};

	return { context, entry, commandCalls };
}

describe('ChatRenderer extras rendering', () => {
	test('updates text edit extras in place', () => {
		const document = new TestDocument();
		const chatRenderer = loadChatRenderer(document);
		const { context, entry } = createRendererContext(chatRenderer.prototype);

		chatRenderer.prototype.appendAssistantExtra.call(context, 'turn-1', {
			kind: 'textEdit',
			uri: 'file:///workspace/src/example.ts',
			editCount: 1,
			isDone: false,
		});
		chatRenderer.prototype.appendAssistantExtra.call(context, 'turn-1', {
			kind: 'textEdit',
			uri: 'file:///workspace/src/example.ts',
			editCount: 3,
			isDone: true,
		});

		expect(entry.extrasHost.childNodes.length).toBe(1);
		const renderedItem = entry.extrasHost.childNodes[0];
		expect(renderedItem.textContent).toContain('Text edits: example.ts (3 edits, done)');
		expect(renderedItem.classList.contains('is-complete')).toBe(true);
	});

	test('renders remaining extra artifact kinds and supports pull request action button', () => {
		const document = new TestDocument();
		const chatRenderer = loadChatRenderer(document);
		const { context, entry, commandCalls } = createRendererContext(chatRenderer.prototype);

		chatRenderer.prototype.appendAssistantExtra.call(context, 'turn-2', {
			kind: 'extensions',
			extensions: ['ms-python.python', 'github.copilot-chat'],
		});
		chatRenderer.prototype.appendAssistantExtra.call(context, 'turn-2', {
			kind: 'pullRequest',
			title: 'Ship parity updates',
			description: 'Adds support for remaining response parts',
			author: 'octocat',
			linkTag: 'PR',
			commandId: 'vscode.open',
			commandArgs: ['https://github.com/org/repo/pull/10'],
		});
		chatRenderer.prototype.appendAssistantExtra.call(context, 'turn-2', {
			kind: 'externalEdit',
			uris: ['file:///workspace/src/edited.ts'],
		});
		chatRenderer.prototype.appendAssistantExtra.call(context, 'turn-2', {
			kind: 'multiDiff',
			title: 'Workspace changes',
			readOnly: true,
			entries: [
				{
					originalUri: 'file:///workspace/src/before.ts',
					modifiedUri: 'file:///workspace/src/after.ts',
					goToFileUri: 'file:///workspace/src/after.ts',
					added: 4,
					removed: 1,
				},
			],
		});

		expect(entry.extrasHost.childNodes.length).toBe(4);
		expect(entry.extrasHost.childNodes[0].textContent).toContain('Suggested extensions: ms-python.python, github.copilot-chat');
		expect(entry.extrasHost.childNodes[2].textContent).toContain('External edits applied: edited.ts');

		const pullRequestButton = entry.extrasHost.childNodes[1].querySelector('.assistant-command-button');
		expect(pullRequestButton).not.toBeNull();
		pullRequestButton?.click();
		expect(commandCalls).toEqual([
			{
				commandId: 'vscode.open',
				args: ['https://github.com/org/repo/pull/10'],
			},
		]);

		const multiDiffList = entry.extrasHost.childNodes[3].querySelector('.assistant-extra-list');
		expect(multiDiffList).not.toBeNull();
		expect(multiDiffList?.childNodes.length).toBe(1);
		expect(multiDiffList?.childNodes[0].textContent).toContain('after.ts (+4 -1)');
	});
});
