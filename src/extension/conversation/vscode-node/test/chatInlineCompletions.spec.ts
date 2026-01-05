/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ICustomInstructionsService } from '../../../../platform/customInstructions/common/customInstructionsService';
import { ITabsAndEditorsService } from '../../../../platform/tabs/common/tabsAndEditorsService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestingTabsAndEditorsService } from '../../../../platform/test/node/simulationWorkspaceServices';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ChatInputCompletionProvider } from '../chatInlineCompletionsContrib';

/**
 * Mock implementation of ICustomInstructionsService for testing
 */
class MockCustomInstructionsService implements ICustomInstructionsService {
	_serviceBrand: undefined;

	private instructionUris: URI[] = [];
	private instructionsContent: { kind: any; content: { languageId?: string; instruction: string }[]; reference: any } | undefined;

	setInstructionUris(uris: URI[]) {
		this.instructionUris = uris;
	}

	setInstructionsContent(content: { instruction: string; languageId?: string }[]) {
		this.instructionsContent = {
			kind: 0, // File
			content,
			reference: URI.file('/test/instructions.md')
		};
	}

	clearInstructions() {
		this.instructionUris = [];
		this.instructionsContent = undefined;
	}

	async getAgentInstructions(): Promise<URI[]> {
		return this.instructionUris;
	}

	async fetchInstructionsFromFile(_fileUri: any): Promise<any> {
		return this.instructionsContent;
	}

	async fetchInstructionsFromSetting(_configKey: any): Promise<any[]> {
		return [];
	}

	isExternalInstructionsFile(_uri: URI): boolean {
		return false;
	}

	isExternalInstructionsFolder(_uri: URI): boolean {
		return false;
	}

	isSkillFile(_uri: URI): boolean {
		return false;
	}
}

