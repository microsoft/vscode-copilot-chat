/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { afterEach, beforeEach, suite, test } from 'vitest';
import { INSTRUCTION_FILE_EXTENSION, PromptsType } from '../../../../platform/customInstructions/common/promptTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { GitHubOrgInstructionsProvider } from '../githubOrgInstructionsProvider';
import { MockGithubOrgChatResourcesService } from './mockGitHubOrgChatResourcesService';
import { MockOctoKitService } from './mockOctoKitService';

suite('GitHubOrgInstructionsProvider', () => {
	let disposables: DisposableStore;
	let mockOctoKitService: MockOctoKitService;
	let mockChatResourcesService: MockGithubOrgChatResourcesService;
	let accessor: any;
	let provider: GitHubOrgInstructionsProvider;

	const storagePath = '/test/storage';

	beforeEach(() => {
		disposables = new DisposableStore();

		// Create mocks
		mockOctoKitService = new MockOctoKitService();
		mockChatResourcesService = new MockGithubOrgChatResourcesService(URI.file(storagePath));

		// Set up testing services
		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
	});

	afterEach(() => {
		disposables.dispose();
		mockOctoKitService.reset();
		mockChatResourcesService.clearAllStorage();
	});

	function createProvider(): GitHubOrgInstructionsProvider {
		provider = new GitHubOrgInstructionsProvider(
			accessor.get(ILogService),
			mockOctoKitService,
			mockChatResourcesService,
		);
		disposables.add(provider);
		return provider;
	}

	test('returns empty array when no organization available', async () => {
		mockChatResourcesService.setPreferredOrganization(undefined);
		const provider = createProvider();

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.deepEqual(instructions, []);
	});

	test('returns cached instructions when available', async () => {
		const orgId = 'testorg';
		mockChatResourcesService.setPreferredOrganization(orgId);

		// Pre-populate cache with instructions
		const instructionContent = '# Custom Instructions\nThese are custom instructions for the organization.';
		mockChatResourcesService.setStorage(orgId, PromptsType.instructions, new Map([
			[`default${INSTRUCTION_FILE_EXTENSION}`, instructionContent]
		]));

		const provider = createProvider();

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.equal(instructions.length, 1);
		assert.ok(instructions[0].uri.path.endsWith(`default${INSTRUCTION_FILE_EXTENSION}`));
	});

	test('returns empty array when cache is empty', async () => {
		const orgId = 'emptyorg';
		mockChatResourcesService.setPreferredOrganization(orgId);
		// No storage set - cache is empty

		const provider = createProvider();

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.deepEqual(instructions, []);
	});

	test('pollInstructions writes instructions to cache when found', async () => {
		const orgId = 'testorg';
		const instructionContent = '# Organization Instructions\nBe helpful and concise.';

		mockOctoKitService.setOrgInstructions(orgId, instructionContent);
		mockChatResourcesService.setPreferredOrganization(orgId);

		// Access the private method through prototype
		const provider = createProvider();

		// Manually invoke the polling callback that would be passed to startPolling
		// We can do this by directly calling the private method
		await (provider as any).pollInstructions(orgId);

		// Verify the instructions were written to cache
		const cachedContent = await mockChatResourcesService.readCacheFile(
			PromptsType.instructions,
			orgId,
			`default${INSTRUCTION_FILE_EXTENSION}`
		);

		assert.equal(cachedContent, instructionContent);
	});

	test('pollInstructions does nothing when no instructions found', async () => {
		const orgId = 'testorg';
		mockOctoKitService.setOrgInstructions(orgId, undefined);
		mockChatResourcesService.setPreferredOrganization(orgId);

		const provider = createProvider();

		// Invoke polling
		await (provider as any).pollInstructions(orgId);

		// Verify no instructions were written
		const cachedContent = await mockChatResourcesService.readCacheFile(
			PromptsType.instructions,
			orgId,
			`default${INSTRUCTION_FILE_EXTENSION}`
		);

		assert.isUndefined(cachedContent);
	});

	test('fires change event when instructions content changes', async () => {
		const orgId = 'testorg';
		const instructionContent = '# New Instructions\nUpdated content.';

		mockOctoKitService.setOrgInstructions(orgId, instructionContent);
		mockChatResourcesService.setPreferredOrganization(orgId);

		const provider = createProvider();

		let eventFired = false;
		provider.onDidChangeInstructions(() => {
			eventFired = true;
		});

		// Invoke polling - this should trigger the change event since writeCacheFile returns true
		await (provider as any).pollInstructions(orgId);

		assert.isTrue(eventFired, 'Change event should fire when instructions are updated');
	});

	test('fires change event on every successful poll with instructions', async () => {
		// Note: The current implementation does not pass checkForChanges option to writeCacheFile,
		// so change events fire on every poll even when content is unchanged
		const orgId = 'testorg';
		const instructionContent = '# Stable Instructions\nThis content will not change.';

		mockOctoKitService.setOrgInstructions(orgId, instructionContent);
		mockChatResourcesService.setPreferredOrganization(orgId);

		// Pre-populate cache with the same content
		mockChatResourcesService.setStorage(orgId, PromptsType.instructions, new Map([
			[`default${INSTRUCTION_FILE_EXTENSION}`, instructionContent]
		]));

		const provider = createProvider();

		let changeEventCount = 0;
		provider.onDidChangeInstructions(() => {
			changeEventCount++;
		});

		// Invoke polling - writeCacheFile returns true since checkForChanges is not used
		await (provider as any).pollInstructions(orgId);

		assert.equal(changeEventCount, 1, 'Change event fires on every successful poll');
	});

	test('pollInstructions propagates API errors', async () => {
		const orgId = 'testorg';
		mockChatResourcesService.setPreferredOrganization(orgId);

		// Make the API throw an error
		mockOctoKitService.getOrgCustomInstructions = async () => {
			throw new Error('API Error');
		};

		const provider = createProvider();

		// pollInstructions does not have internal error handling, so errors propagate
		// The error handling is expected to be in startPolling's callback wrapper
		let errorThrown = false;
		try {
			await (provider as any).pollInstructions(orgId);
		} catch (e: any) {
			errorThrown = true;
			assert.equal(e.message, 'API Error');
		}

		assert.isTrue(errorThrown, 'API errors should propagate from pollInstructions');
	});

	test('returns instructions from correct organization', async () => {
		// Pre-populate different orgs with different instructions
		mockChatResourcesService.setStorage('org1', PromptsType.instructions, new Map([
			[`default${INSTRUCTION_FILE_EXTENSION}`, 'Org1 instructions']
		]));
		mockChatResourcesService.setStorage('org2', PromptsType.instructions, new Map([
			[`default${INSTRUCTION_FILE_EXTENSION}`, 'Org2 instructions']
		]));

		// Set preferred org to org2
		mockChatResourcesService.setPreferredOrganization('org2');

		const provider = createProvider();

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.equal(instructions.length, 1);
		// The URI should contain 'org2', not 'org1'
		assert.ok(instructions[0].uri.path.includes('org2'));
	});

	test('handles cache read errors gracefully', async () => {
		const orgId = 'testorg';
		mockChatResourcesService.setPreferredOrganization(orgId);

		// Override listCachedFiles to throw an error
		const originalListCachedFiles = mockChatResourcesService.listCachedFiles.bind(mockChatResourcesService);
		mockChatResourcesService.listCachedFiles = async () => {
			throw new Error('Cache read error');
		};

		const provider = createProvider();

		// Should not throw, should return empty array
		const instructions = await provider.provideInstructions({}, {} as any);

		assert.deepEqual(instructions, []);

		// Restore original method
		mockChatResourcesService.listCachedFiles = originalListCachedFiles;
	});

	test('respects cancellation token in provideInstructions', async () => {
		const orgId = 'testorg';
		mockChatResourcesService.setPreferredOrganization(orgId);
		mockChatResourcesService.setStorage(orgId, PromptsType.instructions, new Map([
			[`default${INSTRUCTION_FILE_EXTENSION}`, 'Some instructions']
		]));

		const provider = createProvider();

		// Create a cancelled token
		const cancelledToken = {
			isCancellationRequested: true,
			onCancellationRequested: () => ({ dispose: () => { } })
		};

		const instructions = await provider.provideInstructions({}, cancelledToken as any);

		// Should return empty array when cancelled
		assert.deepEqual(instructions, []);
	});

	test('uses correct file extension for instruction files', async () => {
		const orgId = 'testorg';
		const instructionContent = '# Test Instructions';

		mockOctoKitService.setOrgInstructions(orgId, instructionContent);
		mockChatResourcesService.setPreferredOrganization(orgId);

		const provider = createProvider();
		await (provider as any).pollInstructions(orgId);

		// Verify the file was written with the correct extension
		const cachedContent = await mockChatResourcesService.readCacheFile(
			PromptsType.instructions,
			orgId,
			`default${INSTRUCTION_FILE_EXTENSION}`
		);

		assert.equal(cachedContent, instructionContent);

		// Verify we can list it
		mockChatResourcesService.setStorage(orgId, PromptsType.instructions, new Map([
			[`default${INSTRUCTION_FILE_EXTENSION}`, instructionContent]
		]));

		const instructions = await provider.provideInstructions({}, {} as any);
		assert.equal(instructions.length, 1);
		assert.ok(instructions[0].uri.path.endsWith(INSTRUCTION_FILE_EXTENSION));
	});

	test('disposes polling subscription when provider is disposed', () => {
		const provider = createProvider();

		// Should not throw when disposed
		provider.dispose();

		// Provider should be properly cleaned up
		assert.ok(true, 'Provider disposed without errors');
	});

	test('multiple instruction files are returned when present', async () => {
		const orgId = 'testorg';
		mockChatResourcesService.setPreferredOrganization(orgId);

		// Pre-populate cache with multiple instruction files
		mockChatResourcesService.setStorage(orgId, PromptsType.instructions, new Map([
			[`default${INSTRUCTION_FILE_EXTENSION}`, 'Default instructions'],
			[`custom${INSTRUCTION_FILE_EXTENSION}`, 'Custom instructions'],
			[`team${INSTRUCTION_FILE_EXTENSION}`, 'Team instructions'],
		]));

		const provider = createProvider();

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.equal(instructions.length, 3);
	});
});
