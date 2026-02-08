/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, suite, test } from 'vitest';
import { ChatFetchResponseType } from '../../../../platform/chat/common/commonTypes';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { Edits } from '../../../../platform/inlineEdits/common/dataTypes/edit';
import { LanguageId } from '../../../../platform/inlineEdits/common/dataTypes/languageId';
import { DEFAULT_OPTIONS, LanguageContextLanguages, LintOptionShowCode, LintOptionWarning, ModelConfiguration, PromptingStrategy, ResponseFormat } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { InlineEditRequestLogContext } from '../../../../platform/inlineEdits/common/inlineEditLogContext';
import { IInlineEditsModelService } from '../../../../platform/inlineEdits/common/inlineEditsModelService';
import { NoNextEditReason, StatelessNextEditDocument, StatelessNextEditRequest } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { ILogger } from '../../../../platform/log/common/logService';
import { FilterReason } from '../../../../platform/networking/common/openai';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { LineEdit } from '../../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { Position } from '../../../../util/vs/editor/common/core/position';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { N_LINES_AS_CONTEXT } from '../../common/promptCrafting';
import { nes41Miniv3SystemPrompt, simplifiedPrompt, systemPromptTemplate, unifiedModelSystemPrompt, xtab275SystemPrompt } from '../../common/systemMessages';
import { CurrentDocument } from '../../common/xtabCurrentDocument';
import {
	computeAreaAroundEditWindowLinesRange,
	determineLanguageContextOptions,
	findMergeConflictMarkersRange,
	getPredictionContents,
	mapChatFetcherErrorToNoNextEditReason,
	ModelConfig,
	overrideModelConfig,
	pickSystemPrompt,
	XtabProvider,
} from '../../node/xtabProvider';

