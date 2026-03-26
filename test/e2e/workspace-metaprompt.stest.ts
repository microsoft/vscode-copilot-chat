/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ChatResponsePart, Progress } from 'vscode';
import { ChatVariablesCollection } from '../../src/extension/prompt/common/chatVariablesCollection';
import { WorkspaceContext } from '../../src/extension/prompts/node/panel/workspace/workspaceContext';
import { IEndpointProvider } from '../../src/platform/endpoint/common/endpointProvider';
import { SimulationWorkspace } from '../../src/platform/test/node/simulationWorkspace';
import { TelemetryCorrelationId } from '../../src/util/common/telemetryCorrelationId';
import { SpyChatResponseStream } from '../../src/util/common/test/mockChatResponseStream';
import { CancellationToken } from '../../src/util/vs/base/common/cancellation';
import { generateUuid } from '../../src/util/vs/base/common/uuid';
import { IInstantiationService } from '../../src/util/vs/platform/instantiation/common/instantiation';
import { ssuite, stest } from '../base/stest';
import { discoverScenarios } from './scenarioLoader';
import { shouldSkip } from './scenarioTest';

ssuite({ title: 'workspace', subtitle: 'metaprompt', location: 'panel' }, (inputPath) => {
	// No default cases checked in at the moment
	if (!inputPath) {
		return;
	}

	const scenariosFolder = inputPath;
	const scenarios = discoverScenarios(scenariosFolder);
	for (const scenario of scenarios) {
		const fileName = scenario[0].name;
		const testName = fileName.substring(0, fileName.indexOf('.'));
		stest.optional(shouldSkip.bind(undefined, scenario), { description: testName },
			async (testingServiceCollection) => {
				const simulationWorkspace = new SimulationWorkspace();
				simulationWorkspace.setupServices(testingServiceCollection);
				const accessor = testingServiceCollection.createTestingAccessor();
				const instantiationService = accessor.get(IInstantiationService);

				for (let i = 0; i < scenario.length; i++) {
					const testCase = scenario[i];
					simulationWorkspace.resetFromDeserializedWorkspaceState(testCase.getState?.());

					const requestId = generateUuid();
					const context = instantiationService.createInstance(WorkspaceContext, {
						telemetryInfo: new TelemetryCorrelationId('e2e', requestId),
						promptContext: {
							requestId,
							chatVariables: new ChatVariablesCollection([]),
							history: [],
							query: testCase.question,
						}
					});

					const endpoint = await accessor.get(IEndpointProvider).getChatEndpoint('copilot-base');
					const tokenizer = endpoint.acquireTokenizer();
					const countTokens = (text: string) => tokenizer.tokenLength(text);

					const mockProgressReporter = new SpyChatResponseStream();
					const a = await context.prepare({ tokenBudget: 2048, endpoint, countTokens }, mockProgressReporter as any as Progress<ChatResponsePart>, CancellationToken.None);
					const resolved = await a?.resolveQueryAndKeywords(CancellationToken.None);
					assert.ok(resolved!.keywords.length > 0, 'No keywords found in meta response');
				}
			});
	}
});
