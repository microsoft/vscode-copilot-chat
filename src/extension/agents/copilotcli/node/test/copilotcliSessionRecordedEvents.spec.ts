/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Session, SessionOptions } from '@github/copilot/sdk';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthenticationSession, ChatResponseStream, ExtendedChatResponsePart } from 'vscode';
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import { ILogService } from '../../../../../platform/log/common/logService';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { ChatResponseStreamImpl } from '../../../../../util/common/chatResponseStreamImpl';
import { mock } from '../../../../../util/common/test/simpleMock';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../../util/vs/base/common/path';
import { URI } from '../../../../../util/vs/base/common/uri';
import { ChatResponseMarkdownPart, ChatSessionStatus, ChatToolInvocationPart, MarkdownString, Uri } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { CopilotCLISessionOptions, CopilotCLISessionOptionsService } from '../copilotCli';
import { CopilotCLISession } from '../copilotcliSession';
import { PermissionRequest } from '../permissionHelpers';

interface RecordingEventLine {
	type: string;
	data: { sessionId: string };
	id: string;
	timestamp: string;
	parentId: string | null;
}

// Build turn segments: first segment contains session/bootstrap events (non user.message before first user.message) + first user turn.
function segmentEvents(events: RecordingEventLine[]): RecordingEventLine[][] {
	const segments: RecordingEventLine[][] = [];
	let sessionBootstrap: RecordingEventLine[] = [];
	let currentTurn: RecordingEventLine[] | undefined;
	let seenFirstUser = false;
	for (const ev of events) {
		if (ev.type === 'user.message') {
			seenFirstUser = true;
			if (currentTurn) {
				segments.push(currentTurn);
			}
			currentTurn = [...sessionBootstrap, ev];
			// Clear bootstrap after attaching to first turn
			sessionBootstrap = [];
		} else {
			if (!seenFirstUser) {
				sessionBootstrap.push(ev);
			} else {
				currentTurn?.push(ev);
			}
		}
	}
	if (currentTurn) {
		segments.push(currentTurn);
	}
	return segments;
}

// Session that emits one turn per send() invocation; getEvents returns only emitted events so history grows incrementally.
class SegmentedRecordingSession implements Partial<Session> {
	private readonly onHandlers = new Map<string, Set<(payload: unknown) => void>>();
	public readonly sessionId: string;
	private _selectedModel: string | undefined = 'modelA';
	public authInfo: unknown;
	private readonly segments: RecordingEventLine[];
	private readonly turnBoundaries: number[]; // indices of start of each turn within segments array
	private nextTurnIndex = 0;
	private emittedEvents: RecordingEventLine[] = [];

	constructor(allEvents: RecordingEventLine[]) {
		const segs = segmentEvents(allEvents);
		this.segments = segs.flat();
		let offset = 0;
		this.turnBoundaries = segs.map(turn => {
			const start = offset;
			offset += turn.length;
			return start;
		});
		this.sessionId = allEvents.find(e => e.type === 'session.start')?.data.sessionId || 'recorded-session';
	}

	on(event: string, handler: (payload: unknown) => void) {
		if (!this.onHandlers.has(event)) {
			this.onHandlers.set(event, new Set());
		}
		this.onHandlers.get(event)!.add(handler);
		return () => this.onHandlers.get(event)!.delete(handler);
	}

	emit(event: string, data: unknown) {
		this.onHandlers.get(event)?.forEach(h => h({ data }));
		this.onHandlers.get('*')?.forEach(h => h({ data, type: event }));
	}

	async send(_args: { prompt: string }) {
		if (this.nextTurnIndex >= this.turnBoundaries.length) {
			return;
		}
		const start = this.turnBoundaries[this.nextTurnIndex];
		const end = this.nextTurnIndex + 1 < this.turnBoundaries.length ? this.turnBoundaries[this.nextTurnIndex + 1] : this.segments.length;
		for (let i = start; i < end; i++) {
			const ev = this.segments[i];
			this.emit(ev.type, ev.data);
			this.emittedEvents.push(ev);
		}
		this.nextTurnIndex++;
	}

	setAuthInfo(info: any) { this.authInfo = info; }
	async getSelectedModel() { return this._selectedModel; }
	async setSelectedModel(model: string) { this._selectedModel = model; }
	getEvents() { return this.emittedEvents as unknown as ReturnType<Session['getEvents']>; }
}

const anySession: AuthenticationSession = {
	id: 'test-session',
	accessToken: 'copilot-token',
	account: { id: 'acc', label: 'acc' },
	scopes: ['user:email']
};


function createWorkspaceService(root: string): IWorkspaceService {
	const rootUri = Uri.file(root);
	return new class extends TestWorkspaceService {
		override getWorkspaceFolders() {
			return [rootUri];
		}
		override getWorkspaceFolder(uri: Uri) {
			return uri.fsPath.startsWith(rootUri.fsPath) ? rootUri : undefined;
		}
	};
}