suite('findMergeConflictMarkersRange', () => {

	test('should find merge conflict markers within edit window', () => {
		const lines = [
			'function foo() {',
			'<<<<<<< HEAD',
			'  return 1;',
			'=======',
			'  return 2;',
			'>>>>>>> branch',
			'}',
		];
		const editWindowRange = new OffsetRange(0, 7);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(1);
		expect(result?.endExclusive).toBe(6);
	});

	test('should return undefined when no merge conflict markers present', () => {
		const lines = [
			'function foo() {',
			'  return 1;',
			'}',
		];
		const editWindowRange = new OffsetRange(0, 3);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined();
	});

	test('should return undefined when start marker exists but no end marker', () => {
		const lines = [
			'function foo() {',
			'<<<<<<< HEAD',
			'  return 1;',
			'=======',
			'  return 2;',
			'}',
		];
		const editWindowRange = new OffsetRange(0, 6);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined();
	});

	test('should return undefined when conflict exceeds maxMergeConflictLines', () => {
		const lines = [
			'<<<<<<< HEAD',
			'line 1',
			'line 2',
			'line 3',
			'line 4',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 6);
		const maxMergeConflictLines = 3; // Too small to reach end marker

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined();
	});

	test('should find conflict when exactly at maxMergeConflictLines boundary', () => {
		const lines = [
			'<<<<<<< HEAD',
			'line 1',
			'line 2',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 4);
		const maxMergeConflictLines = 4;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(0);
		expect(result?.endExclusive).toBe(4);
	});

	test('should only search within edit window range', () => {
		const lines = [
			'function foo() {',
			'  return 1;',
			'<<<<<<< HEAD',
			'  return 2;',
			'>>>>>>> branch',
			'}',
		];
		const editWindowRange = new OffsetRange(0, 2); // Excludes the conflict
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined();
	});

	test('should find first conflict when multiple conflicts exist', () => {
		const lines = [
			'<<<<<<< HEAD',
			'first conflict',
			'>>>>>>> branch',
			'some code',
			'<<<<<<< HEAD',
			'second conflict',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 7);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(0);
		expect(result?.endExclusive).toBe(3);
	});

	test('should handle conflict at start of edit window', () => {
		const lines = [
			'<<<<<<< HEAD',
			'content',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 3);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(0);
		expect(result?.endExclusive).toBe(3);
	});

	test('should handle conflict at end of edit window', () => {
		const lines = [
			'some code',
			'<<<<<<< HEAD',
			'content',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 4);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(1);
		expect(result?.endExclusive).toBe(4);
	});

	test('should handle empty lines array', () => {
		const lines: string[] = [];
		const editWindowRange = new OffsetRange(0, 0);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined();
	});

	test('should handle single line with start marker only', () => {
		const lines = ['<<<<<<< HEAD'];
		const editWindowRange = new OffsetRange(0, 1);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined();
	});

	test('should handle lines with merge markers that do not start at beginning', () => {
		const lines = [
			'function foo() {',
			'  <<<<<<< HEAD',
			'  return 1;',
			'  >>>>>>> branch',
			'}',
		];
		const editWindowRange = new OffsetRange(0, 5);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined(); // Should not match as markers don't start at line beginning
	});

	test('should handle conflict that extends beyond lines array', () => {
		const lines = [
			'<<<<<<< HEAD',
			'content',
		];
		const editWindowRange = new OffsetRange(0, 2);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined();
	});

	test('should handle edit window extending beyond lines array', () => {
		const lines = [
			'<<<<<<< HEAD',
			'content',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 100); // Beyond array length
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(0);
		expect(result?.endExclusive).toBe(3);
	});

	test('should handle minimal conflict (start and end markers only)', () => {
		const lines = [
			'<<<<<<< HEAD',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 2);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(0);
		expect(result?.endExclusive).toBe(2);
	});

	test('should handle maxMergeConflictLines of 1', () => {
		const lines = [
			'<<<<<<< HEAD',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 2);
		const maxMergeConflictLines = 1;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeUndefined(); // Cannot find end marker within limit
	});

	test('should handle maxMergeConflictLines of 2', () => {
		const lines = [
			'<<<<<<< HEAD',
			'>>>>>>> branch',
		];
		const editWindowRange = new OffsetRange(0, 2);
		const maxMergeConflictLines = 2;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(0);
		expect(result?.endExclusive).toBe(2);
	});

	test('should find conflict starting in middle of edit window', () => {
		const lines = [
			'line 1',
			'line 2',
			'<<<<<<< HEAD',
			'conflict',
			'>>>>>>> branch',
			'line 5',
		];
		const editWindowRange = new OffsetRange(0, 6);
		const maxMergeConflictLines = 10;

		const result = findMergeConflictMarkersRange(lines, editWindowRange, maxMergeConflictLines);

		expect(result).toBeDefined();
		expect(result?.start).toBe(2);
		expect(result?.endExclusive).toBe(5);
	});
});

// ============================================================================
// Test Helpers
// ============================================================================

function createMockLogger(): ILogger {
	return new TestLogService();
}

function makeCurrentDocument(lines: string[], cursorLineOneBased: number, cursorColumn = 1): CurrentDocument {
	const text = new StringText(lines.join('\n'));
	return new CurrentDocument(text, new Position(cursorLineOneBased, cursorColumn));
}

function makeActiveDocument(lines: string[], opts?: { workspaceRoot?: URI; languageId?: string }): StatelessNextEditDocument {
	const text = new StringText(lines.join('\n'));
	return new StatelessNextEditDocument(
		DocumentId.create('file:///test/file.ts'),
		opts?.workspaceRoot,
		LanguageId.create(opts?.languageId ?? 'typescript'),
		lines,
		LineEdit.empty,
		text,
		new Edits(StringEdit, []),
	);
}

function makeBaseModelConfig(): ModelConfig {
	return {
		modelName: undefined,
		...DEFAULT_OPTIONS,
	};
}

const baseRequestFields = {
	reason: 'test',
	requestId: 'req-1',
	serverRequestId: undefined,
} as const;

// ============================================================================
// Mock for IInlineEditsModelService
// ============================================================================

class MockInlineEditsModelService implements IInlineEditsModelService {
	declare readonly _serviceBrand: undefined;
	readonly modelInfo = undefined;
	readonly onModelListUpdated: Event<void> = new Emitter<void>().event;

