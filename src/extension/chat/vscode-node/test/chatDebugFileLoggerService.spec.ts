/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName } from '../../../../platform/otel/common/index';
import { ICompletedSpanData, IOTelService, SpanStatusCode } from '../../../../platform/otel/common/otelService';
import { IExperimentationService, NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatDebugFileLoggerService } from '../chatDebugFileLoggerService';

// ── Test helpers ──

function makeSpan(overrides: Partial<ICompletedSpanData> & { attributes?: Record<string, string | number | boolean | string[]> }): ICompletedSpanData {
	return {
		name: 'test-span',
		spanId: 'span-1',
		traceId: 'trace-1',
		startTime: 1000,
		endTime: 2000,
		status: { code: SpanStatusCode.OK },
		attributes: {},
		events: [],
		...overrides,
	};
}

function makeToolCallSpan(sessionId: string, toolName: string): ICompletedSpanData {
	return makeSpan({
		name: toolName,
		attributes: {
			[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
			[GenAiAttr.TOOL_NAME]: toolName,
			[CopilotChatAttr.CHAT_SESSION_ID]: sessionId,
		},
	});
}

function makeChatSpan(sessionId: string, model: string, inputTokens: number, outputTokens: number): ICompletedSpanData {
	return makeSpan({
		name: 'chat',
		attributes: {
			[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
			[GenAiAttr.REQUEST_MODEL]: model,
			[GenAiAttr.USAGE_INPUT_TOKENS]: inputTokens,
			[GenAiAttr.USAGE_OUTPUT_TOKENS]: outputTokens,
			[CopilotChatAttr.CHAT_SESSION_ID]: sessionId,
		},
	});
}

class TestOTelService {
	declare readonly _serviceBrand: undefined;
	readonly config = {} as never;

	private readonly _onDidCompleteSpan = new Emitter<ICompletedSpanData>();
	readonly onDidCompleteSpan = this._onDidCompleteSpan.event;

	private readonly _onDidEmitSpanEvent = new Emitter<never>();
	readonly onDidEmitSpanEvent = this._onDidEmitSpanEvent.event;

	fireSpan(span: ICompletedSpanData): void {
		this._onDidCompleteSpan.fire(span);
	}

	startSpan() { return { setAttribute() { }, setAttributes() { }, setStatus() { }, recordException() { }, addEvent() { }, getSpanContext() { return undefined; }, end() { } }; }
	startActiveSpan<T>(_n: string, _o: unknown, fn: (s: unknown) => Promise<T>) { return fn(this.startSpan()); }
	getActiveTraceContext() { return undefined; }
	storeTraceContext() { }
	getStoredTraceContext() { return undefined; }
	runWithTraceContext<T>(_c: unknown, fn: () => Promise<T>) { return fn(); }
	recordMetric() { }
	incrementCounter() { }
	emitLogRecord() { }
	async flush() { }
	async shutdown() { }

	dispose(): void {
		this._onDidCompleteSpan.dispose();
		this._onDidEmitSpanEvent.dispose();
	}
}

class TestExtensionContext {
	declare readonly _serviceBrand: undefined;
	readonly storageUri: URI;

	constructor(tmpDir: string) {
		this.storageUri = URI.file(tmpDir);
	}
}

class TestFileSystemService {
	declare readonly _serviceBrand: undefined;

	async stat(uri: URI) {
		const stats = await fs.promises.stat(uri.fsPath);
		return { mtime: stats.mtimeMs, ctime: stats.ctimeMs, size: stats.size };
	}

	async readDirectory(uri: URI) {
		const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
		return entries.map(e => [e.name, e.isFile() ? 1 : 2] as [string, number]);
	}

	async createDirectory(uri: URI) {
		await fs.promises.mkdir(uri.fsPath, { recursive: true });
	}

	async delete(uri: URI, options?: { recursive?: boolean }) {
		const stats = await fs.promises.stat(uri.fsPath);
		if (stats.isDirectory() && options?.recursive) {
			await fs.promises.rm(uri.fsPath, { recursive: true, force: true });
		} else {
			await fs.promises.unlink(uri.fsPath);
		}
	}
}

class TestLogService {
	declare readonly _serviceBrand: undefined;
	info() { }
	warn() { }
	error() { }
	debug() { }
	trace() { }
}

class TestConfigurationService {
	declare readonly _serviceBrand: undefined;
	getExperimentBasedConfig() { return true; }
}

class TestTelemetryService {
	declare readonly _serviceBrand: undefined;
	sendTelemetryEvent() { }
}

describe('ChatDebugFileLoggerService', () => {
	let disposables: DisposableStore;
	let tmpDir: string;
	let otelService: TestOTelService;
	let service: ChatDebugFileLoggerService;

	beforeEach(async () => {
		disposables = new DisposableStore();
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chatdebug-'));

		otelService = new TestOTelService();

		service = new ChatDebugFileLoggerService(
			otelService as unknown as IOTelService,
			new TestFileSystemService() as unknown as IFileSystemService,
			new TestExtensionContext(tmpDir) as unknown as IVSCodeExtensionContext,
			new TestLogService() as unknown as ILogService,
			new TestConfigurationService() as unknown as IConfigurationService,
			new NullExperimentationService() as unknown as IExperimentationService,
			new TestTelemetryService() as unknown as ITelemetryService,
		);
		disposables.add(service);
	});

	afterEach(async () => {
		disposables.dispose();
		otelService.dispose();
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	async function readLogEntries(sessionId: string): Promise<Record<string, unknown>[]> {
		const logPath = service.getLogPath(sessionId);
		if (!logPath) { return []; }
		const content = await fs.promises.readFile(logPath.fsPath, 'utf-8');
		return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	}

	it('auto-starts session and writes tool call span', async () => {
		const span = makeToolCallSpan('session-1', 'read_file');
		otelService.fireSpan(span);

		expect(service.getActiveSessionIds()).toContain('session-1');
		expect(service.getLogPath('session-1')).toBeDefined();

		await service.flush('session-1');
		const entries = await readLogEntries('session-1');

		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe('tool_call');
		expect(entries[0].name).toBe('read_file');
		expect(entries[0].sid).toBe('session-1');
		expect(entries[0].status).toBe('ok');
	});

	it('writes LLM request with token counts', async () => {
		const span = makeChatSpan('session-1', 'gpt-4o', 1000, 500);
		otelService.fireSpan(span);

		await service.flush('session-1');
		const entries = await readLogEntries('session-1');

		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe('llm_request');
		expect(entries[0].name).toBe('chat:gpt-4o');
		const attrs = entries[0].attrs as Record<string, unknown>;
		expect(attrs.model).toBe('gpt-4o');
		expect(attrs.inputTokens).toBe(1000);
		expect(attrs.outputTokens).toBe(500);
	});

	it('records error status from failed spans', async () => {
		const span = makeSpan({
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
				[GenAiAttr.TOOL_NAME]: 'run_in_terminal',
				[CopilotChatAttr.CHAT_SESSION_ID]: 'session-1',
			},
			status: { code: SpanStatusCode.ERROR, message: 'Command failed' },
		});
		otelService.fireSpan(span);

		await service.flush('session-1');
		const entries = await readLogEntries('session-1');

		expect(entries[0].status).toBe('error');
		expect((entries[0].attrs as Record<string, unknown>).error).toBe('Command failed');
	});

	it('isDebugLogUri returns true for files under debug-logs', () => {
		const debugLogUri = URI.joinPath(URI.file(tmpDir), 'debug-logs', 'session-1', 'main.jsonl');
		expect(service.isDebugLogUri(debugLogUri)).toBe(true);
	});

	it('isDebugLogUri returns false for unrelated URIs', () => {
		const otherUri = URI.file('/some/other/path/file.txt');
		expect(service.isDebugLogUri(otherUri)).toBe(false);
	});

	it('endSession flushes and removes session', async () => {
		otelService.fireSpan(makeToolCallSpan('session-1', 'read_file'));
		expect(service.getActiveSessionIds()).toContain('session-1');

		await service.endSession('session-1');
		expect(service.getActiveSessionIds()).not.toContain('session-1');

		// File should have been written in directory structure
		const logPath = URI.joinPath(URI.file(tmpDir), 'debug-logs', 'session-1', 'main.jsonl');
		const content = await fs.promises.readFile(logPath.fsPath, 'utf-8');
		expect(content.trim()).not.toBe('');
	});

	it('ignores spans without a session ID', async () => {
		const span = makeSpan({
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
				[GenAiAttr.TOOL_NAME]: 'some_tool',
				// No session ID
			},
		});
		otelService.fireSpan(span);

		expect(service.getActiveSessionIds()).toHaveLength(0);
	});

	it('truncates long attribute values', async () => {
		const longArgs = 'x'.repeat(6000);
		const span = makeSpan({
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
				[GenAiAttr.TOOL_NAME]: 'read_file',
				[GenAiAttr.TOOL_CALL_ARGUMENTS]: longArgs,
				[CopilotChatAttr.CHAT_SESSION_ID]: 'session-1',
			},
		});
		otelService.fireSpan(span);

		await service.flush('session-1');
		const entries = await readLogEntries('session-1');

		const args = (entries[0].attrs as Record<string, unknown>).args as string;
		expect(args.length).toBeLessThan(longArgs.length);
		expect(args).toContain('[truncated]');
	});

	it('routes child session spans to parent directory with cross-reference', async () => {
		// First, create a parent session
		otelService.fireSpan(makeToolCallSpan('parent-session', 'read_file'));

		// Fire a child session span (e.g., title generation) with parent info
		const titleSpan = makeChatSpan('title-child-id', 'gpt-4o-mini', 100, 20);
		const titleSpanWithParent: ICompletedSpanData = {
			...titleSpan,
			attributes: {
				...titleSpan.attributes,
				[CopilotChatAttr.PARENT_CHAT_SESSION_ID]: 'parent-session',
				[CopilotChatAttr.DEBUG_LOG_LABEL]: 'title',
			},
		};
		otelService.fireSpan(titleSpanWithParent);

		await service.flush('parent-session');
		await service.flush('title-child-id');

		// Parent's main.jsonl should contain the tool call + a child_session_ref
		const parentEntries = await readLogEntries('parent-session');
		const refEntry = parentEntries.find(e => e.type === 'child_session_ref');
		expect(refEntry).toBeDefined();
		expect((refEntry!.attrs as Record<string, unknown>).childLogFile).toBe('title-title-child-id.jsonl');
		expect((refEntry!.attrs as Record<string, unknown>).label).toBe('title');

		// Child's log file should be under the parent directory
		const childPath = service.getLogPath('title-child-id');
		expect(childPath).toBeDefined();
		expect(childPath!.fsPath).toContain('parent-session');
		expect(childPath!.fsPath).toContain('title-title-child-id.jsonl');

		// Child should have the LLM request entry
		const childEntries = await readLogEntries('title-child-id');
		expect(childEntries).toHaveLength(1);
		expect(childEntries[0].type).toBe('llm_request');
	});
});
