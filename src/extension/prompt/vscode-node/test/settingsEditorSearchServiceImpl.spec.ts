/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Progress, SettingsSearchProviderOptions, SettingsSearchResult } from 'vscode';
import { SettingsSearchResultKind } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { Embeddings, EmbeddingType, IEmbeddingsComputer } from '../../../../platform/embeddings/common/embeddingsComputer';
import { ICombinedEmbeddingIndex } from '../../../../platform/embeddings/common/vscodeIndex';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { SettingsEditorSearchServiceImpl } from '../settingsEditorSearchServiceImpl';

describe('SettingsEditorSearchServiceImpl', () => {
	let accessor: ITestingServicesAccessor;
	let service: SettingsEditorSearchServiceImpl;
	let mockEmbeddingsComputer: IEmbeddingsComputer;
	let mockEmbeddingIndex: ICombinedEmbeddingIndex;
	let mockAuthService: IAuthenticationService;
	let mockEndpointProvider: IEndpointProvider;

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();
		accessor = testingServiceCollection.createTestingAccessor();

		// Create mock implementations
		mockEmbeddingsComputer = {
			_serviceBrand: undefined,
			computeEmbeddings: vi.fn()
		};

		mockEmbeddingIndex = {
			_serviceBrand: undefined,
			loadIndexes: vi.fn().mockResolvedValue(undefined),
			settingsIndex: {
				nClosestValues: vi.fn().mockReturnValue([])
			}
		} as any;

		mockAuthService = {
			_serviceBrand: undefined,
			getCopilotToken: vi.fn().mockResolvedValue({ isFreeUser: true, isNoAuthUser: false })
		} as any;

		mockEndpointProvider = {
			_serviceBrand: undefined
		} as any;

		// Create the service manually with mocks
		service = new SettingsEditorSearchServiceImpl(
			mockAuthService,
			mockEndpointProvider,
			mockEmbeddingIndex,
			mockEmbeddingsComputer,
			accessor.get(IInstantiationService)
		);
	});

	test('handles empty embeddings result gracefully', async () => {
		// Simulate computeEmbeddings returning an empty values array
		const emptyEmbeddings: Embeddings = {
			type: EmbeddingType.text3small_512,
			values: []
		};
		vi.mocked(mockEmbeddingsComputer.computeEmbeddings).mockResolvedValue(emptyEmbeddings);

		const results: SettingsSearchResult[] = [];
		const progress: Progress<SettingsSearchResult> = {
			report: (result: SettingsSearchResult) => results.push(result)
		};

		const options: SettingsSearchProviderOptions = {
			limit: 10,
			embeddingsOnly: false
		};

		await service.provideSettingsSearchResults('test query', options, progress, CancellationToken.None);

		// Verify that nClosestValues was NOT called (since values[0] is undefined)
		expect(mockEmbeddingIndex.settingsIndex.nClosestValues).not.toHaveBeenCalled();

		// Verify that we reported empty results for both EMBEDDED and LLM_RANKED
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			query: 'test query',
			kind: SettingsSearchResultKind.EMBEDDED,
			settings: []
		});
		expect(results[1]).toEqual({
			query: 'test query',
			kind: SettingsSearchResultKind.LLM_RANKED,
			settings: []
		});
	});

	test('handles empty embeddings result with embeddingsOnly option', async () => {
		// Simulate computeEmbeddings returning an empty values array
		const emptyEmbeddings: Embeddings = {
			type: EmbeddingType.text3small_512,
			values: []
		};
		vi.mocked(mockEmbeddingsComputer.computeEmbeddings).mockResolvedValue(emptyEmbeddings);

		const results: SettingsSearchResult[] = [];
		const progress: Progress<SettingsSearchResult> = {
			report: (result: SettingsSearchResult) => results.push(result)
		};

		const options: SettingsSearchProviderOptions = {
			limit: 10,
			embeddingsOnly: true
		};

		await service.provideSettingsSearchResults('test query', options, progress, CancellationToken.None);

		// Verify that nClosestValues was NOT called (since values[0] is undefined)
		expect(mockEmbeddingIndex.settingsIndex.nClosestValues).not.toHaveBeenCalled();

		// Verify that we only reported empty results for EMBEDDED (not LLM_RANKED)
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({
			query: 'test query',
			kind: SettingsSearchResultKind.EMBEDDED,
			settings: []
		});
	});

	test('calls nClosestValues when embeddings are available', async () => {
		// Simulate computeEmbeddings returning a valid embedding
		const validEmbeddings: Embeddings = {
			type: EmbeddingType.text3small_512,
			values: [{
				type: EmbeddingType.text3small_512,
				value: [0.1, 0.2, 0.3]
			}]
		};
		vi.mocked(mockEmbeddingsComputer.computeEmbeddings).mockResolvedValue(validEmbeddings);

		const results: SettingsSearchResult[] = [];
		const progress: Progress<SettingsSearchResult> = {
			report: (result: SettingsSearchResult) => results.push(result)
		};

		const options: SettingsSearchProviderOptions = {
			limit: 10,
			embeddingsOnly: true
		};

		await service.provideSettingsSearchResults('test query', options, progress, CancellationToken.None);

		// Verify that nClosestValues WAS called with the first embedding
		expect(mockEmbeddingIndex.settingsIndex.nClosestValues).toHaveBeenCalledWith(
			validEmbeddings.values[0],
			25
		);

		// Verify that we reported the result
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe(SettingsSearchResultKind.EMBEDDED);
	});
});