	private _selectedConfig: ModelConfiguration = {
		modelName: 'test-model',
		promptingStrategy: undefined,
		includeTagsInCurrentFile: false,
		lintOptions: undefined,
	};

	private _defaultConfig: ModelConfiguration = {
		modelName: 'default-model',
		promptingStrategy: undefined,
		includeTagsInCurrentFile: false,
		lintOptions: undefined,
	};

	async setCurrentModelId(_modelId: string): Promise<void> { }

	selectedModelConfiguration(): ModelConfiguration {
		return this._selectedConfig;
	}

	defaultModelConfiguration(): ModelConfiguration {
		return this._defaultConfig;
	}

	setSelectedConfig(config: Partial<ModelConfiguration>): void {
		this._selectedConfig = { ...this._selectedConfig, ...config };
	}

	setDefaultConfig(config: Partial<ModelConfiguration>): void {
		this._defaultConfig = { ...this._defaultConfig, ...config };
	}
}

// ============================================================================
// pickSystemPrompt
// ============================================================================

describe('pickSystemPrompt', () => {
	it('returns systemPromptTemplate for CopilotNesXtab', () => {
		expect(pickSystemPrompt(PromptingStrategy.CopilotNesXtab)).toBe(systemPromptTemplate);
	});

	it('returns systemPromptTemplate for undefined', () => {
		expect(pickSystemPrompt(undefined)).toBe(systemPromptTemplate);
	});

	it('returns unifiedModelSystemPrompt for UnifiedModel', () => {
		expect(pickSystemPrompt(PromptingStrategy.UnifiedModel)).toBe(unifiedModelSystemPrompt);
	});

	it('returns simplifiedPrompt for Codexv21NesUnified', () => {
		expect(pickSystemPrompt(PromptingStrategy.Codexv21NesUnified)).toBe(simplifiedPrompt);
	});

	it('returns simplifiedPrompt for SimplifiedSystemPrompt', () => {
		expect(pickSystemPrompt(PromptingStrategy.SimplifiedSystemPrompt)).toBe(simplifiedPrompt);
	});

	it.each([
		PromptingStrategy.PatchBased,
		PromptingStrategy.PatchBased01,
		PromptingStrategy.Xtab275,
		PromptingStrategy.XtabAggressiveness,
		PromptingStrategy.Xtab275EditIntent,
		PromptingStrategy.Xtab275EditIntentShort,
	])('returns xtab275SystemPrompt for %s', (strategy) => {
		expect(pickSystemPrompt(strategy)).toBe(xtab275SystemPrompt);
	});

	it('returns nes41Miniv3SystemPrompt for Nes41Miniv3', () => {
		expect(pickSystemPrompt(PromptingStrategy.Nes41Miniv3)).toBe(nes41Miniv3SystemPrompt);
	});

	it('each strategy produces a non-empty string', () => {
		const allStrategies: (PromptingStrategy | undefined)[] = [
			undefined,
			...Object.values(PromptingStrategy),
		];
		for (const s of allStrategies) {
			expect(pickSystemPrompt(s).length).toBeGreaterThan(0);
		}
	});
});

// ============================================================================
// mapChatFetcherErrorToNoNextEditReason
// ============================================================================

