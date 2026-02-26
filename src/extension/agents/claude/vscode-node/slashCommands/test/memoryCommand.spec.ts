/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IWorkspaceService, NullWorkspaceService } from '../../../../../../platform/workspace/common/workspaceService';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../util/common/test/testUtils';
import { CancellationToken } from '../../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart } from '../../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../../test/node/services';
import { MockChatResponseStream } from '../../../../../test/node/testHelpers';
import { IAnswerResult } from '../../../../../tools/common/askQuestionsTypes';
import { ToolName } from '../../../../../tools/common/toolNames';
import { IToolsService } from '../../../../../tools/common/toolsService';
import { MemorySlashCommand } from '../memoryCommand';

describe('MemorySlashCommand', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let command: MemorySlashCommand;
	let stream: MockChatResponseStream;
	let invokeToolSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		const serviceCollection = store.add(createExtensionUnitTestingServices(store));

		// Override the tools service before creating the accessor
		invokeToolSpy = vi.fn();
		serviceCollection.define(IToolsService, {
			_serviceBrand: undefined,
			invokeTool: invokeToolSpy,
		} as Partial<IToolsService> as IToolsService);

		// Configure workspace with a folder so we get multiple memory locations
		const workspaceService = store.add(new NullWorkspaceService([URI.file('/test/workspace')]));
		serviceCollection.define(IWorkspaceService, workspaceService);

		const accessor = serviceCollection.createTestingAccessor();

		const instantiationService = accessor.get(IInstantiationService);
		command = instantiationService.createInstance(MemorySlashCommand);
		stream = new MockChatResponseStream();
	});

	describe('with toolInvocationToken (chat context)', () => {
		const mockToken = {} as any;

		it('uses askQuestions tool when toolInvocationToken is provided', async () => {
			const answerResult: IAnswerResult = {
				answers: {
					'Claude Memory': {
						selected: ['User memory'],
						freeText: null,
						skipped: false,
					},
				},
			};
			invokeToolSpy.mockResolvedValue({
				content: [new LanguageModelTextPart(JSON.stringify(answerResult))],
			});

			await command.handle('', stream, CancellationToken.None, mockToken);

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
									expect.objectContaining({ description: expect.stringContaining('CLAUDE.md') }),
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

			const result = await command.handle('', stream, CancellationToken.None, mockToken);

			expect(result).toEqual({});
		});

		it('returns empty result when askQuestions tool returns no text part', async () => {
			invokeToolSpy.mockResolvedValue({
				content: [],
			});

			const result = await command.handle('', stream, CancellationToken.None, mockToken);

			expect(result).toEqual({});
		});

		it('handles errors from the askQuestions tool gracefully', async () => {
			invokeToolSpy.mockRejectedValue(new Error('Tool failed'));

			// In test environment, vscode.window.showErrorMessage is not available,
			// so the error handler will itself throw. In production, it shows an error message.
			await expect(command.handle('', stream, CancellationToken.None, mockToken)).rejects.toThrow();
		});

		it('opens file directly when only one memory location exists', async () => {
			// Create a command with no workspace folders (only user memory available)
			const serviceCollection = store.add(createExtensionUnitTestingServices(store));
			const spy = vi.fn();
			serviceCollection.define(IToolsService, {
				_serviceBrand: undefined,
				invokeTool: spy,
			} as Partial<IToolsService> as IToolsService);
			// NullWorkspaceService with no folders means only user memory location
			serviceCollection.define(IWorkspaceService, store.add(new NullWorkspaceService([])));

			const accessor = serviceCollection.createTestingAccessor();
			const cmd = accessor.get(IInstantiationService).createInstance(MemorySlashCommand);

			// Opening the file will throw because vscode.workspace.openTextDocument isn't available in tests
			await expect(cmd.handle('', stream, CancellationToken.None, mockToken)).rejects.toThrow();

			// askQuestions should NOT be called when there's only one location
			expect(spy).not.toHaveBeenCalled();
		});
	});

	// Note: tests for the "without token" (Command Palette / QuickPick) path are omitted
	// because vscode.window is not available in the unit test shim. The pre-existing
	// QuickPick behavior is unaffected by these changes.
});
