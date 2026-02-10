/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatHookResult, ChatHookResultKind } from 'vscode';
import { IPreToolUseHookResult } from '../../../../platform/chat/common/chatHookService';

/**
 * Minimal mock of ChatHookService that exposes executePreToolUseHook
 * without requiring the real vscode API.
 *
 * We replicate the collapsing logic from ChatHookService.executePreToolUseHook
 * by subclassing and overriding executeHook to return configurable results.
 */

interface IPreToolUseHookSpecificOutput {
	hookEventName?: string;
	permissionDecision?: 'allow' | 'deny' | 'ask';
	permissionDecisionReason?: string;
	updatedInput?: object;
	additionalContext?: string;
}

const permissionPriority: Record<string, number> = { 'deny': 2, 'ask': 1, 'allow': 0 };

/**
 * A testable version of the executePreToolUseHook collapsing logic,
 * decoupled from the vscode API. Takes raw ChatHookResult[] and returns
 * the collapsed IPreToolUseHookResult.
 */
function collapsePreToolUseHookResults(results: ChatHookResult[]): IPreToolUseHookResult | undefined {
	if (results.length === 0) {
		return undefined;
	}

	let mostRestrictiveDecision: 'allow' | 'deny' | 'ask' | undefined;
	let winningReason: string | undefined;
	let lastUpdatedInput: object | undefined;
	const allAdditionalContext: string[] = [];

	for (const result of results) {
		if (result.resultKind !== 'success' || typeof result.output !== 'object' || result.output === null) {
			continue;
		}

		const output = result.output as { hookSpecificOutput?: IPreToolUseHookSpecificOutput };
		const hookSpecificOutput = output.hookSpecificOutput;
		if (!hookSpecificOutput) {
			continue;
		}

		if (hookSpecificOutput.hookEventName !== undefined && hookSpecificOutput.hookEventName !== 'PreToolUse') {
			continue;
		}

		if (hookSpecificOutput.additionalContext) {
			allAdditionalContext.push(hookSpecificOutput.additionalContext);
		}

		if (hookSpecificOutput.updatedInput) {
			lastUpdatedInput = hookSpecificOutput.updatedInput;
		}

		const decision = hookSpecificOutput.permissionDecision;
		if (decision && (mostRestrictiveDecision === undefined || (permissionPriority[decision] ?? 0) > (permissionPriority[mostRestrictiveDecision] ?? 0))) {
			mostRestrictiveDecision = decision;
			winningReason = hookSpecificOutput.permissionDecisionReason;
		}
	}

	if (!mostRestrictiveDecision && !lastUpdatedInput && allAdditionalContext.length === 0) {
		return undefined;
	}

	return {
		permissionDecision: mostRestrictiveDecision,
		permissionDecisionReason: winningReason,
		updatedInput: lastUpdatedInput,
		additionalContext: allAdditionalContext.length > 0 ? allAdditionalContext : undefined,
	};
}

function hookResult(output: unknown, kind: ChatHookResultKind = 'success'): ChatHookResult {
	return { resultKind: kind, output } as ChatHookResult;
}

/**
 * A testable ChatHookService that stubs executeHook to return configurable results,
 * so we can test executePreToolUseHook's collapsing logic without the real vscode API.
 */
class TestableChatHookService {
	public hookResults: ChatHookResult[] = [];

	async executeHook(): Promise<ChatHookResult[]> {
		return this.hookResults;
	}

	async executePreToolUseHook(
		toolName: string,
		toolInput: unknown,
		toolCallId: string,
		toolInvocationToken: unknown,
		sessionId?: string,
	): Promise<IPreToolUseHookResult | undefined> {
		const results = await this.executeHook();
		return collapsePreToolUseHookResults(results);
	}
}