describe('mapChatFetcherErrorToNoNextEditReason', () => {
	it('maps Canceled to GotCancelled', () => {
		const result = mapChatFetcherErrorToNoNextEditReason({
			type: ChatFetchResponseType.Canceled,
			...baseRequestFields,
		});
		expect(result).toBeInstanceOf(NoNextEditReason.GotCancelled);
	});

	it.each([
		{ type: ChatFetchResponseType.OffTopic, ...baseRequestFields },
		{ type: ChatFetchResponseType.Filtered, ...baseRequestFields, category: FilterReason.Hate },
		{ type: ChatFetchResponseType.PromptFiltered, ...baseRequestFields, category: FilterReason.Hate },
		{ type: ChatFetchResponseType.Length, ...baseRequestFields, truncatedValue: '' },
		{ type: ChatFetchResponseType.RateLimited, ...baseRequestFields, retryAfter: undefined, rateLimitKey: 'k' },
		{ type: ChatFetchResponseType.QuotaExceeded, ...baseRequestFields, retryAfter: new Date() },
		{ type: ChatFetchResponseType.ExtensionBlocked, ...baseRequestFields, retryAfter: 0, learnMoreLink: '' },
		{ type: ChatFetchResponseType.AgentUnauthorized, ...baseRequestFields, authorizationUrl: '' },
		{ type: ChatFetchResponseType.AgentFailedDependency, ...baseRequestFields },
		{ type: ChatFetchResponseType.InvalidStatefulMarker, ...baseRequestFields },
	] satisfies ReadonlyArray<Parameters<typeof mapChatFetcherErrorToNoNextEditReason>[0]>)('maps $type to Uncategorized', (error) => {
		const result = mapChatFetcherErrorToNoNextEditReason(error);
		expect(result).toBeInstanceOf(NoNextEditReason.Uncategorized);
	});

	it.each([
		{ type: ChatFetchResponseType.BadRequest, ...baseRequestFields },
		{ type: ChatFetchResponseType.NotFound, ...baseRequestFields },
		{ type: ChatFetchResponseType.Failed, ...baseRequestFields },
		{ type: ChatFetchResponseType.NetworkError, ...baseRequestFields },
		{ type: ChatFetchResponseType.Unknown, ...baseRequestFields },
	] satisfies ReadonlyArray<Parameters<typeof mapChatFetcherErrorToNoNextEditReason>[0]>)('maps $type to FetchFailure', (error) => {
		const result = mapChatFetcherErrorToNoNextEditReason(error);
		expect(result).toBeInstanceOf(NoNextEditReason.FetchFailure);
	});
});

// ============================================================================
// overrideModelConfig
// ============================================================================

describe('overrideModelConfig', () => {
	it('overrides modelName from overridingConfig', () => {
		const base = makeBaseModelConfig();
		const override: ModelConfiguration = {
			modelName: 'custom-model',
			promptingStrategy: PromptingStrategy.Xtab275,
			includeTagsInCurrentFile: true,
			lintOptions: undefined,
		};

		const result = overrideModelConfig(base, override);

		expect(result.modelName).toBe('custom-model');
		expect(result.promptingStrategy).toBe(PromptingStrategy.Xtab275);
		expect(result.currentFile.includeTags).toBe(true);
	});

	it('preserves base config fields that are not overridden', () => {
		const base = makeBaseModelConfig();
		const override: ModelConfiguration = {
			modelName: 'new-model',
			promptingStrategy: undefined,
			includeTagsInCurrentFile: false,
			lintOptions: undefined,
		};

		const result = overrideModelConfig(base, override);

		expect(result.includePostScript).toBe(base.includePostScript);
		expect(result.pagedClipping).toEqual(base.pagedClipping);
		expect(result.recentlyViewedDocuments).toEqual(base.recentlyViewedDocuments);
		expect(result.diffHistory).toEqual(base.diffHistory);
	});

	it('merges lintOptions when overridingConfig has lintOptions', () => {
		const testLintOptions = { tagName: 'lint', warnings: LintOptionWarning.YES, showCode: LintOptionShowCode.YES, maxLints: 5, maxLineDistance: 10 };
		const base: ModelConfig = {
			...makeBaseModelConfig(),
			lintOptions: testLintOptions,
		};
		const overrideLintOptions = { tagName: 'diag', warnings: LintOptionWarning.NO, showCode: LintOptionShowCode.NO, maxLints: 3, maxLineDistance: 5 };
		const override: ModelConfiguration = {
			modelName: 'test',
			promptingStrategy: undefined,
			includeTagsInCurrentFile: false,
			lintOptions: overrideLintOptions,
		};

		const result = overrideModelConfig(base, override);

		expect(result.lintOptions).toEqual(overrideLintOptions);
	});

	it('keeps base lintOptions when override has no lintOptions', () => {
		const testLintOptions = { tagName: 'lint', warnings: LintOptionWarning.YES, showCode: LintOptionShowCode.YES, maxLints: 5, maxLineDistance: 10 };
		const base: ModelConfig = {
			...makeBaseModelConfig(),
			lintOptions: testLintOptions,
		};
		const override: ModelConfiguration = {
			modelName: 'test',
			promptingStrategy: undefined,
			includeTagsInCurrentFile: false,
			lintOptions: undefined,
		};

		const result = overrideModelConfig(base, override);

		expect(result.lintOptions).toEqual(testLintOptions);
	});

	it('overrides currentFile.includeTags without affecting other currentFile fields', () => {
		const base = makeBaseModelConfig();
		const originalMaxTokens = base.currentFile.maxTokens;
		const override: ModelConfiguration = {
			modelName: 'test',
			promptingStrategy: undefined,
			includeTagsInCurrentFile: true,
			lintOptions: undefined,
		};

		const result = overrideModelConfig(base, override);

		expect(result.currentFile.includeTags).toBe(true);
		expect(result.currentFile.maxTokens).toBe(originalMaxTokens);
	});
});

