/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NullOpenTelemetryService } from '../../common/nullOpenTelemetryService';
import { DEFAULT_OTEL_CONFIG, IOpenTelemetryConfig } from '../../common/openTelemetryService';
import { FileOpenTelemetryService } from '../../node/fileOpenTelemetryService';
import { ILogService } from '../../../log/common/logService';
import { IEnvService } from '../../../env/common/envService';

describe('NullOpenTelemetryService', () => {
	let service: NullOpenTelemetryService;

	beforeEach(() => {
		service = new NullOpenTelemetryService();
	});

	it('should report isEnabled as false', () => {
		expect(service.isEnabled).toBe(false);
	});

	it('should return default config', () => {
		expect(service.getConfig()).toEqual(DEFAULT_OTEL_CONFIG);
	});

	it('should return undefined for spans', () => {
		expect(service.startSessionSpan('test-session')).toBeUndefined();
		expect(service.startApiRequestSpan(undefined, 'gpt-4', 'req-123')).toBeUndefined();
		expect(service.startToolSpan(undefined, 'read_file')).toBeUndefined();
	});

	it('should not throw when logging events', () => {
		expect(() => {
			service.logConfig({ model: 'gpt-4' });
			service.logUserPrompt({ prompt_length: 100, prompt_id: 'test' });
			service.logToolCall({
				function_name: 'read_file',
				success: true,
				tool_type: 'native',
			});
			service.logApiRequest({ model: 'gpt-4', prompt_id: 'test' });
			service.logApiResponse({
				model: 'gpt-4',
				status_code: 200,
				duration_ms: 1000,
			});
		}).not.toThrow();
	});

	it('should not throw when recording metrics', () => {
		expect(() => {
			service.incrementSessionCount();
			service.recordToolCall('read_file', true, 'native', 100);
			service.recordApiRequest('gpt-4', 200, 1000);
			service.recordTokenUsage('gpt-4', 'input', 500);
			service.recordFileOperation('read', 100);
			service.recordAgentRun('agent-mode', 5000, 10, 'completed');
		}).not.toThrow();
	});

	it('should resolve flush immediately', async () => {
		await expect(service.flush()).resolves.toBeUndefined();
	});

	it('should not throw on dispose', () => {
		expect(() => service.dispose()).not.toThrow();
	});
});