describe('CopilotCLISession (recorded events)', () => {
	const disposables = new DisposableStore();
	let logger: ILogService;
	let workspaceService: IWorkspaceService;
	let sessionOptionsService: CopilotCLISessionOptionsService;
	let sessionOptions: CopilotCLISessionOptions;
	const permissionsRequested: PermissionRequest[] = [];
	const streamContents: ExtendedChatResponsePart[] = [];
	let stream: ChatResponseStream;
	beforeEach(async () => {
		stream = new ChatResponseStreamImpl((part) => streamContents.push(part), () => { });
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		logger = accessor.get(ILogService);
		// Workspace service created per-test below (may be overridden in tests)
		workspaceService = createWorkspaceService('/workspace');
		const authService = new class extends mock<IAuthenticationService>() {
			override getAnyGitHubSession = async () => anySession;
		};
		sessionOptionsService = new CopilotCLISessionOptionsService(workspaceService, authService, logger);
		sessionOptions = await sessionOptionsService.createOptions({} as SessionOptions);
		// Wrap addPermissionHandler to capture the registered handler for tests simulating permission requests.
		disposables.add(sessionOptions.addPermissionHandler(async (request) => {
			permissionsRequested.push(request);
			return { kind: 'denied-interactively-by-user' };
		}));
	});
	afterEach(() => {
		disposables.clear();
		permissionsRequested.length = 0;
	});

	async function loadMockedSession(fixtureId: string) {
		const fixturePath = path.join(__dirname, 'fixtures', `${fixtureId}.jsonl`);
		const raw = await fs.promises.readFile(fixturePath, 'utf8');
		const recordingEvents: RecordingEventLine[] = raw.split(/\r?\n/).filter(l => l.trim().length).map(l => JSON.parse(l));

		const sdkSession = new SegmentedRecordingSession(recordingEvents);
		const session = disposables.add(new CopilotCLISession(
			sessionOptions,
			sdkSession as unknown as Session,
			logger,
			workspaceService,
			sessionOptionsService,
		));
		session.attchStream(stream);
		return session;
	}

	it('single-turn fixture: what is 1+1', async () => {
		const session = await loadMockedSession('2acc594f-590b-4c79-9fcc-c1b1ea774875');
		session.attchStream(stream);

		// Prompt matches user.message in recording.
		await session.handleRequest('what is 1+1', [], undefined, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Completed);
		expect(streamContents.length).toBe(1);
		expect(streamContents[0]).toBeInstanceOf(ChatResponseMarkdownPart);
		expect(getStringValue(streamContents[0] as ChatResponseMarkdownPart)).toBe('1 + 1 = 2');
	});

	it('multi-turn segmented: 1+1 then 2+2', async () => {
		const session = await loadMockedSession('cb2aca77-f42b-4dbd-a10a-41bd04eaa3ba');
		session.attchStream(stream);

		// First request -> only first turn emitted.
		await session.handleRequest('what is 1+1', [], undefined, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Completed);
		expect(streamContents.length).toBe(1);
		expect(streamContents[0]).toBeInstanceOf(ChatResponseMarkdownPart);
		expect(getStringValue(streamContents[0] as ChatResponseMarkdownPart)).toBe('1 + 1 = 2');

		// Second request -> second turn emitted.
		await session.handleRequest('what is 2+2', [], undefined, CancellationToken.None);
		expect(session.status).toBe(ChatSessionStatus.Completed);
		expect(streamContents.length).toBe(2);
		expect(streamContents[1]).toBeInstanceOf(ChatResponseMarkdownPart);
		expect(getStringValue(streamContents[1] as ChatResponseMarkdownPart)).toBe('2 + 2 = 4');
	});

	it('auto-approves view of workspace file without explicit handler', async () => {
		const session = await loadMockedSession('c8963ad7-e7b1-414c-a9fc-930905e76708');
		session.attchStream(stream);

		await session.handleRequest('Explain the contents of /one.ts', [], undefined, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Completed);
		expect(streamContents.length).toBe(3);

		expect(streamContents[0]).toBeInstanceOf(ChatResponseMarkdownPart);
		expect(getStringValue(streamContents[0] as ChatResponseMarkdownPart)).toContain('examine the contents');

		expect(streamContents[1]).toBeInstanceOf(ChatToolInvocationPart);
		expect(getStringValue((streamContents[1] as ChatToolInvocationPart).invocationMessage)).toContain(`Read ${formatUriForMessage('/one.ts')}`);
		expect((streamContents[1] as ChatToolInvocationPart).toolName).toBe('view');

		expect(streamContents[2]).toBeInstanceOf(ChatResponseMarkdownPart);
		expect(getStringValue(streamContents[2] as ChatResponseMarkdownPart)).toContain('proposed VS Code API');

		expect(permissionsRequested.length).toBe(0); // No explicit permission request
	});
});

function formatUriForMessage(path: string): string {
	return `[](${URI.file(path).toString()})`;
}

function getStringValue(value: undefined | string | MarkdownString | ChatResponseMarkdownPart): string {
	if (!value) {
		return '';
	}
	if (value && value instanceof ChatResponseMarkdownPart) {
		return getStringValue(value.value);
	}
	return typeof value === 'string' ? value : value.value;
}