// ============================================================================
// determineLanguageContextOptions
// ============================================================================

describe('determineLanguageContextOptions', () => {
	const baseOpts = {
		enabled: false,
		enabledLanguages: {} as LanguageContextLanguages,
		maxTokens: 500,
		enableAllContextProviders: false,
		traitPosition: 'before' as const,
	};

	it('uses explicit language entry when language is in enabledLanguages', () => {
		const result = determineLanguageContextOptions(
			LanguageId.create('python'),
			{ ...baseOpts, enabledLanguages: { python: true } as LanguageContextLanguages },
		);
		expect(result).toMatchInlineSnapshot(`
			{
			  "enabled": true,
			  "maxTokens": 500,
			  "traitPosition": "before",
			}
		`);
	});

	it('uses false from enabledLanguages when explicitly disabled for language', () => {
		const result = determineLanguageContextOptions(
			LanguageId.create('python'),
			{ ...baseOpts, enabledLanguages: { python: false } as LanguageContextLanguages },
		);
		expect(result.enabled).toBe(false);
	});

	it('falls back to enableAllContextProviders when language not in enabledLanguages', () => {
		const result = determineLanguageContextOptions(
			LanguageId.create('rust'),
			{ ...baseOpts, enableAllContextProviders: true },
		);
		expect(result.enabled).toBe(true);
	});

	it('falls back to the enabled param as last resort', () => {
		const result = determineLanguageContextOptions(
			LanguageId.create('rust'),
			{ ...baseOpts, enabled: true },
		);
		expect(result.enabled).toBe(true);
	});

	it('returns false when all sources are false', () => {
		const result = determineLanguageContextOptions(
			LanguageId.create('rust'),
			baseOpts,
		);
		expect(result.enabled).toBe(false);
	});

	it('passes through maxTokens and traitPosition', () => {
		const result = determineLanguageContextOptions(
			LanguageId.create('typescript'),
			{ ...baseOpts, enabled: true, maxTokens: 1000, traitPosition: 'after' },
		);
		expect(result).toMatchInlineSnapshot(`
			{
			  "enabled": true,
			  "maxTokens": 1000,
			  "traitPosition": "after",
			}
		`);
	});

	it('enabledLanguages takes priority over enableAllContextProviders', () => {
		const result = determineLanguageContextOptions(
			LanguageId.create('python'),
			{
				...baseOpts,
				enabledLanguages: { python: false } as LanguageContextLanguages,
				enableAllContextProviders: true,
			},
		);
		expect(result.enabled).toBe(false);
	});
});

// ============================================================================
// getPredictionContents
// ============================================================================

