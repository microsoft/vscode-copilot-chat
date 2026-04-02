/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName } from '../../../../platform/otel/common/index';
import { ICompletedSpanData, IOTelService, ISpanEventData, SpanStatusCode } from '../../../../platform/otel/common/otelService';
import { IExperimentationService, NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
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

	private readonly _onDidEmitSpanEvent = new Emitter<ISpanEventData>();
	readonly onDidEmitSpanEvent = this._onDidEmitSpanEvent.event;

	fireSpan(span: ICompletedSpanData): void {
		this._onDidCompleteSpan.fire(span);
	}

	fireSpanEvent(event: ISpanEventData): void {
		this._onDidEmitSpanEvent.fire(event);
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
	getConfig(key: { defaultValue: unknown }) { return key.defaultValue; }
	getExperimentBasedConfig(key: { defaultValue: unknown }) {
		if (key === ConfigKey.Advanced.ChatDebugFileLogging) {
			return true; // Enable file logging for tests
		}
		return key.defaultValue;
	}
	onDidChangeConfiguration = Event.None;
}

class TestTelemetryService {
	declare readonly _serviceBrand: undefined;
	sendMSFTTelemetryEvent() { }
}

class TestEnvService {
	declare readonly _serviceBrand: undefined;
	readonly vscodeVersion = '1.99.0-test';
	getVersion() { return '0.0.0-test'; }
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
			new TestEnvService() as unknown as IEnvService,
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

	it('writes tool call span for explicitly started session', async () => {
		await service.startSession('session-1');
		const span = makeToolCallSpan('session-1', 'read_file');
		otelService.fireSpan(span);

		expect(service.getActiveSessionIds()).toContain('session-1');
		expect(service.getLogPath('session-1')).toBeDefined();

		await service.flush('session-1');
		const entries = await readLogEntries('session-1');

		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe('session_start');
		expect(entries[1].type).toBe('tool_call');
		expect(entries[1].name).toBe('read_file');
		expect(entries[1].sid).toBe('session-1');
		expect(entries[1].status).toBe('ok');
	});

	it('writes LLM request with token counts', async () => {
		await service.startSession('session-1');
		const span = makeChatSpan('session-1', 'gpt-4o', 1000, 500);
		otelService.fireSpan(span);

		await service.flush('session-1');
		const entries = await readLogEntries('session-1');

		expect(entries).toHaveLength(2);
		expect(entries[1].type).toBe('llm_request');
		expect(entries[1].name).toBe('chat:gpt-4o');
		const attrs = entries[1].attrs as Record<string, unknown>;
		expect(attrs.model).toBe('gpt-4o');
		expect(attrs.inputTokens).toBe(1000);
		expect(attrs.outputTokens).toBe(500);
	});

	it('records error status from failed spans', async () => {
		await service.startSession('session-1');
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

		expect(entries[1].status).toBe('error');
		expect((entries[1].attrs as Record<string, unknown>).error).toBe('Command failed');
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
		await service.startSession('session-1');
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
		await service.startSession('session-1');
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

		const args = (entries[1].attrs as Record<string, unknown>).args as string;
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

	it('restarts flush timer when flushIntervalMs config changes at runtime', async () => {
		let configuredInterval = 4000;
		const configChangeEmitter = new Emitter<{ affectsConfiguration: (key: string) => boolean }>();

		const configService = {
			_serviceBrand: undefined as undefined,
			getConfig: () => configuredInterval,
			getExperimentBasedConfig: () => true,
			onDidChangeConfiguration: configChangeEmitter.event,
		};

		const svc = new ChatDebugFileLoggerService(
			otelService as unknown as IOTelService,
			new TestFileSystemService() as unknown as IFileSystemService,
			new TestExtensionContext(tmpDir) as unknown as IVSCodeExtensionContext,
			new TestLogService() as unknown as ILogService,
			configService as unknown as IConfigurationService,
			new NullExperimentationService() as unknown as IExperimentationService,
			new TestTelemetryService() as unknown as ITelemetryService,
			new TestEnvService() as unknown as IEnvService,
		);
		disposables.add(svc);
		disposables.add(configChangeEmitter);

		// Start a session so the flush timer is running
		const span = makeToolCallSpan('interval-test', 'read_file');
		otelService.fireSpan(span);
		expect(svc.getActiveSessionIds()).toContain('interval-test');

		// Spy on clearInterval/setInterval to verify timer restart
		const clearSpy = vi.spyOn(globalThis, 'clearInterval');
		const setSpy = vi.spyOn(globalThis, 'setInterval');

		// Change the configured interval and fire the config change event
		configuredInterval = 8000;
		configChangeEmitter.fire({
			affectsConfiguration: key => key === ConfigKey.Advanced.ChatDebugFileLoggingFlushInterval.fullyQualifiedId,
		});

		expect(clearSpy).toHaveBeenCalled();
		expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 8000);

		clearSpy.mockRestore();
		setSpy.mockRestore();
	});

	it('inherits session ID from parent span for child spans without session ID', async () => {
		await service.startSession('session-1');

		// Parent span with session ID
		const parentSpan = makeSpan({
			spanId: 'parent-span-1',
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
				[GenAiAttr.AGENT_NAME]: 'copilot',
				[CopilotChatAttr.CHAT_SESSION_ID]: 'session-1',
			},
		});
		otelService.fireSpan(parentSpan);

		// Child span without session ID but with parentSpanId
		const childSpan = makeSpan({
			spanId: 'child-span-1',
			parentSpanId: 'parent-span-1',
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
				[GenAiAttr.TOOL_NAME]: 'read_file',
				// No CHAT_SESSION_ID — should inherit from parent
			},
		});
		otelService.fireSpan(childSpan);

		await service.flush('session-1');
		const entries = await readLogEntries('session-1');

		const toolEntry = entries.find(e => e.type === 'tool_call');
		expect(toolEntry).toBeDefined();
		expect(toolEntry!.name).toBe('read_file');
		expect(toolEntry!.sid).toBe('session-1');
	});

	it('inherits session ID from parent span for user_message span events', async () => {
		await service.startSession('session-1');

		// Parent span with session ID
		const parentSpan = makeSpan({
			spanId: 'parent-span-2',
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
				[GenAiAttr.AGENT_NAME]: 'copilot',
				[CopilotChatAttr.CHAT_SESSION_ID]: 'session-1',
			},
		});
		otelService.fireSpan(parentSpan);

		// user_message event without session ID but with parentSpanId
		const spanEvent: ISpanEventData = {
			spanId: 'child-event-span',
			traceId: 'trace-1',
			parentSpanId: 'parent-span-2',
			eventName: 'user_message',
			attributes: { content: 'hello world' },
			timestamp: 1500,
		};
		otelService.fireSpanEvent(spanEvent);

		await service.flush('session-1');
		const entries = await readLogEntries('session-1');

		const userMsgEntry = entries.find(e => e.type === 'user_message');
		expect(userMsgEntry).toBeDefined();
		expect(userMsgEntry!.sid).toBe('session-1');
		expect((userMsgEntry!.attrs as Record<string, unknown>).content).toBe('hello world');
	});

	it('writes models.json when model snapshot is set before session starts', async () => {
		const models = [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: { type: 'chat', family: 'gpt-4o' } }];
		service.setModelSnapshot(models);

		await service.startSession('session-models');
		await service.flush('session-models');

		const sessionDir = service.getSessionDir('session-models');
		expect(sessionDir).toBeDefined();
		const modelsPath = path.join(sessionDir!.fsPath, 'models.json');
		const content = await fs.promises.readFile(modelsPath, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe('gpt-4o');
	});

	it('writes models.json when model snapshot arrives after session starts', async () => {
		await service.startSession('session-late');
		await service.flush('session-late');

		// Model snapshot arrives after session already started
		const models = [{ id: 'claude-sonnet', name: 'Claude Sonnet' }];
		service.setModelSnapshot(models);
		await service.flush('session-late');

		const sessionDir = service.getSessionDir('session-late');
		expect(sessionDir).toBeDefined();
		const modelsPath = path.join(sessionDir!.fsPath, 'models.json');
		const content = await fs.promises.readFile(modelsPath, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe('claude-sonnet');
	});

	it('does not write models.json more than once per session', async () => {
		const models = [{ id: 'gpt-4o', name: 'GPT-4o' }];
		service.setModelSnapshot(models);

		await service.startSession('session-dedup');
		await service.flush('session-dedup');

		const sessionDir = service.getSessionDir('session-dedup');
		const modelsPath = path.join(sessionDir!.fsPath, 'models.json');

		// Overwrite the file with different content to detect if it gets rewritten
		await fs.promises.writeFile(modelsPath, '"sentinel"', 'utf-8');

		// Calling setModelSnapshot again should NOT overwrite for existing sessions
		service.setModelSnapshot([{ id: 'new-model' }]);

		const content = await fs.promises.readFile(modelsPath, 'utf-8');
		expect(content).toBe('"sentinel"');
	});
});
