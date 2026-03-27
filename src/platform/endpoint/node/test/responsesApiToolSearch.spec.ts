/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, it, beforeEach } from 'vitest';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatLocation } from '../../../chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../configuration/test/common/inMemoryConfigurationService';
import { IResponseDelta, OpenAiToolSearchTool } from '../../../networking/common/fetch';
import { IChatEndpoint, ICreateEndpointBodyOptions } from '../../../networking/common/networking';
import { nonDeferredToolNames } from '../../../networking/common/toolSearch';
import { createPlatformServices } from '../../../test/node/services';
import { TelemetryData } from '../../../telemetry/common/telemetryData';
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

describe('createResponsesRequestBody tool search', () => {
	let services: ReturnType<typeof createPlatformServices>;
	let accessor: ReturnType<ReturnType<typeof createPlatformServices>['createTestingAccessor']>;

	beforeEach(() => {
		services = createPlatformServices();
		accessor = services.createTestingAccessor();
	});

	it('does not add tool_search or defer_loading when tool search is disabled', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, false);

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools).toBeDefined();
		// No tool_search tool should be present
		expect(tools.find(t => t.type === 'tool_search')).toBeUndefined();
		// No tool should have defer_loading
		expect(tools.every(t => !t.defer_loading)).toBe(true);
	});

	it('adds hosted tool_search and marks deferred tools in server mode', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools).toBeDefined();

		// Should have tool_search tool
		const toolSearchTool = tools.find(t => t.type === 'tool_search');
		expect(toolSearchTool).toBeDefined();

		// Non-deferred tools (read_file, grep_search) should NOT have defer_loading
		const readFile = tools.find(t => t.name === 'read_file');
		expect(readFile).toBeDefined();
		expect(readFile.defer_loading).toBeUndefined();

		const grepSearch = tools.find(t => t.name === 'grep_search');
		expect(grepSearch).toBeDefined();
		expect(grepSearch.defer_loading).toBeUndefined();

		// Deferred tools should have defer_loading: true
		const mcpTool = tools.find(t => t.name === 'some_mcp_tool');
		expect(mcpTool).toBeDefined();
		expect(mcpTool.defer_loading).toBe(true);

		const anotherTool = tools.find(t => t.name === 'another_deferred_tool');
		expect(anotherTool).toBeDefined();
		expect(anotherTool.defer_loading).toBe(true);
	});

	it('does not add tool_search tool in client mode', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);
		configService.setConfig(ConfigKey.ResponsesApiToolSearchMode, 'client');

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools).toBeDefined();

		// No hosted tool_search tool in client mode
		expect(tools.find(t => t.type === 'tool_search')).toBeUndefined();

		// But deferred tools should still be marked
		const mcpTool = tools.find(t => t.name === 'some_mcp_tool');
		expect(mcpTool).toBeDefined();
		expect(mcpTool.defer_loading).toBe(true);
	});

	it('does not defer tools for unsupported models', () => {
		const endpoint = createMockEndpoint('gpt-4o');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools).toBeDefined();
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
		expect(tools).toBeDefined();
		expect(tools.find(t => t.type === 'tool_search')).toBeUndefined();
		expect(tools.every(t => !t.defer_loading)).toBe(true);
	});

	it('does not defer tools for subagent requests', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);

		const options = createMockOptions({
			telemetryProperties: { subType: 'subagent_search' }
		});
		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, options, endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools).toBeDefined();
		expect(tools.find(t => t.type === 'tool_search')).toBeUndefined();
		expect(tools.every(t => !t.defer_loading)).toBe(true);
	});

	it('tool_search is the first tool in the array', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, createMockOptions(), endpoint.model, endpoint
		);

		const tools = body.tools as any[];
		expect(tools[0]).toEqual({ type: 'tool_search' } as OpenAiToolSearchTool);
	});

	it('all nonDeferredToolNames are not deferred when tool search is enabled', () => {
		const endpoint = createMockEndpoint('gpt-5.4-preview');
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		configService.setConfig(ConfigKey.ResponsesApiToolSearchEnabled, true);

		// Create tools with all non-deferred names
		const tools = [...nonDeferredToolNames].map(name => ({
			type: 'function' as const,
			function: { name, description: `Tool ${name}`, parameters: { type: 'object', properties: {} } }
		}));
		const options = createMockOptions({ requestOptions: { tools } });

		const body = accessor.get(IInstantiationService).invokeFunction(
			createResponsesRequestBody, options, endpoint.model, endpoint
		);

		const resultTools = body.tools as any[];
		for (const tool of resultTools) {
			if (tool.type === 'tool_search') {
				continue;
			}
			expect(tool.defer_loading, `Tool ${tool.name} should not be deferred`).toBeUndefined();
		}
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

	it('handles server tool_search_call in output_item.added', () => {
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
			id: 'ts_001',
		});
	});

	it('handles tool_search_call done with arguments', () => {
		const processor = createProcessor();
		const deltas = collectDeltas(processor, [
			{
				type: 'response.output_item.done',
				output_index: 0,
				item: {
					type: 'tool_search_call' as any,
					id: 'ts_002',
					execution: 'client',
					call_id: 'call_abc',
					status: 'completed',
					arguments: { goal: 'Find shipping tools' },
				} as any,
			}
		]);

		expect(deltas).toHaveLength(1);
		expect(deltas[0].serverToolCalls).toBeDefined();
		expect(deltas[0].serverToolCalls![0]).toMatchObject({
			isServer: true,
			name: 'tool_search',
			id: 'ts_002',
			args: { goal: 'Find shipping tools' },
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
			id: 'tso_001',
			result: { tools: loadedTools },
		});
	});

	it('still handles regular function calls correctly alongside tool search events', () => {
		const processor = createProcessor();
		const deltas = collectDeltas(processor, [
			// Tool search call (server)
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'tool_search_call' as any,
					id: 'ts_003',
					execution: 'server',
					call_id: null,
					status: 'completed',
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

		// First delta: tool search server call
		expect(deltas[0].serverToolCalls).toBeDefined();

		// Second delta: beginToolCalls for function_call
		expect(deltas[1].beginToolCalls).toBeDefined();
		expect(deltas[1].beginToolCalls![0].name).toBe('read_file');

		// Third delta: streaming arguments
		expect(deltas[2].copilotToolCallStreamUpdates).toBeDefined();

		// Fourth delta: completed tool call
		expect(deltas[3].copilotToolCalls).toBeDefined();
		expect(deltas[3].copilotToolCalls![0].name).toBe('read_file');
		expect(deltas[3].copilotToolCalls![0].arguments).toBe('{"path": "/test.txt"}');
	});
});