describe('getPredictionContents', () => {
	const editWindowLines = ['const x = 1;', 'const y = 2;'];
	const doc = makeActiveDocument(['line0', ...editWindowLines, 'line3']);

	it('returns correct content for UnifiedWithXml', () => {
		expect(getPredictionContents(doc, editWindowLines, ResponseFormat.UnifiedWithXml)).toMatchInlineSnapshot(`
			"<EDIT>
			const x = 1;
			const y = 2;
			</EDIT>"
		`);
	});

	it('returns correct content for EditWindowOnly', () => {
		expect(getPredictionContents(doc, editWindowLines, ResponseFormat.EditWindowOnly)).toMatchInlineSnapshot(`
			"const x = 1;
			const y = 2;"
		`);
	});

	it('returns correct content for EditWindowWithEditIntent', () => {
		expect(getPredictionContents(doc, editWindowLines, ResponseFormat.EditWindowWithEditIntent)).toMatchInlineSnapshot(`
			"<|edit_intent|>high<|/edit_intent|>
			const x = 1;
			const y = 2;"
		`);
	});

	it('returns correct content for EditWindowWithEditIntentShort', () => {
		expect(getPredictionContents(doc, editWindowLines, ResponseFormat.EditWindowWithEditIntentShort)).toMatchInlineSnapshot(`
			"H
			const x = 1;
			const y = 2;"
		`);
	});

	it('returns correct content for CodeBlock', () => {
		expect(getPredictionContents(doc, editWindowLines, ResponseFormat.CodeBlock)).toMatchInlineSnapshot(`
			"\`\`\`
			const x = 1;
			const y = 2;
			\`\`\`"
		`);
	});

	it('returns correct content for CustomDiffPatch with workspace root', () => {
		const docWithRoot = makeActiveDocument(
			['line0', 'line1'],
			{ workspaceRoot: URI.file('/workspace/project') },
		);
		const result = getPredictionContents(docWithRoot, ['line0'], ResponseFormat.CustomDiffPatch);
		expect(result.endsWith(':')).toBe(true);
	});

	it('returns correct content for CustomDiffPatch without workspace root', () => {
		const result = getPredictionContents(doc, editWindowLines, ResponseFormat.CustomDiffPatch);
		expect(result.endsWith(':')).toBe(true);
	});

	it('handles empty editWindowLines', () => {
		expect(getPredictionContents(doc, [], ResponseFormat.EditWindowOnly)).toBe('');
	});

	it('handles single-line editWindowLines', () => {
		expect(getPredictionContents(doc, ['only line'], ResponseFormat.EditWindowOnly)).toBe('only line');
	});
});

// ============================================================================
// computeAreaAroundEditWindowLinesRange
// ============================================================================

describe('computeAreaAroundEditWindowLinesRange', () => {
	it('returns correct range with cursor in middle of large document', () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const doc = makeCurrentDocument(lines, 26); // cursor at line 26 (1-based), cursorLineOffset=25

		const result = computeAreaAroundEditWindowLinesRange(doc);

		expect(result.start).toBe(25 - N_LINES_AS_CONTEXT);
		expect(result.endExclusive).toBe(25 + N_LINES_AS_CONTEXT + 1);
	});

	it('clamps start to 0 when cursor is near beginning', () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const doc = makeCurrentDocument(lines, 3); // cursorLineOffset=2

		const result = computeAreaAroundEditWindowLinesRange(doc);

		expect(result.start).toBe(0);
		expect(result.endExclusive).toBe(2 + N_LINES_AS_CONTEXT + 1);
	});

	it('clamps end to document length when cursor is near end', () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
		const doc = makeCurrentDocument(lines, 19); // cursorLineOffset=18

		const result = computeAreaAroundEditWindowLinesRange(doc);

		expect(result.start).toBe(Math.max(0, 18 - N_LINES_AS_CONTEXT));
		expect(result.endExclusive).toBe(20); // clamped to lines.length
	});

	it('handles single-line document', () => {
		const doc = makeCurrentDocument(['only line'], 1);

		const result = computeAreaAroundEditWindowLinesRange(doc);

		expect(result.start).toBe(0);
		expect(result.endExclusive).toBe(1);
	});

	it('handles document with fewer lines than N_LINES_AS_CONTEXT', () => {
		const lines = ['a', 'b', 'c'];
		const doc = makeCurrentDocument(lines, 2); // cursorLineOffset=1

		const result = computeAreaAroundEditWindowLinesRange(doc);

		expect(result.start).toBe(0);
		expect(result.endExclusive).toBe(3);
	});

	it('cursor at first line', () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const doc = makeCurrentDocument(lines, 1); // cursorLineOffset=0

		const result = computeAreaAroundEditWindowLinesRange(doc);

		expect(result.start).toBe(0);
		expect(result.endExclusive).toBe(N_LINES_AS_CONTEXT + 1);
	});

	it('cursor at last line', () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const doc = makeCurrentDocument(lines, 50); // cursorLineOffset=49

		const result = computeAreaAroundEditWindowLinesRange(doc);

		expect(result.start).toBe(49 - N_LINES_AS_CONTEXT);
		expect(result.endExclusive).toBe(50);
	});
});