describe('FileOpenTelemetryService', () => {
	let service: FileOpenTelemetryService;
	let tempDir: string;
	let outfile: string;
	let mockLogService: ILogService;
	let mockEnvService: IEnvService;

	beforeEach(() => {
		// Create temp directory for test output
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-test-'));
		outfile = path.join(tempDir, 'telemetry.log');

		mockLogService = {
			_serviceBrand: undefined,
			trace: vi.fn(),
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			flush: vi.fn(),
		} as unknown as ILogService;

		mockEnvService = {
			_serviceBrand: undefined,
			machineId: 'test-machine-id',
			sessionId: 'test-session-id',
			getEditorPluginInfo: () => ({ name: 'copilot-chat', version: '1.0.0', format: () => '1.0.0' }),
			getEditorInfo: () => ({ name: 'vscode', version: '1.90.0', format: () => 'VSCode/1.90.0' }),
			getVersion: () => '1.0.0',
			getBuild: () => '1',
			getBuildType: () => 'dev',
		} as unknown as IEnvService;
	});

	afterEach(async () => {
		if (service) {
			await service.flush();
			service.dispose();
		}

		// Cleanup temp directory
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createService(config: Partial<IOpenTelemetryConfig> = {}): FileOpenTelemetryService {
		// We need to instantiate manually since we're not using the DI container
		const svc = new (FileOpenTelemetryService as any)(
			config,
			mockLogService,
			mockEnvService,
		);
		return svc;
	}

	it('should report isEnabled correctly', () => {
		service = createService({ enabled: false });
		expect(service.isEnabled).toBe(false);

		service.dispose();
		service = createService({ enabled: true });
		expect(service.isEnabled).toBe(true);
	});

	it('should return merged config', () => {
		service = createService({ enabled: true, logPrompts: true });
		const config = service.getConfig();
		expect(config.enabled).toBe(true);
		expect(config.logPrompts).toBe(true);
		expect(config.target).toBe('local');
	});

	it('should write log events to file when enabled and outfile is set', async () => {
		service = createService({ enabled: true, outfile });

		service.logConfig({ model: 'gpt-4' });
		service.logToolCall({
			function_name: 'read_file',
			success: true,
			tool_type: 'native',
			duration_ms: 100,
		});

		await service.flush();

		// Read and parse the log file
		const content = fs.readFileSync(outfile, 'utf-8');
		const lines = content.trim().split('\n');

		expect(lines.length).toBeGreaterThanOrEqual(2);

		const configEvent = JSON.parse(lines[0]);
		expect(configEvent.type).toBe('log');
		expect(configEvent.name).toBe('copilot_chat.config');
		expect(configEvent.attributes.model).toBe('gpt-4');
		expect(configEvent.common['session.id']).toBeDefined();

		const toolEvent = JSON.parse(lines[1]);
		expect(toolEvent.type).toBe('log');
		expect(toolEvent.name).toBe('copilot_chat.tool_call');
		expect(toolEvent.attributes.function_name).toBe('read_file');
	});

	it('should respect logPrompts setting for user prompts', async () => {
		// With logPrompts: false (default)
		service = createService({ enabled: true, outfile, logPrompts: false });

		service.logUserPrompt({
			prompt_length: 100,
			prompt_id: 'test-prompt-id',
			prompt: 'This is a secret prompt',
		});

		await service.flush();

		const content = fs.readFileSync(outfile, 'utf-8');
		const event = JSON.parse(content.trim());

		expect(event.attributes.prompt).toBeUndefined();
		expect(event.attributes.prompt_length).toBe(100);
		expect(event.attributes.prompt_id).toBe('test-prompt-id');
	});

	it('should include prompts when logPrompts is enabled', async () => {
		service = createService({ enabled: true, outfile, logPrompts: true });

		service.logUserPrompt({
			prompt_length: 100,
			prompt_id: 'test-prompt-id',
			prompt: 'This is a secret prompt',
		});

		await service.flush();

		const content = fs.readFileSync(outfile, 'utf-8');
		const event = JSON.parse(content.trim());

		expect(event.attributes.prompt).toBe('This is a secret prompt');
	});

	it('should record metrics', async () => {
		service = createService({ enabled: true, outfile });

		service.incrementSessionCount();
		service.recordToolCall('read_file', true, 'native', 150);
		service.recordApiRequest('gpt-4', 200, 1200);
		service.recordTokenUsage('gpt-4', 'input', 500);
		service.recordFileOperation('create', 50);

		await service.flush();

		const content = fs.readFileSync(outfile, 'utf-8');
		const lines = content.trim().split('\n');

		// Should have multiple metric records
		expect(lines.length).toBeGreaterThanOrEqual(5);

		// Check session count metric
		const sessionMetric = JSON.parse(lines[0]);
		expect(sessionMetric.type).toBe('metric');
		expect(sessionMetric.name).toBe('copilot_chat.session.count');

		// Check tool call metrics (count + latency)
		const toolMetrics = lines.filter(l => {
			const parsed = JSON.parse(l);
			return parsed.name.startsWith('copilot_chat.tool.');
		});
		expect(toolMetrics.length).toBeGreaterThanOrEqual(2);
	});

	it('should create span contexts', () => {
		service = createService({ enabled: true, outfile });

		const sessionSpan = service.startSessionSpan('test-session');
		expect(sessionSpan).toBeDefined();
		expect(sessionSpan?.traceId).toBe('test-session');
		expect(sessionSpan?.spanId).toBeDefined();

		const apiSpan = service.startApiRequestSpan(sessionSpan, 'gpt-4', 'req-123');
		expect(apiSpan).toBeDefined();
		expect(apiSpan?.traceId).toBe(sessionSpan?.traceId);

		const toolSpan = service.startToolSpan(sessionSpan, 'read_file');
		expect(toolSpan).toBeDefined();
		expect(toolSpan?.traceId).toBe(sessionSpan?.traceId);
	});

	it('should return undefined spans when disabled', () => {
		service = createService({ enabled: false });

		expect(service.startSessionSpan('test-session')).toBeUndefined();
		expect(service.startApiRequestSpan(undefined, 'gpt-4', 'req-123')).toBeUndefined();
		expect(service.startToolSpan(undefined, 'read_file')).toBeUndefined();
	});

	it('should not write when disabled', async () => {
		service = createService({ enabled: false, outfile });

		service.logConfig({ model: 'gpt-4' });
		service.incrementSessionCount();

		await service.flush();

		// File should not exist or be empty
		expect(fs.existsSync(outfile)).toBe(false);
	});

	it('should log agent events', async () => {
		service = createService({ enabled: true, outfile });

		service.logAgentStart({ agent_id: 'agent-123', agent_name: 'agent-mode' });
		service.logAgentFinish({
			agent_id: 'agent-123',
			agent_name: 'agent-mode',
			duration_ms: 5000,
			turn_count: 10,
			terminate_reason: 'completed',
		});
		service.recordAgentRun('agent-mode', 5000, 10, 'completed');

		await service.flush();

		const content = fs.readFileSync(outfile, 'utf-8');
		const lines = content.trim().split('\n');

		const startEvent = JSON.parse(lines[0]);
		expect(startEvent.name).toBe('copilot_chat.agent.start');
		expect(startEvent.attributes.agent_name).toBe('agent-mode');

		const finishEvent = JSON.parse(lines[1]);
		expect(finishEvent.name).toBe('copilot_chat.agent.finish');
		expect(finishEvent.attributes.turn_count).toBe(10);
	});
});