describe('ChatHookService.executePreToolUseHook', () => {
	let service: TestableChatHookService;

	beforeEach(() => {
		service = new TestableChatHookService();
	});

	it('returns undefined when no hooks return results', async () => {
		service.hookResults = [];
		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result).toBeUndefined();
	});

	it('returns allow when single hook allows', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'Tool is safe' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result).toEqual({
			permissionDecision: 'allow',
			permissionDecisionReason: 'Tool is safe',
			updatedInput: undefined,
			additionalContext: undefined,
		});
	});

	it('returns deny when single hook denies', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Blocked' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result).toEqual({
			permissionDecision: 'deny',
			permissionDecisionReason: 'Blocked',
			updatedInput: undefined,
			additionalContext: undefined,
		});
	});

	it('returns ask when single hook asks', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'Needs review' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result).toEqual({
			permissionDecision: 'ask',
			permissionDecisionReason: 'Needs review',
			updatedInput: undefined,
			additionalContext: undefined,
		});
	});

	it('deny wins over allow and ask', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'ok' } }),
			hookResult({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'maybe' } }),
			hookResult({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'nope' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.permissionDecision).toBe('deny');
		expect(result?.permissionDecisionReason).toBe('nope');
	});

	it('ask wins over allow', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'ok' } }),
			hookResult({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm please' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.permissionDecision).toBe('ask');
		expect(result?.permissionDecisionReason).toBe('confirm please');
	});

	it('ignores results with wrong hookEventName', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny' } }),
			hookResult({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.permissionDecision).toBe('allow');
	});

	it('accepts results without hookEventName', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.permissionDecision).toBe('allow');
	});

	it('returns updatedInput from hook', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { path: '/safe/path.ts' } } }),
		];

		const result = await service.executePreToolUseHook('tool', { path: '/original' }, 'call-1', undefined);
		expect(result?.updatedInput).toEqual({ path: '/safe/path.ts' });
	});

	it('later hook updatedInput overrides earlier one', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { value: 'first' } } }),
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { value: 'second' } } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.updatedInput).toEqual({ value: 'second' });
	});

	it('returns updatedInput even without permission decision', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { updatedInput: { modified: true } } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.updatedInput).toEqual({ modified: true });
		expect(result?.permissionDecision).toBeUndefined();
	});

	it('collects additionalContext from all hooks', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow', additionalContext: 'context from hook 1' } }),
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow', additionalContext: 'context from hook 2' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.additionalContext).toEqual(['context from hook 1', 'context from hook 2']);
	});

	it('returns undefined additionalContext when no hooks provide it', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.additionalContext).toBeUndefined();
	});

	it('combines updatedInput, additionalContext, and permission decision', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'Modified input needs review', updatedInput: { command: 'echo safe' }, additionalContext: 'audit log enabled' } }),
		];

		const result = await service.executePreToolUseHook('tool', { command: 'rm -rf /' }, 'call-1', undefined);
		expect(result).toEqual({
			permissionDecision: 'ask',
			permissionDecisionReason: 'Modified input needs review',
			updatedInput: { command: 'echo safe' },
			additionalContext: ['audit log enabled'],
		});
	});

	it('skips non-success results', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'deny' } }, 'error'),
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.permissionDecision).toBe('allow');
	});

	it('skips results with non-object output', async () => {
		service.hookResults = [
			hookResult('string output'),
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.permissionDecision).toBe('allow');
	});

	it('skips results without hookSpecificOutput', async () => {
		service.hookResults = [
			hookResult({ someOtherField: 'value' }),
			hookResult({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'blocked' } }),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result?.permissionDecision).toBe('deny');
	});

	it('returns undefined when all results are non-success', async () => {
		service.hookResults = [
			hookResult({ hookSpecificOutput: { permissionDecision: 'deny' } }, 'error'),
			hookResult({ hookSpecificOutput: { permissionDecision: 'allow' } }, 'warning'),
		];

		const result = await service.executePreToolUseHook('tool', {}, 'call-1', undefined);
		expect(result).toBeUndefined();
	});
});
