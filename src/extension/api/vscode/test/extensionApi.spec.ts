/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from 'vscode';
import { CopilotExtensionApi } from '../extensionApi';
import { VSCodeContextProviderApiV1 } from '../vscodeContextProviderApi';

vi.mock('vscode', () => {
	return {
		window: {
			activeTextEditor: undefined
		}
	};
});

describe('CopilotExtensionApi', () => {
	let scopeSelectorMock: any;
	let languageContextProviderMock: any;
	let api: CopilotExtensionApi;

	beforeEach(() => {
		scopeSelectorMock = {
			selectEnclosingScope: vi.fn()
		};
		languageContextProviderMock = {
			registerContextProvider: vi.fn()
		};

		api = new CopilotExtensionApi(scopeSelectorMock, languageContextProviderMock);
		(window as any).activeTextEditor = undefined;
	});

	describe('version', () => {
		it('should have version 1', () => {
			expect(CopilotExtensionApi.version).toBe(1);
		});
	});

	describe('selectScope', () => {
		it('should use provided editor', async () => {
			const editor: any = { document: {} };
			scopeSelectorMock.selectEnclosingScope.mockResolvedValue('test-scope');

			const result = await api.selectScope(editor);

			expect(scopeSelectorMock.selectEnclosingScope).toHaveBeenCalledWith(editor, undefined);
			expect(result).toBe('test-scope');
		});

		it('should use activeTextEditor if no editor is provided', async () => {
			const activeEditor: any = { document: {} };
			(window as any).activeTextEditor = activeEditor;
			scopeSelectorMock.selectEnclosingScope.mockResolvedValue('test-scope');

			const result = await api.selectScope();

			expect(scopeSelectorMock.selectEnclosingScope).toHaveBeenCalledWith(activeEditor, undefined);
			expect(result).toBe('test-scope');
		});

		it('should return undefined if no editor is provided and no activeTextEditor', async () => {
			const result = await api.selectScope();

			expect(scopeSelectorMock.selectEnclosingScope).not.toHaveBeenCalled();
			expect(result).toBeUndefined();
		});

		it('should pass options to scopeSelector', async () => {
			const editor: any = { document: {} };
			const options = { reason: 'test reason' };
			scopeSelectorMock.selectEnclosingScope.mockResolvedValue('test-scope');

			const result = await api.selectScope(editor, options);

			expect(scopeSelectorMock.selectEnclosingScope).toHaveBeenCalledWith(editor, options);
			expect(result).toBe('test-scope');
		});
	});

	describe('getContextProviderAPI', () => {
		it('should return VSCodeContextProviderApiV1 for v1', () => {
			const result = api.getContextProviderAPI('v1');

			expect(result).toBeInstanceOf(VSCodeContextProviderApiV1);
		});
	});
});
