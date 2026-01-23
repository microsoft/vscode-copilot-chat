/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { TestingServiceCollection } from '../../../../../platform/test/node/services';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ClaudeSettingsChangeTracker } from '../claudeSettingsChangeTracker';

describe('ClaudeSettingsChangeTracker', () => {
	let mockFs: MockFileSystemService;
	let testingServiceCollection: TestingServiceCollection;
	let tracker: ClaudeSettingsChangeTracker;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const testFile1 = URI.file('/project/.claude/CLAUDE.md');
	const testFile2 = URI.file('/project/.claude/settings.json');

	beforeEach(() => {
		mockFs = new MockFileSystemService();
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));
		testingServiceCollection.set(IFileSystemService, mockFs);

		const accessor = testingServiceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		tracker = instaService.createInstance(ClaudeSettingsChangeTracker);
	});

	describe('takeSnapshot', () => {
		it('should capture mtime of existing files', async () => {
			mockFs.mockFile(testFile1, '# Instructions', 1000);

			tracker.registerPathResolver(() => [testFile1]);
			await tracker.takeSnapshot();

			// No changes immediately after snapshot
			const hasChanges = await tracker.hasChanges();
			expect(hasChanges).toBe(false);
		});

		it('should record non-existent files as 0 mtime', async () => {
			// testFile1 is not mocked, so stat will throw
			tracker.registerPathResolver(() => [testFile1]);
			await tracker.takeSnapshot();

			// No changes immediately after snapshot
			const hasChanges = await tracker.hasChanges();
			expect(hasChanges).toBe(false);
		});
	});

	describe('hasChanges', () => {
		it('should return false when files have not changed', async () => {
			mockFs.mockFile(testFile1, '# Instructions', 1000);

			tracker.registerPathResolver(() => [testFile1]);
			await tracker.takeSnapshot();

			const hasChanges = await tracker.hasChanges();
			expect(hasChanges).toBe(false);
		});

		it('should return true when file mtime increases', async () => {
			mockFs.mockFile(testFile1, '# Instructions', 1000);

			tracker.registerPathResolver(() => [testFile1]);
			await tracker.takeSnapshot();

			// Simulate file modification by updating mtime
			mockFs.mockFile(testFile1, '# Updated Instructions', 2000);

			const hasChanges = await tracker.hasChanges();
			expect(hasChanges).toBe(true);
		});

		it('should return true when a new file is created', async () => {
			// File doesn't exist at snapshot time
			tracker.registerPathResolver(() => [testFile1]);
			await tracker.takeSnapshot();

			// File is created
			mockFs.mockFile(testFile1, '# New Instructions', 1000);

			const hasChanges = await tracker.hasChanges();
			expect(hasChanges).toBe(true);
		});

		it('should return true when a file is deleted', async () => {
			mockFs.mockFile(testFile1, '# Instructions', 1000);

			tracker.registerPathResolver(() => [testFile1]);
			await tracker.takeSnapshot();

			// Simulate file deletion by mocking an error
			mockFs.mockError(testFile1, new Error('ENOENT'));

			const hasChanges = await tracker.hasChanges();
			expect(hasChanges).toBe(true);
		});

		it('should track multiple files from single resolver', async () => {
			mockFs.mockFile(testFile1, '# Instructions', 1000);
			mockFs.mockFile(testFile2, '{}', 1000);

			tracker.registerPathResolver(() => [testFile1, testFile2]);
			await tracker.takeSnapshot();

			// Modify only second file
			mockFs.mockFile(testFile2, '{"hooks": []}', 2000);

			const hasChanges = await tracker.hasChanges();
			expect(hasChanges).toBe(true);
		});
	});

	describe('multiple path resolvers', () => {
		it('should track files from all registered resolvers', async () => {
			mockFs.mockFile(testFile1, '# Instructions', 1000);
			mockFs.mockFile(testFile2, '{}', 1000);

			tracker.registerPathResolver(() => [testFile1]);
			tracker.registerPathResolver(() => [testFile2]);
			await tracker.takeSnapshot();

			// Modify second file (from second resolver)
			mockFs.mockFile(testFile2, '{"updated": true}', 2000);

			const hasChanges = await tracker.hasChanges();
			expect(hasChanges).toBe(true);
		});

		it('should detect new files added by resolver after snapshot', async () => {
			const testFile3 = URI.file('/project/.claude/new-file.md');
			const dynamicPaths: URI[] = [testFile1];

			tracker.registerPathResolver(() => dynamicPaths);
			await tracker.takeSnapshot();

			// Add a new file to the resolver's list and create it
			dynamicPaths.push(testFile3);
			mockFs.mockFile(testFile3, '# New file', 1000);

			const hasChanges = await tracker.hasChanges();
			// testFile3 wasn't in the original snapshot, so it's a "new" file
			expect(hasChanges).toBe(true);
		});
	});
});
