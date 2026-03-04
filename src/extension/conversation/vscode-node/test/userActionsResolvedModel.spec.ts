/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { ChatFetchResponseType, type ChatResponse } from '../../../../platform/chat/common/commonTypes';
import type { IResultMetadata } from '../../../prompt/common/conversation';

/**
 * Verifies that resolvedModel is correctly extracted from a successful ChatResponse
 * and included in the IResultMetadata fragment. This mirrors the logic in
 * DefaultIntentRequestHandler.getResult() that constructs the metadataFragment.
 */
describe('resolvedModel in result metadata', () => {
	function buildMetadataFragment(response: ChatResponse): Partial<IResultMetadata> {
		return {
			resolvedModel: response.type === ChatFetchResponseType.Success ? response.resolvedModel : undefined,
		};
	}

	test('captures resolvedModel from a successful response', () => {
		const response: ChatResponse = {
			type: ChatFetchResponseType.Success,
			value: 'hello',
			requestId: 'req-1',
			serverRequestId: 'srv-1',
			usage: undefined,
			resolvedModel: 'gpt-4o',
		};

		const fragment = buildMetadataFragment(response);
		expect(fragment.resolvedModel).toBe('gpt-4o');
	});

	test('resolvedModel is undefined for non-success responses', () => {
		const response: ChatResponse = {
			type: ChatFetchResponseType.Canceled,
			requestId: 'req-1',
			serverRequestId: 'srv-1',
			reason: 'cancelled',
		};

		const fragment = buildMetadataFragment(response);
		expect(fragment.resolvedModel).toBeUndefined();
	});

	test('resolvedModel is empty string when server returns empty model', () => {
		const response: ChatResponse = {
			type: ChatFetchResponseType.Success,
			value: 'hello',
			requestId: 'req-1',
			serverRequestId: 'srv-1',
			usage: undefined,
			resolvedModel: '',
		};

		const fragment = buildMetadataFragment(response);
		expect(fragment.resolvedModel).toBe('');
	});

	test('resolvedModel differs from requested model when auto resolves', () => {
		const response: ChatResponse = {
			type: ChatFetchResponseType.Success,
			value: 'hello',
			requestId: 'req-1',
			serverRequestId: 'srv-1',
			usage: undefined,
			resolvedModel: 'claude-sonnet-4',
		};

		const fragment = buildMetadataFragment(response);
		expect(fragment.resolvedModel).toBe('claude-sonnet-4');
	});
});

/**
 * Verifies that modelId uses resolvedModel only when auto is selected,
 * and preserves the original modelId for all other model selections.
 */
describe('modelId uses resolvedModel only for auto selection', () => {
	function resolveModelId(metadata: Partial<IResultMetadata> | undefined, actionModelId: string) {
		return actionModelId === 'copilot/auto' ? (metadata?.resolvedModel || 'copilot/auto') : actionModelId;
	}

	test('uses resolvedModel when auto is selected and resolvedModel is available', () => {
		const metadata: Partial<IResultMetadata> = { resolvedModel: 'gpt-4o' };
		expect(resolveModelId(metadata, 'copilot/auto')).toBe('gpt-4o');
	});

	test('falls back to copilot/auto when auto is selected but resolvedModel is missing', () => {
		expect(resolveModelId(undefined, 'copilot/auto')).toBe('copilot/auto');
		expect(resolveModelId({}, 'copilot/auto')).toBe('copilot/auto');
	});

	test('keeps original modelId when non-auto model is selected', () => {
		const metadata: Partial<IResultMetadata> = { resolvedModel: 'gpt-4o-2024-05-13' };
		expect(resolveModelId(metadata, 'gpt-4o')).toBe('gpt-4o');
	});

	test('keeps original modelId when non-auto model is selected and no metadata', () => {
		expect(resolveModelId(undefined, 'claude-sonnet-4')).toBe('claude-sonnet-4');
	});
});
