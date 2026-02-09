/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IGitExtensionService } from '../../../../platform/git/common/gitExtensionService';
import { API, Change, Repository } from '../../../../platform/git/vscode/git';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { Uri } from '../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { GitDiffService } from '../gitDiffService';

describe('GitDiffService', () => {
	let readFileSpy: MockInstance<typeof vscode.workspace.fs.readFile>;
	let accessor: ITestingServicesAccessor;
	let gitDiffService: GitDiffService;
	let mockRepository: Partial<Repository>;

	beforeEach(() => {
		// Create mock workspace.fs.readFile if it doesn't exist
		if (!vscode.workspace?.fs?.readFile) {
			const workspaceWithFs = vscode as unknown as { workspace: typeof vscode.workspace };
			workspaceWithFs.workspace = {
				...vscode.workspace,
				fs: {
					...vscode.workspace?.fs,
					readFile: vi.fn()
				}
			};
		}

		// Spy on workspace.fs.readFile
		readFileSpy = vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(() => Promise.resolve(new Uint8Array()));

		mockRepository = {
			rootUri: Uri.file('/repo'),
			diffWith: vi.fn(),
			diffIndexWithHEAD: vi.fn(),
			diffWithHEAD: vi.fn()
		};

		const services = createExtensionUnitTestingServices();

		const mockGitExtensionService = {
			getExtensionApi: vi.fn().mockReturnValue({
				getRepository: vi.fn().mockReturnValue(mockRepository),
				openRepository: vi.fn(),
				repositories: [mockRepository as Repository]
			} as unknown as API)
		} as unknown as IGitExtensionService;
		services.set(IGitExtensionService, mockGitExtensionService);

		accessor = services.createTestingAccessor();
		gitDiffService = accessor.get(IInstantiationService).createInstance(GitDiffService);
	});

	afterEach(() => {
		readFileSpy.mockRestore();
	});

	describe('_getUntrackedChangePatch', () => {
		it('should generate correct patch for untracked file', async () => {
			const fileUri = Uri.file('/repo/newfile.txt');
			const fileContent = 'line1\nline2\n';

			readFileSpy.mockResolvedValue(Buffer.from(fileContent));

			const changes: Change[] = [{
				uri: fileUri,
				originalUri: fileUri,
				renameUri: undefined,
				status: 7 /* UNTRACKED */
			}];

			const diffs = await gitDiffService.getChangeDiffs(mockRepository as Repository, changes);

			expect(diffs).toHaveLength(1);
			const patch = diffs[0].diff;

			// Verify standard git patch headers
			expect(patch).toContain('diff --git a/newfile.txt b/newfile.txt');
			expect(patch).toContain('new file mode 100644');
			expect(patch).toContain('--- /dev/null');
			expect(patch).toContain('+++ b/newfile.txt');

			// Verify range header uses line count (2 lines), not byte length
			expect(patch).toContain('@@ -0,0 +1,2 @@');

			// Verify content
			expect(patch).toContain('+line1');
			expect(patch).toContain('+line2');

			// Verify final newline
			expect(patch.endsWith('\n')).toBe(true);

			// Verify no "No newline at end of file" warning since file ends with \n
			expect(patch).not.toContain('\\ No newline at end of file');
		});

		it('should handle file without trailing newline', async () => {
			const fileUri = Uri.file('/repo/no-newline.txt');
			const fileContent = 'line1'; // No trailing \n

			readFileSpy.mockResolvedValue(Buffer.from(fileContent));

			const changes: Change[] = [{
				uri: fileUri,
				originalUri: fileUri,
				renameUri: undefined,
				status: 7 /* UNTRACKED */
			}];

			const diffs = await gitDiffService.getChangeDiffs(mockRepository as Repository, changes);
			const patch = diffs[0].diff;

			expect(patch).toContain('@@ -0,0 +1,1 @@');
			expect(patch).toContain('+line1');
			expect(patch).toContain('\\ No newline at end of file');
			expect(patch.endsWith('\n')).toBe(true);
		});

		it('should handle empty file', async () => {
			const fileUri = Uri.file('/repo/empty.txt');
			const fileContent = '';

			// Mock readFile to return an empty buffer
			readFileSpy.mockResolvedValue(Buffer.from(fileContent));

			const changes: Change[] = [{
				uri: fileUri,
				originalUri: fileUri,
				renameUri: undefined,
				status: 7 /* UNTRACKED */
			}];

			const diffs = await gitDiffService.getChangeDiffs(mockRepository as Repository, changes);

			// Empty file case: git omits range header and content for totally empty files
			const patch = diffs[0].diff;
			expect(patch).toContain('diff --git a/empty.txt b/empty.txt');
			expect(patch).toContain('new file mode 100644');
			expect(patch).toContain('--- /dev/null');
			expect(patch).toContain('+++ b/empty.txt');
			// No range header for empty files
			expect(patch).not.toContain('@@');
			// No content lines
			expect(patch).not.toMatch(/^\+[^+]/m);
		});

		it('should handle file with single blank line', async () => {
			const fileUri = Uri.file('/repo/blank-line.txt');
			const fileContent = '\n'; // Single newline

			readFileSpy.mockResolvedValue(Buffer.from(fileContent));

			const changes: Change[] = [{
				uri: fileUri,
				originalUri: fileUri,
				renameUri: undefined,
				status: 7 /* UNTRACKED */
			}];

			const diffs = await gitDiffService.getChangeDiffs(mockRepository as Repository, changes);

			// Single blank line: should have range header and one empty line addition
			const patch = diffs[0].diff;
			expect(patch).toContain('diff --git a/blank-line.txt b/blank-line.txt');
			expect(patch).toContain('new file mode 100644');
			expect(patch).toContain('--- /dev/null');
			expect(patch).toContain('+++ b/blank-line.txt');
			expect(patch).toContain('@@ -0,0 +1,1 @@');
			expect(patch).toContain('+'); // One empty line
			expect(patch.endsWith('\n')).toBe(true);
		});
	});
});