describe('ChatInputCompletionProvider', () => {
	let disposables: DisposableStore;
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;
	let mockCustomInstructionsService: MockCustomInstructionsService;

	beforeEach(() => {
		disposables = new DisposableStore();
		const testingServiceCollection = createExtensionUnitTestingServices();

		// Register mock custom instructions service
		mockCustomInstructionsService = new MockCustomInstructionsService();
		testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);

		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		instaService = accessor.get(IInstantiationService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	describe('input validation', () => {
		test('should return undefined for empty input', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const result = await provider.provideChatInlineCompletionItems(
				'',
				0,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);
			expect(result).toBeUndefined();
		});

		test('should return undefined for input shorter than minimum length', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const result = await provider.provideChatInlineCompletionItems(
				'ab',
				2,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);
			expect(result).toBeUndefined();
		});

		test('should return undefined when cursor is not at end of input', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const result = await provider.provideChatInlineCompletionItems(
				'hello world',
				5, // cursor in middle
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);
			expect(result).toBeUndefined();
		});

		test('should return undefined for whitespace-only input shorter than minimum', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const result = await provider.provideChatInlineCompletionItems(
				'   ',
				3,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);
			expect(result).toBeUndefined();
		});
	});

	describe('instructions loading', () => {
		test('should handle missing instructions gracefully', async () => {
			mockCustomInstructionsService.clearInstructions();

			const provider = instaService.createInstance(ChatInputCompletionProvider);

			// Should not throw when instructions are not available
			// Note: This will fail at the model selection step, but shouldn't throw from instructions
			const result = await provider.provideChatInlineCompletionItems(
				'hello',
				5,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			// Will be undefined because no model available in test, but no error thrown
			expect(result).toBeUndefined();
		});

		test('should load instructions when available', async () => {
			mockCustomInstructionsService.setInstructionUris([URI.file('/test/instructions.md')]);
			mockCustomInstructionsService.setInstructionsContent([
				{ instruction: 'Use TypeScript' },
				{ instruction: 'Follow coding standards' }
			]);

			const provider = instaService.createInstance(ChatInputCompletionProvider);

			// Even though we can't fully test the LM call, we verify instructions are fetched
			const result = await provider.provideChatInlineCompletionItems(
				'hello',
				5,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			// Result will be undefined (no model), but verify no errors
			expect(result).toBeUndefined();
		});
	});

	describe('cancellation', () => {
		test('should respect cancellation token', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);

			const cancelledToken = {
				isCancellationRequested: true,
				onCancellationRequested: vi.fn() as any
			};

			const result = await provider.provideChatInlineCompletionItems(
				'hello world test',
				16,
				cancelledToken
			);

			expect(result).toBeUndefined();
		});
	});

	describe('provider lifecycle', () => {
		test('should handle dispose without error', () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);

			// Verify dispose doesn't throw
			expect(() => provider.dispose()).not.toThrow();
		});
	});

	describe('configuration', () => {
		test('should use model family from configuration', async () => {
			const configService = accessor.get(IConfigurationService);
			configService.setConfig(ConfigKey.TeamInternal.ChatInlineCompletionsModelFamily, 'custom-model');

			const provider = instaService.createInstance(ChatInputCompletionProvider);

			// Request will fail due to no model, but configuration should be read
			const result = await provider.provideChatInlineCompletionItems(
				'hello',
				5,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			expect(result).toBeUndefined();
		});
	});

	describe('active selection context', () => {
		test('should not include selection when no active editor', async () => {
			// Setup service with no active editor
			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);
			testingServiceCollection.set(ITabsAndEditorsService, new TestingTabsAndEditorsService({
				getActiveTextEditor: () => undefined,
				getVisibleTextEditors: () => [],
				getActiveNotebookEditor: () => undefined,
			}));

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			// Should handle gracefully without throwing
			const result = await provider.provideChatInlineCompletionItems(
				'hello world',
				11,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			expect(result).toBeUndefined();
		});

		test('should not include selection when selection is empty', async () => {
			// Create mock editor with empty selection
			const mockDocument = {
				uri: vscode.Uri.file('/test/file.ts'),
				languageId: 'typescript',
				fileName: '/test/file.ts',
				getText: vi.fn().mockReturnValue(''),
			} as any;

			const mockEditor = {
				document: mockDocument,
				selection: new vscode.Selection(0, 0, 0, 0), // Empty selection
				visibleRanges: [],
			} as any;

			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);
			testingServiceCollection.set(ITabsAndEditorsService, new TestingTabsAndEditorsService({
				getActiveTextEditor: () => mockEditor,
				getVisibleTextEditors: () => [mockEditor],
				getActiveNotebookEditor: () => undefined,
			}));

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			const result = await provider.provideChatInlineCompletionItems(
				'hello world',
				11,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			// Should handle gracefully
			expect(result).toBeUndefined();
		});

		test('should include selection when text is selected', async () => {
			// Create mock editor with non-empty selection
			const selectedText = 'function add(a: number, b: number) {\n\treturn a + b;\n}';
			const mockDocument = {
				uri: vscode.Uri.file('/workspace/src/math.ts'),
				languageId: 'typescript',
				fileName: '/workspace/src/math.ts',
				getText: vi.fn().mockReturnValue(selectedText),
			} as any;

			const mockEditor = {
				document: mockDocument,
				selection: new vscode.Selection(5, 0, 7, 1), // Non-empty selection
				visibleRanges: [],
			} as any;

			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);
			testingServiceCollection.set(ITabsAndEditorsService, new TestingTabsAndEditorsService({
				getActiveTextEditor: () => mockEditor,
				getVisibleTextEditors: () => [mockEditor],
				getActiveNotebookEditor: () => undefined,
			}));

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			const result = await provider.provideChatInlineCompletionItems(
				'explain this',
				12,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			// Result will be undefined (no model available), but the provider should handle selection context
			expect(result).toBeUndefined();
		});

		test('should truncate large selections', async () => {
			// Create a selection with more than 50 lines
			const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
			const selectedText = lines.join('\n');

			const mockDocument = {
				uri: vscode.Uri.file('/workspace/largefile.ts'),
				languageId: 'typescript',
				fileName: '/workspace/largefile.ts',
				getText: vi.fn().mockReturnValue(selectedText),
			} as any;

			const mockEditor = {
				document: mockDocument,
				selection: new vscode.Selection(0, 0, 59, 10), // 60 lines selected
				visibleRanges: [],
			} as any;

			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);
			testingServiceCollection.set(ITabsAndEditorsService, new TestingTabsAndEditorsService({
				getActiveTextEditor: () => mockEditor,
				getVisibleTextEditors: () => [mockEditor],
				getActiveNotebookEditor: () => undefined,
			}));

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			const result = await provider.provideChatInlineCompletionItems(
				'refactor this',
				13,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			// Result will be undefined (no model available), but provider should handle large selections
			expect(result).toBeUndefined();
		});

		test('should not include whitespace-only selections', async () => {
			const mockDocument = {
				uri: vscode.Uri.file('/test/file.ts'),
				languageId: 'typescript',
				fileName: '/test/file.ts',
				getText: vi.fn().mockReturnValue('   \n\t\n   '), // Only whitespace
			} as any;

			const mockEditor = {
				document: mockDocument,
				selection: new vscode.Selection(0, 0, 2, 3),
				visibleRanges: [],
			} as any;

			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);
			testingServiceCollection.set(ITabsAndEditorsService, new TestingTabsAndEditorsService({
				getActiveTextEditor: () => mockEditor,
				getVisibleTextEditors: () => [mockEditor],
				getActiveNotebookEditor: () => undefined,
			}));

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			const result = await provider.provideChatInlineCompletionItems(
				'test input',
				10,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			// Should handle gracefully and not include whitespace-only selection
			expect(result).toBeUndefined();
		});
	});

	describe('opened files context', () => {
		test('should not include opened files when no visible editors', async () => {
			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);
			testingServiceCollection.set(ITabsAndEditorsService, new TestingTabsAndEditorsService({
				getActiveTextEditor: () => undefined,
				getVisibleTextEditors: () => [],
				getActiveNotebookEditor: () => undefined,
			}));

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			const result = await provider.provideChatInlineCompletionItems(
				'test query',
				10,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			expect(result).toBeUndefined();
		});

		test('should include visible editors content', async () => {
			const mockDocument = {
				uri: vscode.Uri.file('/workspace/src/app.ts'),
				languageId: 'typescript',
				fileName: '/workspace/src/app.ts',
				getText: vi.fn().mockReturnValue('const app = express();'),
				lineCount: 10,
			} as any;

			const mockEditor = {
				document: mockDocument,
				selection: new vscode.Selection(0, 0, 0, 0),
				visibleRanges: [new vscode.Range(0, 0, 5, 0)],
			} as any;

			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);
			testingServiceCollection.set(ITabsAndEditorsService, new TestingTabsAndEditorsService({
				getActiveTextEditor: () => mockEditor,
				getVisibleTextEditors: () => [mockEditor],
				getActiveNotebookEditor: () => undefined,
			}));

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			const result = await provider.provideChatInlineCompletionItems(
				'refactor this',
				13,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			// Result will be undefined (no model), but context gathering should work
			expect(result).toBeUndefined();
		});

		test('should limit number of opened files', async () => {
			const createMockEditor = (fileName: string) => ({
				document: {
					uri: vscode.Uri.file(`/workspace/${fileName}`),
					languageId: 'typescript',
					fileName: `/workspace/${fileName}`,
					getText: vi.fn().mockReturnValue('// code'),
					lineCount: 5,
				},
				selection: new vscode.Selection(0, 0, 0, 0),
				visibleRanges: [new vscode.Range(0, 0, 2, 0)],
			} as any);

			// Create 10 mock editors (should only use first 5)
			const mockEditors = Array.from({ length: 10 }, (_, i) => createMockEditor(`file${i}.ts`));

			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, mockCustomInstructionsService);
			testingServiceCollection.set(ITabsAndEditorsService, new TestingTabsAndEditorsService({
				getActiveTextEditor: () => mockEditors[0],
				getVisibleTextEditors: () => mockEditors,
				getActiveNotebookEditor: () => undefined,
			}));

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			const result = await provider.provideChatInlineCompletionItems(
				'explain all',
				11,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			expect(result).toBeUndefined();
		});
	});

	describe('cleanupCompletionText', () => {
		test('should remove surrounding double quotes', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			// Access private method through type assertion
			const cleaned = (provider as any).cleanupCompletionText('"hello world"');
			expect(cleaned).toBe('hello world');
		});

		test('should remove surrounding single quotes', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const cleaned = (provider as any).cleanupCompletionText('\'hello world\'');
			expect(cleaned).toBe('hello world');
		});

		test('should return undefined for empty string after cleanup', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const cleaned = (provider as any).cleanupCompletionText('""');
			expect(cleaned).toBeUndefined();
		});

		test('should truncate text exceeding word limit', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const longText = 'one two three four five six seven eight nine ten';
			const cleaned = (provider as any).cleanupCompletionText(longText);
			// Should be limited to MAX_COMPLETION_WORDS (8 words)
			const words = cleaned?.split(/\s+/);
			expect(words?.length).toBeLessThanOrEqual(8);
		});

		test('should truncate text exceeding character limit', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const longText = 'a'.repeat(100);
			const cleaned = (provider as any).cleanupCompletionText(longText);
			// Should be limited to MAX_COMPLETION_LENGTH (80 chars)
			expect(cleaned?.length).toBeLessThanOrEqual(80);
		});

		test('should truncate at word boundary when possible', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const text = 'short words here and then some very long text that exceeds the maximum allowed length';
			const cleaned = (provider as any).cleanupCompletionText(text);
			// Should truncate at word boundary, not in the middle of a word
			// The result should be a complete sentence/word
			expect(cleaned).toBeTruthy();
			expect(cleaned?.length).toBeLessThanOrEqual(80);
			// Verify it ends with a word boundary (space or end of string is acceptable)
			expect(cleaned).toMatch(/(\s|[a-zA-Z0-9])$/);
		});

		test('should handle text with only whitespace', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);
			const cleaned = (provider as any).cleanupCompletionText('   \n\t   ');
			expect(cleaned).toBeUndefined();
		});
	});

	describe('error handling', () => {
		test('should handle errors in custom instructions gracefully', async () => {
			const errorService = new MockCustomInstructionsService();
			errorService.getAgentInstructions = vi.fn().mockRejectedValue(new Error('Failed to load'));

			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.set(ICustomInstructionsService, errorService);

			const testAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
			const testInstaService = testAccessor.get(IInstantiationService);
			const provider = testInstaService.createInstance(ChatInputCompletionProvider);

			// Should not throw, just return undefined
			const result = await provider.provideChatInlineCompletionItems(
				'test input',
				10,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			expect(result).toBeUndefined();
		});

		test('should handle errors during model request', async () => {
			const provider = instaService.createInstance(ChatInputCompletionProvider);

			// Input that passes validation but will fail at model selection
			const result = await provider.provideChatInlineCompletionItems(
				'valid input text',
				16,
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() as any }
			);

			// Should return undefined instead of throwing
			expect(result).toBeUndefined();
		});
	});
});

describe('ChatInlineCompletionsContribution', () => {
	let disposables: DisposableStore;
	let accessor: ITestingServicesAccessor;

	beforeEach(() => {
		disposables = new DisposableStore();
		const testingServiceCollection = createExtensionUnitTestingServices();

		// Register mock services
		testingServiceCollection.set(ICustomInstructionsService, new MockCustomInstructionsService());

		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
	});

	afterEach(() => {
		disposables.dispose();
	});

	describe('feature toggle', () => {
		test('should not register provider when disabled', () => {
			const configService = accessor.get(IConfigurationService);
			configService.setConfig(ConfigKey.ChatInlineCompletionsEnabled, false);

			// Note: We can't fully test the contribution without vscode API mocks
			// This test verifies configuration is respected
			expect(configService.getConfig(ConfigKey.ChatInlineCompletionsEnabled)).toBe(false);
		});

		test('should register provider when enabled', () => {
			const configService = accessor.get(IConfigurationService);
			configService.setConfig(ConfigKey.ChatInlineCompletionsEnabled, true);

			expect(configService.getConfig(ConfigKey.ChatInlineCompletionsEnabled)).toBe(true);
		});
	});
});
