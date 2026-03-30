/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { beforeEach, describe, expect, it } from 'vitest';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatLocation } from '../../../chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../configuration/test/common/inMemoryConfigurationService';
import { IResponseDelta } from '../../../networking/common/fetch';
import { IChatEndpoint, ICreateEndpointBodyOptions } from '../../../networking/common/networking';
import { IToolDeferralService } from '../../../networking/common/toolDeferralService';
import { TelemetryData } from '../../../telemetry/common/telemetryData';
import { createPlatformServices } from '../../../test/node/services';
import { createResponsesRequestBody, OpenAIResponsesProcessor } from '../responsesApi';

function createMockEndpoint(model: string): IChatEndpoint {
	return {
		model,
		family: model,
		modelProvider: 'openai',
		supportsToolCalls: true,
		supportsVision: false,
		supportsPrediction: false,
		showInModelPicker: true,
		isFallback: false,
		maxOutputTokens: 4096,
		modelMaxPromptTokens: 128000,
		urlOrRequestMetadata: 'https://test',
		name: model,
		version: '1',
		tokenizer: 'cl100k_base' as any,
		acquireTokenizer: () => { throw new Error('Not implemented'); },
		processResponseFromChatEndpoint: () => { throw new Error('Not implemented'); },
		makeRequest: () => { throw new Error('Not implemented'); },
	} as unknown as IChatEndpoint;
}

function createMockOptions(overrides: Partial<ICreateEndpointBodyOptions> = {}): ICreateEndpointBodyOptions {
	return {
		debugName: 'test',
		messages: [{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }] }],
		location: ChatLocation.Agent,
		finishedCb: undefined,
		requestId: 'test-req-1',
		postOptions: { max_tokens: 4096 },
		requestOptions: {
			tools: [
				{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
				{ type: 'function', function: { name: 'grep_search', description: 'Search for text', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
				{ type: 'function', function: { name: 'some_mcp_tool', description: 'An MCP tool', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } },
				{ type: 'function', function: { name: 'another_deferred_tool', description: 'Another tool', parameters: { type: 'object', properties: {} } } },
			]
		},
		...overrides,
	} as ICreateEndpointBodyOptions;
}

describe('createResponsesRequestBody tools', () => {
	let services: ReturnType<typeof createPlatformServices>;
	let accessor: ReturnType<ReturnType<typeof createPlatformServices>['createTestingAccessor']>;

	beforeEach(() => {
		services = createPlatformServices();
		const coreNonDeferred = new Set(['read_file', 'list_dir', 'grep_search', 'semantic_search', 'file_search',
			'replace_string_in_file', 'create_file', 'run_in_terminal', 'get_terminal_output',
			'get_errors', 'manage_todo_list', 'runSubagent', 'search_subagent', 'execution_subagent',
			'runTests', 'tool_search', 'view_image', 'fetch_webpage']);
		services.define(IToolDeferralService, { _serviceBrand: undefined, isNonDeferredTool: (name: string) => coreNonDeferred.has(name) });
		accessor = services.createTestingAccessor();
	});

	it('passes tools through without defer_loading when tool search disabled', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, false);

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools).toBeDefined();
		expect(tools.find(t => t.type === 'tool_search')).toBeUndefined();
		expect(tools.every(t => !t.defer_loading)).toBe(true);
	});

	it('adds client tool_search and defer_loading when enabled with client mode', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);
		configService.setConfig(ConfigKey.ResponsesApiToolSearchMode, 'client');

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools).toBeDefined();

		// Should have client-executed tool_search
		const toolSearchTool = tools.find(t => t.type === 'tool_search');
		expect(toolSearchTool).toBeDefined();
		expect(toolSearchTool.execution).toBe('client');

		// Non-deferred tools should NOT have defer_loading
		expect(tools.find(t => t.name === 'read_file')?.defer_loading).toBeUndefined();
		expect(tools.find(t => t.name === 'grep_search')?.defer_loading).toBeUndefined();

		// Deferred tools should have defer_loading: true
		expect(tools.find(t => t.name === 'some_mcp_tool')?.defer_loading).toBe(true);
		expect(tools.find(t => t.name === 'another_deferred_tool')?.defer_loading).toBe(true);
	});

	it('adds server tool_search and defer_loading when enabled with server mode', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);
		configService.setConfig(ConfigKey.ResponsesApiToolSearchMode, 'server');

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools).toBeDefined();

		// Should have hosted (server) tool_search without execution or parameters
		const toolSearchTool = tools.find(t => t.type === 'tool_search');
		expect(toolSearchTool).toBeDefined();
		expect(toolSearchTool.execution).toBeUndefined();
		expect(toolSearchTool.parameters).toBeUndefined();

		// Deferred tools should still have defer_loading: true
		expect(tools.find(t => t.name === 'some_mcp_tool')?.defer_loading).toBe(true);
		expect(tools.find(t => t.name === 'another_deferred_tool')?.defer_loading).toBe(true);
	});

	it('defaults to server mode when mode is not explicitly set', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);
		// mode defaults to 'server'

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		const toolSearchTool = tools.find(t => t.type === 'tool_search');
		expect(toolSearchTool).toBeDefined();
		expect(toolSearchTool.execution).toBeUndefined();
	});

	it('includes namespace for deferred tool function_calls in round-trip', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);
		configService.setConfig(ConfigKey.ResponsesApiToolSearchMode, 'server');

		// Simulate a conversation with a previous tool call for a deferred tool
		const messages: Raw.ChatMessage[] = [
			{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }] },
			{
				role: Raw.ChatRole.Assistant,
				content: [],
				toolCalls: [
					{ id: 'call_1', type: 'function', function: { name: 'some_mcp_tool', arguments: '{"input":"test"}' } },
					{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/test.txt"}' } },
				]
			},
			{ role: Raw.ChatRole.Tool, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'result1' }], toolCallId: 'call_1' },
			{ role: Raw.ChatRole.Tool, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'result2' }], toolCallId: 'call_2' },
			{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Continue' }] },
		];

		const options = createMockOptions({ messages });
		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, options, endpoint.model, endpoint
		);

		// Find the function_call items in the input
		const functionCalls = (body.input as any[]).filter(i => i.type === 'function_call');
		expect(functionCalls).toHaveLength(2);

		// Deferred tool (some_mcp_tool) should have namespace
		const deferredCall = functionCalls.find(fc => fc.name === 'some_mcp_tool');
		expect(deferredCall).toBeDefined();
		expect(deferredCall.namespace).toBe('some_mcp_tool');

		// Non-deferred tool (read_file) should NOT have namespace
		const nonDeferredCall = functionCalls.find(fc => fc.name === 'read_file');
		expect(nonDeferredCall).toBeDefined();
		expect(nonDeferredCall.namespace).toBeUndefined();
	});

	it('does not defer tools for unsupported models', () => {
		const endpoint = createMockEndpoint('gpt-4o');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools.find(t => t.type === 'tool_search')).toBeUndefined();
		expect(tools.every(t => !t.defer_loading)).toBe(true);
	});

	it('does not defer tools for non-Agent locations', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);

		const options = createMockOptions({ location: ChatLocation.Panel });
		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, options, endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools.find(t => t.type === 'tool_search')).toBeUndefined();
		expect(tools.every(t => !t.defer_loading)).toBe(true);
	});
});

