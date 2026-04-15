/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode-languageserver-protocol';
import { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration, AbstractLanguageModelChatProvider } from '../abstractLanguageModelChatProvider';
import { IBYOKStorageService } from '../byokStorageService';

class TestStorageService extends mock<IBYOKStorageService>() {
	override getAPIKey = vi.fn(async () => undefined);
	override deleteAPIKey = vi.fn(async () => undefined);
	override storeAPIKey = vi.fn(async () => undefined);
	override getProviderGroups = vi.fn(async () => []);
	override createProviderGroup = vi.fn(async () => undefined);
	override updateProviderGroup = vi.fn(async () => undefined);
	override deleteProviderGroup = vi.fn(async () => undefined);
	override getSelectedProviderGroup = vi.fn(async () => undefined);
	override setSelectedProviderGroup = vi.fn(async () => undefined);
}

class TestLanguageModelProvider extends AbstractLanguageModelChatProvider {
	constructor(logService: ILogService) {
		super('test', 'Test Provider', undefined, new TestStorageService(), logService);
	}

	override async provideLanguageModelChatResponse(): Promise<void> {
		throw new Error('Not implemented for test');
	}

	override async provideTokenCount(): Promise<number> {
		return 0;
	}

	protected override async getAllModels(): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		return [
			{
				id: 'generic-model',
				name: 'Generic Model',
				family: 'generic',
				version: '1.0.0',
				maxInputTokens: 4096,
				maxOutputTokens: 2048,
				capabilities: {}
			},
			{
				id: 'cli-model',
				name: 'CLI Model',
				family: 'cli',
				version: '1.0.0',
				maxInputTokens: 4096,
				maxOutputTokens: 2048,
				targetChatSessionType: 'copilotcli',
				capabilities: {}
			},
			{
				id: 'cloud-model',
				name: 'Cloud Model',
				family: 'cloud',
				version: '1.0.0',
				maxInputTokens: 4096,
				maxOutputTokens: 2048,
				targetChatSessionType: 'copilot-cloud-agent',
				capabilities: {}
			}
		];
	}
}

describe('AbstractLanguageModelChatProvider', () => {
	let logService: ILogService;

	beforeEach(() => {
		const services = createExtensionUnitTestingServices();
		logService = services.createTestingAccessor().get(ILogService);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('hides session-targeted models from generic selection', async () => {
		const provider = new TestLanguageModelProvider(logService);

		const models = await provider.provideLanguageModelChatInformation({ silent: false }, CancellationToken.None);

		expect(models.map(model => model.id)).toEqual(['generic-model']);
	});

	it('includes matching session-targeted models for copilotcli selection', async () => {
		const provider = new TestLanguageModelProvider(logService);

		const models = await provider.provideLanguageModelChatInformation({ silent: false, chatSessionType: 'copilotcli' }, CancellationToken.None);

		expect(models.map(model => model.id)).toEqual(['generic-model', 'cli-model']);
	});
});