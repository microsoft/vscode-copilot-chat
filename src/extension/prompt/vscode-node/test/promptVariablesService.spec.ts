/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test } from 'vitest';
import type { ChatLanguageModelToolReference, ChatPromptReference } from 'vscode';
import { IChatDebugFileLoggerService } from '../../../../platform/chat/common/chatDebugFileLoggerService';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { Uri } from '../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { PromptVariablesServiceImpl } from '../promptVariablesService';

describe('PromptVariablesServiceImpl', () => {
	let accessor: ITestingServicesAccessor;
	let service: PromptVariablesServiceImpl;

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();
		accessor = testingServiceCollection.createTestingAccessor();
		// Create the service via DI so its dependencies (fs + workspace) come from the test container
		service = accessor.get(IInstantiationService).createInstance(PromptVariablesServiceImpl);
	});

	test('replaces variable ranges with link markdown', async () => {
		const original = 'Start #VARIABLE1 #VARIABLE2 End #VARIABLE3';

		const variables: ChatPromptReference[] = [];
		['#VARIABLE1', '#VARIABLE2', '#VARIABLE3'].forEach((varName, index) => {
			const start = original.indexOf(varName);
			const end = start + varName.length;
			variables.push({
				id: 'file' + index,
				name: 'file' + index,
				value: Uri.file(`/virtual/workspace/sample${index}.txt`),
				range: [start, end]
			});
		});

		const { message } = await service.resolvePromptReferencesInPrompt(original, variables);
		expect(message).toBe('Start [#file0](#file0-context) [#file1](#file1-context) End [#file2](#file2-context)');
	});

	test('replaces multiple tool references (deduplicating identical ranges) in reverse-sorted order', async () => {
		// message with two target substrings we will replace: TOOLX and TOOLY
		const message = 'Call #TOOLX then maybe #TOOLY finally done';

		const toolRefs: ChatLanguageModelToolReference[] = [];
		['#TOOLX', '#TOOLY'].forEach((toolRef, index) => {
			const start = message.indexOf(toolRef);
			const end = start + toolRef.length;
			toolRefs.push({
				name: 'tool' + index,
				range: [start, end]
			});
			toolRefs.push({
				name: 'tool' + index + 'Duplicate',
				range: [start, end]
			});

		});

		const rewritten = await service.resolveToolReferencesInPrompt(message, toolRefs);
		// Expect TOOLY replaced, then TOOLX replaced; duplicates ignored
		expect(rewritten).toBe('Call \'tool0\' then maybe \'tool1\' finally done');
	});

	test('handles no-op when no variables or tool references', async () => {
		const msg = 'Nothing to change';
		const { message: out } = await service.resolvePromptReferencesInPrompt(msg, []);
		const rewritten = await service.resolveToolReferencesInPrompt(out, []);
		expect(rewritten).toBe(msg);
	});

	describe('resolveTemplateVariables', () => {
		test('replaces {{CURRENT_SESSION_LOG}} when sessionId and debugLogsDir are available', () => {
			const debugLogsDir = URI.file('/mock/storage/debug-logs');
			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.define(IChatDebugFileLoggerService, {
				_serviceBrand: undefined,
				startSession: async () => { },
				endSession: async () => { },
				flush: async () => { },
				getLogPath: () => undefined,
				getSessionDir: () => undefined,
				getActiveSessionIds: () => [],
				isDebugLogUri: () => false,
				getSessionDirForResource: () => joinPath(debugLogsDir, 'session-abc'),
				debugLogsDir,
			} satisfies IChatDebugFileLoggerService);
			const acc = testingServiceCollection.createTestingAccessor();
			const svc = acc.get(IInstantiationService).createInstance(PromptVariablesServiceImpl);
			const promptPathRepresentationService = acc.get(IPromptPathRepresentationService);

			const result = svc.resolveTemplateVariables(
				'Log dir: `{{CURRENT_SESSION_LOG}}`\nMore content.',
				'session-abc'
			);

			const expected = promptPathRepresentationService.getFilePath(joinPath(debugLogsDir, 'session-abc'));
			expect(result).toBe(`Log dir: \`${expected}\`\nMore content.`);
			expect(result).not.toContain('{{CURRENT_SESSION_LOG}}');
			acc.dispose();
		});

		test('leaves {{CURRENT_SESSION_LOG}} when sessionId is undefined', () => {
			const content = 'Log dir: `{{CURRENT_SESSION_LOG}}`';
			const result = service.resolveTemplateVariables(content, undefined);
			expect(result).toBe(content);
		});

		test('leaves {{CURRENT_SESSION_LOG}} when debugLogsDir is undefined', () => {
			// The default mock has no debugLogsDir configured
			const content = 'Log dir: `{{CURRENT_SESSION_LOG}}`';
			const result = service.resolveTemplateVariables(content, 'session-abc');
			expect(result).toBe(content);
		});

		test('returns content unchanged when no placeholders present', () => {
			const content = 'No placeholders here.';
			const result = service.resolveTemplateVariables(content, 'session-abc');
			expect(result).toBe(content);
		});

		test('replaces multiple occurrences of the same placeholder', () => {
			const debugLogsDir = URI.file('/mock/storage/debug-logs');
			const testingServiceCollection = createExtensionUnitTestingServices();
			testingServiceCollection.define(IChatDebugFileLoggerService, {
				_serviceBrand: undefined,
				startSession: async () => { },
				endSession: async () => { },
				flush: async () => { },
				getLogPath: () => undefined,
				getSessionDir: () => undefined,
				getActiveSessionIds: () => [],
				isDebugLogUri: () => false,
				getSessionDirForResource: () => joinPath(debugLogsDir, 'sess'),
				debugLogsDir,
			} satisfies IChatDebugFileLoggerService);
			const acc = testingServiceCollection.createTestingAccessor();
			const svc = acc.get(IInstantiationService).createInstance(PromptVariablesServiceImpl);
			const promptPathRepresentationService = acc.get(IPromptPathRepresentationService);

			const result = svc.resolveTemplateVariables(
				'First: {{CURRENT_SESSION_LOG}}, Second: {{CURRENT_SESSION_LOG}}',
				'sess'
			);

			const expected = promptPathRepresentationService.getFilePath(joinPath(debugLogsDir, 'sess'));
			expect(result).toBe(`First: ${expected}, Second: ${expected}`);
			acc.dispose();
		});
	});
});
