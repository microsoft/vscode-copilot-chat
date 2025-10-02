/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { SettingsSearchResultKind, type Progress, type SettingsSearchProviderOptions, type SettingsSearchResult } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { Embeddings, EmbeddingType, IEmbeddingsComputer } from '../../../../platform/embeddings/common/embeddingsComputer';
import { ICombinedEmbeddingIndex } from '../../../../platform/embeddings/common/vscodeIndex';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionTestingServices } from '../../../test/vscode-node/services';
import { SettingsEditorSearchServiceImpl } from '../settingsEditorSearchServiceImpl';

suite('SettingsEditorSearchServiceImpl test suite', function () {
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;
	let sandbox: sinon.SinonSandbox;
	let service: SettingsEditorSearchServiceImpl;
	let mockEmbeddingsComputer: sinon.SinonStubbedInstance<IEmbeddingsComputer>;
	let mockEmbeddingIndex: ICombinedEmbeddingIndex;
	let mockAuthService: sinon.SinonStubbedInstance<IAuthenticationService>;
	let mockEndpointProvider: IEndpointProvider;

	function createAccessor() {
		const testingServiceCollection = createExtensionTestingServices();
		accessor = testingServiceCollection.createTestingAccessor();
		instaService = accessor.get(IInstantiationService);
	}

	setup(() => {
		sandbox = sinon.createSandbox();
		createAccessor();

		// Create mock implementations using sinon
		mockEmbeddingsComputer = {
			_serviceBrand: undefined,
			computeEmbeddings: sandbox.stub()
		} as any;

		mockEmbeddingIndex = {
			_serviceBrand: undefined,
			loadIndexes: sandbox.stub().resolves(undefined),
			settingsIndex: {
				nClosestValues: sandbox.stub().returns([])
			}
		} as any;

		mockAuthService = {
			_serviceBrand: undefined,
			getCopilotToken: sandbox.stub().resolves({ isFreeUser: true, isNoAuthUser: false })
		} as any;

		mockEndpointProvider = {
			_serviceBrand: undefined
		} as any;

		// Create the service manually with mocks
		service = new SettingsEditorSearchServiceImpl(
			mockAuthService as any,
			mockEndpointProvider,
			mockEmbeddingIndex,
			mockEmbeddingsComputer as any,
			instaService
		);
	});

	teardown(() => {
		sandbox.restore();
	});

	test('handles empty embeddings result gracefully', async () => {
		// Simulate computeEmbeddings returning an empty values array
		const emptyEmbeddings: Embeddings = {
			type: EmbeddingType.text3small_512,
			values: []
		};
		mockEmbeddingsComputer.computeEmbeddings.resolves(emptyEmbeddings);

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
		assert.strictEqual((mockEmbeddingIndex.settingsIndex.nClosestValues as sinon.SinonStub).called, false);

		// Verify that we reported empty results for both EMBEDDED and LLM_RANKED
		assert.strictEqual(results.length, 2);
		assert.deepStrictEqual(results[0], {
			query: 'test query',
			kind: SettingsSearchResultKind.EMBEDDED,
			settings: []
		});
		assert.deepStrictEqual(results[1], {
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
		mockEmbeddingsComputer.computeEmbeddings.resolves(emptyEmbeddings);

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
		assert.strictEqual((mockEmbeddingIndex.settingsIndex.nClosestValues as sinon.SinonStub).called, false);

		// Verify that we only reported empty results for EMBEDDED (not LLM_RANKED)
		assert.strictEqual(results.length, 1);
		assert.deepStrictEqual(results[0], {
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
		mockEmbeddingsComputer.computeEmbeddings.resolves(validEmbeddings);

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
		const nClosestValuesStub = mockEmbeddingIndex.settingsIndex.nClosestValues as sinon.SinonStub;
		assert.strictEqual(nClosestValuesStub.called, true);
		assert.strictEqual(nClosestValuesStub.callCount, 1);
		assert.deepStrictEqual(nClosestValuesStub.firstCall.args[0], validEmbeddings.values[0]);
		assert.strictEqual(nClosestValuesStub.firstCall.args[1], 25);

		// Verify that we reported the result
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, SettingsSearchResultKind.EMBEDDED);
	});
});
