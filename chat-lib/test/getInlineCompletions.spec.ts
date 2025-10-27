/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Load env
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import { ResultType } from '#lib/ghostText/ghostText';
import { createTextDocument } from '#lib/test/textDocument';
import { TextDocumentIdentifier } from '#lib/textDocument';
import { TextDocumentChangeEvent, TextDocumentCloseEvent, TextDocumentFocusedEvent, TextDocumentOpenEvent, WorkspaceFoldersChangeEvent } from '#lib/textDocumentManager';
import { CAPIClient } from '@vscode/copilot-api';
import { readFile } from 'fs/promises';
import { join } from 'path';
import * as stream from 'stream';
import { assert, describe, expect, it } from 'vitest';
import { AuthenticationGetSessionOptions, AuthenticationSession, LanguageModelChat } from 'vscode';
import { CopilotToken, TokenEnvelope } from '../src/_internal/platform/authentication/common/copilotToken';
import { ChatEndpointFamily, EmbeddingsEndpointFamily } from '../src/_internal/platform/endpoint/common/endpointProvider';
import { MutableObservableWorkspace } from '../src/_internal/platform/inlineEdits/common/observableWorkspace';
import { FetchOptions, IAbortController, IHeaders, Response } from '../src/_internal/platform/networking/common/fetcherService';
import { IChatEndpoint, IEmbeddingsEndpoint, IFetcher } from '../src/_internal/platform/networking/common/networking';
import { Emitter, Event } from '../src/_internal/util/vs/base/common/event';
import { Disposable } from '../src/_internal/util/vs/base/common/lifecycle';
import { URI } from '../src/_internal/util/vs/base/common/uri';
import { ChatRequest } from '../src/_internal/vscodeTypes';
import { createInlineCompletionsProvider, IActionItem, IAuthenticationService, ICAPIClientService, ICompletionsStatusChangedEvent, ICompletionsTextDocumentManager, IEndpointProvider, ILogTarget, ITelemetrySender, LogLevel } from '../src/main';

class TestFetcher implements IFetcher {
	constructor(private readonly responses: Record<string, string>) { }

	getUserAgentLibrary(): string {
		return 'TestFetcher'; // matches the naming convention inside of completions
	}

	async fetch(url: string, options: FetchOptions): Promise<Response> {
		const uri = URI.parse(url);
		const responseText = this.responses[uri.path];

		const headers = new class implements IHeaders {
			get(name: string): string | null {
				return null;
			}
			*[Symbol.iterator](): Iterator<[string, string]> {
				// Empty headers for test
			}
		};

		const found = typeof responseText === 'string';
		return new Response(
			found ? 200 : 404,
			found ? 'OK' : 'Not Found',
			headers,
			async () => responseText || '',
			async () => JSON.parse(responseText || ''),
			async () => stream.Readable.from([responseText || ''])
		);
	}

	async disconnectAll(): Promise<unknown> {
		return Promise.resolve();
	}

	makeAbortController(): IAbortController {
		return new AbortController();
	}

	isAbortError(e: any): boolean {
		return e && e.name === 'AbortError';
	}

	isInternetDisconnectedError(e: any): boolean {
		return false;
	}

	isFetcherError(e: any): boolean {
		return false;
	}

	getUserMessageForFetcherError(err: any): string {
		return `Test fetcher error: ${err.message}`;
	}
}

function createTestCopilotToken(envelope?: Partial<Omit<TokenEnvelope, 'expires_at'>>): CopilotToken {
	const REFRESH_BUFFER_SECONDS = 60;
	const expires_at = Date.now() + ((envelope?.refresh_in ?? 0) + REFRESH_BUFFER_SECONDS) * 1000;
	return new CopilotToken({
		token: `test token ${Math.ceil(Math.random() * 100)}`,
		refresh_in: 0,
		expires_at,
		username: 'testuser',
		isVscodeTeamMember: false,
		copilot_plan: 'testsku',
		...envelope
	});
}

class TestAuthService extends Disposable implements IAuthenticationService {
	readonly _serviceBrand: undefined;
	readonly isMinimalMode = true;
	readonly anyGitHubSession = undefined;
	readonly permissiveGitHubSession = undefined;
	readonly copilotToken = createTestCopilotToken();
	speculativeDecodingEndpointToken: string | undefined;

	private readonly _onDidAuthenticationChange = this._register(new Emitter<void>());
	readonly onDidAuthenticationChange: Event<void> = this._onDidAuthenticationChange.event;

	private readonly _onDidAccessTokenChange = this._register(new Emitter<void>());
	readonly onDidAccessTokenChange = this._onDidAccessTokenChange.event;