describe('OpenAIResponsesProcessor tool search events', () => {
	function createProcessor() {
		const telemetryData = TelemetryData.createAndMarkAsIssued({}, {});
		return new OpenAIResponsesProcessor(telemetryData, 'req-123', 'gh-req-456');
	}

	function collectDeltas(processor: OpenAIResponsesProcessor, events: any[]): IResponseDelta[] {
		const deltas: IResponseDelta[] = [];
		const finishedCb = async (text: string, _index: number, delta: IResponseDelta) => {
			deltas.push(delta);
			return undefined;
		};
		for (const event of events) {
			processor.push({ sequence_number: 0, ...event }, finishedCb);
		}
		return deltas;
	}

	it('does not emit server tool_search_call on output_item.added (waits for done)', () => {
		const processor = createProcessor();
		const deltas = collectDeltas(processor, [
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'tool_search_call' as any,
					id: 'ts_001',
					execution: 'server',
					call_id: null,
					status: 'in_progress',
				} as any,
			}
		]);

		// Server tool_search_call should not emit on 'added', only on 'done'
		expect(deltas).toHaveLength(0);
	});

	it('emits server tool_search_call on output_item.done with full data', () => {
		const processor = createProcessor();
		const deltas = collectDeltas(processor, [
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'tool_search_call' as any,
					id: 'ts_001',
					execution: 'server',
					call_id: null,
					status: 'in_progress',
				} as any,
			},
			{
				type: 'response.output_item.done',
				output_index: 0,
				item: {
					type: 'tool_search_call' as any,
					id: 'ts_001',
					execution: 'server',
					call_id: null,
					status: 'completed',
					arguments: { paths: ['crm'] },
				} as any,
			}
		]);

		expect(deltas).toHaveLength(1);
		expect(deltas[0].serverToolCalls).toBeDefined();
		expect(deltas[0].serverToolCalls![0]).toMatchObject({
			isServer: true,
			name: 'tool_search',
			args: { paths: ['crm'] },
		});
		// ID should be a generated UUID (not the raw OpenAI base64 id) for URI safety
		expect(deltas[0].serverToolCalls![0].id).toBeTruthy();
	});

	it('handles client tool_search_call as copilotToolCall', () => {
		const processor = createProcessor();
		const deltas = collectDeltas(processor, [
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'tool_search_call' as any,
					id: 'ts_002',
					execution: 'client',
					call_id: 'call_abc',
					status: 'in_progress',
					arguments: {},
				} as any,
			},
			{
				type: 'response.output_item.done',
				output_index: 0,
				item: {
					type: 'tool_search_call' as any,
					id: 'ts_002',
					execution: 'client',
					call_id: 'call_abc',
					status: 'completed',
					arguments: { query: 'Find shipping tools' },
				} as any,
			}
		]);

		// First delta: beginToolCalls for tool_search
		expect(deltas[0].beginToolCalls).toBeDefined();
		expect(deltas[0].beginToolCalls![0].name).toBe('tool_search');
		expect(deltas[0].beginToolCalls![0].id).toBe('call_abc');

		// Second delta: completed copilotToolCall
		expect(deltas[1].copilotToolCalls).toBeDefined();
		expect(deltas[1].copilotToolCalls![0]).toMatchObject({
			id: 'call_abc',
			name: 'tool_search',
			arguments: '{"query":"Find shipping tools"}',
		});
	});

	it('handles tool_search_output with loaded tools', () => {
		const processor = createProcessor();
		const loadedTools = [
			{ type: 'function', name: 'get_shipping_eta', description: 'Look up shipping ETA', parameters: { type: 'object', properties: {} } },
		];
		const deltas = collectDeltas(processor, [
			{
				type: 'response.output_item.done',
				output_index: 1,
				item: {
					type: 'tool_search_output' as any,
					id: 'tso_001',
					execution: 'server',
					call_id: null,
					status: 'completed',
					tools: loadedTools,
				} as any,
			}
		]);

		expect(deltas).toHaveLength(1);
		expect(deltas[0].serverToolCalls).toBeDefined();
		expect(deltas[0].serverToolCalls![0]).toMatchObject({
			isServer: true,
			name: 'tool_search_output',
			result: { tools: loadedTools },
		});
		expect(deltas[0].serverToolCalls![0].id).toBeTruthy();
	});

	it('still handles regular function calls correctly alongside tool search events', () => {
		const processor = createProcessor();
		const deltas = collectDeltas(processor, [
			// Tool search call (server) — not emitted on 'added', only on 'done'
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'tool_search_call' as any,
					id: 'ts_003',
					execution: 'server',
					call_id: null,
					status: 'in_progress',
				} as any,
			},
			// Regular function call
			{
				type: 'response.output_item.added',
				output_index: 1,
				item: {
					type: 'function_call',
					name: 'read_file',
					call_id: 'call_xyz',
					arguments: '',
					id: 'fc_001',
					status: 'completed',
				} as any,
			},
			{
				type: 'response.function_call_arguments.delta',
				output_index: 1,
				delta: '{"path": "/test.txt"}',
			},
			{
				type: 'response.output_item.done',
				output_index: 1,
				item: {
					type: 'function_call',
					name: 'read_file',
					call_id: 'call_xyz',
					arguments: '{"path": "/test.txt"}',
					id: 'fc_001',
					status: 'completed',
				} as any,
			},
		]);

		// Server tool_search_call on 'added' doesn't emit — so no serverToolCalls delta

		// First delta: beginToolCalls for function_call
		expect(deltas[0].beginToolCalls).toBeDefined();
		expect(deltas[0].beginToolCalls![0].name).toBe('read_file');

		// Second delta: streaming arguments
		expect(deltas[1].copilotToolCallStreamUpdates).toBeDefined();

		// Third delta: completed tool call
		expect(deltas[2].copilotToolCalls).toBeDefined();
		expect(deltas[2].copilotToolCalls![0].name).toBe('read_file');
		expect(deltas[2].copilotToolCalls![0].arguments).toBe('{"path": "/test.txt"}');
	});

	it('captures namespace from function_call items loaded via tool search', () => {
		const processor = createProcessor();
		const deltas = collectDeltas(processor, [
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'function_call',
					name: 'run_vscode_command',
					namespace: 'run_vscode_command',
					call_id: 'call_ns_1',
					arguments: '',
					id: 'fc_ns_001',
					status: 'in_progress',
				} as any,
			},
			{
				type: 'response.function_call_arguments.delta',
				output_index: 0,
				delta: '{"commandId": "test"}',
			},
			{
				type: 'response.output_item.done',
				output_index: 0,
				item: {
					type: 'function_call',
					name: 'run_vscode_command',
					namespace: 'run_vscode_command',
					call_id: 'call_ns_1',
					arguments: '{"commandId": "test"}',
					id: 'fc_ns_001',
					status: 'completed',
				} as any,
			},
		]);

		// The completed copilotToolCall should include the namespace
		const completedDelta = deltas.find(d => d.copilotToolCalls?.length);
		expect(completedDelta).toBeDefined();
		expect(completedDelta!.copilotToolCalls![0].namespace).toBe('run_vscode_command');
	});
});