// ============================================================================
// XtabProvider — integration tests
// ============================================================================

describe('XtabProvider integration', () => {
	const disposables = new DisposableStore();
	let instaService: IInstantiationService;
	let mockModelService: MockInlineEditsModelService;

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices(disposables);

		mockModelService = new MockInlineEditsModelService();
		testingServiceCollection.set(IInlineEditsModelService, mockModelService);

		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		instaService = accessor.get(IInstantiationService);
	});

	afterEach(() => {
		disposables.clear();
	});

	function createProvider(): XtabProvider {
		return instaService.createInstance(XtabProvider);
	}

	describe('static properties', () => {
		it('has correct ID', () => {
			const provider = createProvider();
			expect(provider.ID).toBe(XtabProvider.ID);
		});

		it('has showNextEditPreference set to Always', () => {
			const provider = createProvider();
			expect(provider.showNextEditPreference).toMatchInlineSnapshot(`"always"`);
		});
	});

	describe('handleAcceptance / handleRejection / handleIgnored', () => {
		it('does not throw when called', () => {
			const provider = createProvider();

			expect(() => provider.handleAcceptance()).not.toThrow();
			expect(() => provider.handleRejection()).not.toThrow();
			expect(() => provider.handleIgnored()).not.toThrow();
		});
	});

	describe('early exits', () => {
		function createTestRequest(opts: { xtabEditHistory: readonly { docId: DocumentId; kind: 'visibleRanges'; visibleRanges: readonly OffsetRange[]; documentContent: StringText }[] }): StatelessNextEditRequest {
			const lines = ['function foo() {', '  return 1;', '}'];
			const text = new StringText(lines.join('\n'));
			const docId = DocumentId.create('file:///test/file.ts');
			const doc = new StatelessNextEditDocument(
				docId,
				undefined,
				LanguageId.create('typescript'),
				lines,
				LineEdit.empty,
				text,
				new Edits(StringEdit, []),
			);

			return new StatelessNextEditRequest(
				'req-1',
				'opp-1',
				text,
				[doc],
				0,
				opts.xtabEditHistory,
				new DeferredPromise(),
				undefined,
				new InlineEditRequestLogContext('file:///test/file.ts', 1, undefined),
				undefined,
				undefined,
				Date.now(),
			);
		}

		/** Drains the generator to completion and returns the final returned value. */
		async function drainGenerator<TYield, TReturn>(gen: AsyncGenerator<TYield, TReturn>): Promise<TReturn> {
			let result = await gen.next();
			while (!result.done) {
				result = await gen.next();
			}
			return result.value;
		}

		it('returns ActiveDocumentHasNoEdits when xtabEditHistory is empty', async () => {
			const provider = createProvider();
			const request = createTestRequest({ xtabEditHistory: [] });
			const logContext = new InlineEditRequestLogContext('file:///test/file.ts', 1, undefined);

			const gen = provider.provideNextEdit(request, createMockLogger(), logContext, CancellationToken.None);
			const finalValue = await drainGenerator(gen);

			expect(finalValue.v).toBeInstanceOf(NoNextEditReason.ActiveDocumentHasNoEdits);
		});
	});
});
