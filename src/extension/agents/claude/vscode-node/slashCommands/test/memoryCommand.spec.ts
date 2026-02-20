/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../util/common/test/testUtils';
import { CancellationToken } from '../../../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart } from '../../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../../test/node/services';
import { MockChatResponseStream } from '../../../../../test/node/testHelpers';
import { IAnswerResult } from '../../../../../tools/common/askQuestionsTypes';
import { ToolName } from '../../../../../tools/common/toolNames';
import { IToolsService } from '../../../../../tools/common/toolsService';
import { ClaudeFolderInfo } from '../../../common/claudeFolderInfo';
import { MemorySlashCommand } from '../memoryCommand';

describe('MemorySlashCommand', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let command: MemorySlashCommand;
	let stream: MockChatResponseStream;
	let invokeToolSpy: ReturnType<typeof vi.fn>;

	const sessionFolderInfo: ClaudeFolderInfo = {
		cwd: '/test/workspace',
		additionalDirectories: [],
	};

	beforeEach(() => {
		const serviceCollection = store.add(createExtensionUnitTestingServices(store));

		// Override the tools service before creating the accessor
		invokeToolSpy = vi.fn();
		serviceCollection.define(IToolsService, {
			_serviceBrand: undefined,
			invokeTool: invokeToolSpy,
		} as Partial<IToolsService> as IToolsService);

		const accessor = serviceCollection.createTestingAccessor();

		const instantiationService = accessor.get(IInstantiationService);
		command = instantiationService.createInstance(MemorySlashCommand);
		stream = new MockChatResponseStream();
	});

	describe('with toolInvocationToken (chat context)', () => {
		const mockToken = {} as any;

		it('uses askQuestions tool with options derived from folderInfo', async () => {
			const answerResult: IAnswerResult = {
				answers: {
					'Claude Memory': {
						selected: [],
						freeText: null,
						skipped: true,
					},
				},
			};
			invokeToolSpy.mockResolvedValue({
				content: [new LanguageModelTextPart(JSON.stringify(answerResult))],
			});

			await command.handle('', stream, CancellationToken.None, mockToken, sessionFolderInfo);

			expect(invokeToolSpy).toHaveBeenCalledOnce();
			expect(invokeToolSpy).toHaveBeenCalledWith(
				ToolName.CoreAskQuestions,
				expect.objectContaining({
					toolInvocationToken: mockToken,
					input: expect.objectContaining({
						questions: expect.arrayContaining([
							expect.objectContaining({
								question: expect.any(String),
								options: expect.arrayContaining([
									expect.objectContaining({ description: '~/.claude/CLAUDE.md' }),
									expect.objectContaining({ description: '.claude/CLAUDE.md' }),
									expect.objectContaining({ description: '.claude/CLAUDE.local.md' }),
								]),
							}),
						]),
					}),
				}),
				CancellationToken.None,
			);
		});

		it('uses folderInfo directories, not workspace service folders', async () => {
			const answerResult: IAnswerResult = {
				answers: {
					'Claude Memory': {
						selected: [],
						freeText: null,
						skipped: true,
					},
				},
			};
			invokeToolSpy.mockResolvedValue({
				content: [new LanguageModelTextPart(JSON.stringify(answerResult))],
			});

			// folderInfo with specific cwd, workspace service has no folders (default)
			const folderInfo: ClaudeFolderInfo = {
				cwd: '/my/project',
				additionalDirectories: [],
			};

			await command.handle('', stream, CancellationToken.None, mockToken, folderInfo);

			// Should still call askQuestions (3 locations: user + project + local)
			expect(invokeToolSpy).toHaveBeenCalledOnce();
			const callArgs = invokeToolSpy.mock.calls[0];
			const options = callArgs[1].input.questions[0].options;
			expect(options).toHaveLength(3);
			expect(options[1].description).toBe('.claude/CLAUDE.md');
			expect(options[2].description).toBe('.claude/CLAUDE.local.md');
		});

		it('returns empty result when user skips the question', async () => {
			const answerResult: IAnswerResult = {
				answers: {
					'Claude Memory': {
						selected: [],
						freeText: null,
						skipped: true,
					},
				},
			};
			invokeToolSpy.mockResolvedValue({
				content: [new LanguageModelTextPart(JSON.stringify(answerResult))],
			});

			const result = await command.handle('', stream, CancellationToken.None, mockToken, sessionFolderInfo);

			expect(result).toEqual({});
		});

		it('returns empty result when askQuestions tool returns no text part', async () => {
			invokeToolSpy.mockResolvedValue({
				content: [],
			});

			const result = await command.handle('', stream, CancellationToken.None, mockToken, sessionFolderInfo);

			expect(result).toEqual({});
		});

		it('handles errors from the askQuestions tool gracefully', async () => {
			invokeToolSpy.mockRejectedValue(new Error('Tool failed'));

			// In test environment, vscode.window.showErrorMessage is not available,
			// so the error handler will itself throw. In production, it shows an error message.
			await expect(command.handle('', stream, CancellationToken.None, mockToken, sessionFolderInfo)).rejects.toThrow();
		});

		it('opens user memory directly when folderInfo is not provided and no workspace folders exist', async () => {
			// When there's no folderInfo and no workspace folders, only user memory is available.
			// With only 1 location, the command opens the file directly without asking.
			await expect(command.handle('', stream, CancellationToken.None, mockToken)).rejects.toThrow();

			// askQuestions should NOT be called when there's only one location
			expect(invokeToolSpy).not.toHaveBeenCalled();
		});

		it('shows multi-root labels when folderInfo has additional directories', async () => {
			const answerResult: IAnswerResult = {
				answers: {
					'Claude Memory': {
						selected: [],
						freeText: null,
						skipped: true,
					},
				},
			};
			invokeToolSpy.mockResolvedValue({
				content: [new LanguageModelTextPart(JSON.stringify(answerResult))],
			});

			const multiRootFolderInfo: ClaudeFolderInfo = {
				cwd: '/workspace/project-a',
				additionalDirectories: ['/workspace/project-b'],
			};

			await command.handle('', stream, CancellationToken.None, mockToken, multiRootFolderInfo);

			expect(invokeToolSpy).toHaveBeenCalledOnce();
			const callArgs = invokeToolSpy.mock.calls[0];
			const options = callArgs[1].input.questions[0].options;
			// user + 2 project + 2 local = 5 options
			expect(options).toHaveLength(5);
		});
	});

	// Note: tests for the "without token" (Command Palette / QuickPick) path are omitted
	// because vscode.window is not available in the unit test shim. The pre-existing
	// QuickPick behavior is unaffected by these changes.
});
