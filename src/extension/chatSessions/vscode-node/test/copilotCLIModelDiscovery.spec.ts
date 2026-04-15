/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PromptsServiceImpl } from '../../../../platform/promptFiles/common/promptsServiceImpl';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mockLanguageModelChat } from '../../../tools/node/test/searchToolTestUtils';
import { mock } from '../../../../util/common/test/simpleMock';
import { URI } from '../../../../util/vs/base/common/uri';
import { ICopilotCLIAgents, ICopilotCLIModels } from '../../../agents/copilotcli/node/copilotCli';
import { ICopilotCLISessionService } from '../../../agents/copilotcli/node/copilotcliSessionService';
import { NullCopilotCLIAgents } from '../../../agents/copilotcli/node/test/copilotCliSessionService.spec';
import { CopilotCLIChatSessionContentProvider, CopilotCLISessionIsolationManager } from '../copilotCLIChatSessionsContribution';
import { IChatSessionWorktreeService } from '../../common/chatSessionWorktreeService';
import { discoverCopilotCLIExternalModels, resolveCopilotCLIExternalModel } from '../copilotCLIModelDiscovery';

const selectChatModelsMock = vi.fn();

vi.mock('../copilotCLITerminalIntegration', () => {
	const createServiceIdentifier = (name: string) => {
		const fn: any = () => { };
		fn.toString = () => name;
		return fn;
	};
	class CopilotCLITerminalIntegration {
		dispose() { }
		openTerminal = vi.fn(async () => { });
	}
	return {
		ICopilotCLITerminalIntegration: createServiceIdentifier('ICopilotCLITerminalIntegration'),
		CopilotCLITerminalIntegration
	};
});

const genericModel: vscode.LanguageModelChat = {
	...mockLanguageModelChat,
	id: 'generic-model',
	name: 'Generic Model',
	vendor: 'test-vendor',
	family: 'generic-family',
};

const cliTargetedModel: vscode.LanguageModelChat = {
	...mockLanguageModelChat,
	id: 'cli-model',
	name: 'CLI Model',
	vendor: 'test-vendor',
	family: 'cli-family',
};

const legacyLocalModel: vscode.LanguageModelChat = {
	...mockLanguageModelChat,
	id: 'legacy-local-model',
	name: 'Legacy Local Model',
	vendor: 'local',
	family: 'local-ollama',
};

class FakeChatSessionWorktreeService extends mock<IChatSessionWorktreeService>() {
	override readonly isWorktreeSupportedObs = { get: () => false, read: () => false } as IChatSessionWorktreeService['isWorktreeSupportedObs'];
	override getWorktreePath = vi.fn(() => undefined);
}

class FakeModels implements ICopilotCLIModels {
	_serviceBrand: undefined;
	resolveModel = vi.fn(async (modelId: string) => modelId === 'base' ? modelId : undefined);
	getDefaultModel = vi.fn(async () => 'base');
	getModels = vi.fn(async () => [{ id: 'base', name: 'Base' }]);
	setDefaultModel = vi.fn(async () => { });
}

class FakeSessionService extends mock<ICopilotCLISessionService>() {
	override getSession = vi.fn(async () => undefined);
}

describe('Copilot CLI model discovery', () => {
	let logService: ILogService;

	beforeEach(() => {
		selectChatModelsMock.mockReset();
		Object.defineProperty(vscode, 'lm', {
			value: {
				selectChatModels: selectChatModelsMock,
				onDidChangeChatModels: () => ({ dispose() { } }),
			},
			configurable: true,
		});
		const services = createExtensionUnitTestingServices();
		logService = services.createTestingAccessor().get(ILogService);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('discovers session-scoped models and dedupes legacy local results', async () => {
		selectChatModelsMock.mockImplementation(async selector => {
			const chatSessionType = (selector as { chatSessionType?: string } | undefined)?.chatSessionType;
			if (chatSessionType === 'copilotcli') {
				return [genericModel, cliTargetedModel];
			}
			if (selector?.vendor === 'local') {
				return [cliTargetedModel];
			}
			return [genericModel];
		});

		const discovery = await discoverCopilotCLIExternalModels(logService);

		expect(discovery.models.map(model => model.id)).toEqual(['generic-model', 'cli-model']);
		expect(discovery.sessionScopedCount).toBe(2);
		expect(discovery.legacyLocalCount).toBe(0);
	});

	it('falls back to legacy local discovery when no session-scoped models are returned', async () => {
		selectChatModelsMock.mockImplementation(async selector => {
			const chatSessionType = (selector as { chatSessionType?: string } | undefined)?.chatSessionType;
			if (chatSessionType === 'copilotcli') {
				return [];
			}
			if (selector?.vendor === 'local') {
				return [legacyLocalModel];
			}
			return [];
		});

		const model = await resolveCopilotCLIExternalModel(logService, 'legacy-local-model');

		expect(model?.id).toBe('legacy-local-model');
	});

	it('logs when a model is filtered out from the copilotcli session query', async () => {
		const debugSpy = vi.spyOn(logService, 'debug');
		const policyFilteredModel: vscode.LanguageModelChat = { ...cliTargetedModel, id: 'policy-filtered-model', name: 'Policy Filtered Model' };
		selectChatModelsMock.mockImplementation(async selector => {
			const chatSessionType = (selector as { chatSessionType?: string } | undefined)?.chatSessionType;
			if (chatSessionType === 'copilotcli') {
				return [];
			}
			if (selector?.vendor === 'local') {
				return [];
			}
			if (selector?.id === 'policy-filtered-model') {
				return [policyFilteredModel];
			}
			return [];
		});

		const model = await resolveCopilotCLIExternalModel(logService, 'policy-filtered-model');

		expect(model).toBeUndefined();
		expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Filtered out model policy-filtered-model'));
	});

	it('includes contributed copilotcli models in the CLI picker while preserving the internal-only fallback', async () => {
		selectChatModelsMock.mockImplementation(async selector => {
			const chatSessionType = (selector as { chatSessionType?: string } | undefined)?.chatSessionType;
			if (chatSessionType === 'copilotcli') {
				return [genericModel, cliTargetedModel];
			}
			if (selector?.vendor === 'local') {
				return [];
			}
			return [genericModel];
		});

		const worktreeService = new FakeChatSessionWorktreeService();
		const provider = new CopilotCLIChatSessionContentProvider(
			new CopilotCLISessionIsolationManager(worktreeService),
			new FakeModels(),
			new NullCopilotCLIAgents() as unknown as ICopilotCLIAgents,
			new FakeSessionService(),
			worktreeService,
			new PromptsServiceImpl(new NullWorkspaceService([URI.file('/workspace')])),
			new NullWorkspaceService([URI.file('/workspace')]),
			new MockFileSystemService(),
			logService,
		);

		const providerOptions = await provider.provideChatSessionProviderOptions();
		const optionIds = providerOptions.optionGroups.flatMap(group => group.items.map(item => item.id));
		expect(optionIds).toEqual(['base', 'generic-model', 'cli-model']);

		selectChatModelsMock.mockImplementation(async selector => {
			const chatSessionType = (selector as { chatSessionType?: string } | undefined)?.chatSessionType;
			if (chatSessionType === 'copilotcli') {
				return [];
			}
			if (selector?.vendor === 'local') {
				return [];
			}
			return [];
		});

		const fallbackOptions = await provider.provideChatSessionProviderOptions();
		const fallbackOptionIds = fallbackOptions.optionGroups.flatMap(group => group.items.map(item => item.id));
		expect(fallbackOptionIds).toEqual(['base']);
	});
});