	private readonly _onDidAdoAuthenticationChange = this._register(new Emitter<void>());
	readonly onDidAdoAuthenticationChange = this._onDidAdoAuthenticationChange.event;

	async getAnyGitHubSession(options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		return undefined;
	}

	async getPermissiveGitHubSession(options: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		return undefined;
	}

	async getCopilotToken(force?: boolean): Promise<CopilotToken> {
		return this.copilotToken;
	}

	resetCopilotToken(httpError?: number): void { }

	async getAdoAccessTokenBase64(options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
		return undefined;
	}
}

class TestTelemetrySender implements ITelemetrySender {
	events: { eventName: string; properties?: Record<string, string | undefined>; measurements?: Record<string, number | undefined> }[] = [];
	sendTelemetryEvent(eventName: string, properties?: Record<string, string | undefined>, measurements?: Record<string, number | undefined>): void {
		this.events.push({ eventName, properties, measurements });
	}
}

class TestEndpointProvider implements IEndpointProvider {
	readonly _serviceBrand: undefined;

	async getAllCompletionModels(forceRefresh?: boolean) {
		return [];
	}

	async getAllChatEndpoints() {
		return [];
	}

	async getChatEndpoint(requestOrFamily: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		throw new Error('Method not implemented.');
	}

	async getEmbeddingsEndpoint(family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
		throw new Error('Method not implemented.');
	}
}

class TestCAPIClientService extends CAPIClient implements ICAPIClientService {
	readonly _serviceBrand: undefined;
	constructor() {
		super({} as any, undefined, undefined as any /* IFetcherService */, '-');
	}
}

class TestDocumentManager extends Disposable implements ICompletionsTextDocumentManager {
	private readonly _onDidChangeTextDocument = this._register(new Emitter<TextDocumentChangeEvent>());
	readonly onDidChangeTextDocument = this._onDidChangeTextDocument.event;

	private readonly _onDidOpenTextDocument = this._register(new Emitter<TextDocumentOpenEvent>());
	readonly onDidOpenTextDocument = this._onDidOpenTextDocument.event;

	private readonly _onDidCloseTextDocument = this._register(new Emitter<TextDocumentCloseEvent>());
	readonly onDidCloseTextDocument = this._onDidCloseTextDocument.event;

	private readonly _onDidFocusTextDocument = this._register(new Emitter<TextDocumentFocusedEvent>());
	readonly onDidFocusTextDocument = this._onDidFocusTextDocument.event;

	private readonly _onDidChangeWorkspaceFolders = this._register(new Emitter<WorkspaceFoldersChangeEvent>());
	readonly onDidChangeWorkspaceFolders = this._onDidChangeWorkspaceFolders.event;

	getTextDocumentsUnsafe() {
		return [];
	}

	findNotebook(doc: TextDocumentIdentifier) {
		return undefined;
	}

	getWorkspaceFolders() {
		return [];
	}
}

class NullLogTarget implements ILogTarget {
	logIt(level: LogLevel, metadataStr: string, ...extra: any[]): void { }
}

describe('getInlineCompletions', () => {
	it('should return completions for a document and position', async () => {
		const provider = createInlineCompletionsProvider({
			fetcher: new TestFetcher({ '/v1/engines/gpt-4o-copilot/completions': await readFile(join(__dirname, 'getInlineCompletions.reply.txt'), 'utf8') }),
			authService: new TestAuthService(),
			telemetrySender: new TestTelemetrySender(),
			logTarget: new NullLogTarget(),
			isRunningInTest: true,
			contextProviderMatch: async () => 0,
			statusHandler: new class { didChange(_: ICompletionsStatusChangedEvent) { } },
			documentManager: new TestDocumentManager(),
			workspace: new MutableObservableWorkspace(),
			urlOpener: new class {
				async open(_url: string) { }
			},
			editorInfo: { name: 'test-editor', version: '1.0.0' },
			editorPluginInfo: { name: 'test-plugin', version: '1.0.0' },
			relatedPluginInfo: [],
			editorSession: {
				sessionId: 'test-session-id',
				machineId: 'test-machine-id',
			},
			notificationSender: new class {
				async showWarningMessage(_message: string, ..._items: IActionItem[]) { return undefined; }
			},
			endpointProvider: new TestEndpointProvider(),
			capiClientService: new TestCAPIClientService(),
		});
		const doc = createTextDocument('file:///test.txt', 'javascript', 1, 'function main() {\n\n}\n');

		const result = await provider.getInlineCompletions(doc, { line: 1, character: 0 });

		assert(result);
		expect(result.length).toBe(1);
		expect(result[0].resultType).toBe(ResultType.Async);
		expect(result[0].displayText).toBe('  console.log("Hello, World!");');
	});
});
