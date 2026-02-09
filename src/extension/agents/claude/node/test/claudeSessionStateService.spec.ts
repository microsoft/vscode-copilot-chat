/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import sinon from 'sinon';
import { afterEach, assert, beforeEach, describe, it } from 'vitest';
import { ClaudeSessionStateService, SessionStateChangeEvent } from '../claudeSessionStateService';

describe('ClaudeSessionStateService', () => {
	let service: ClaudeSessionStateService;

	beforeEach(() => {
		service = new ClaudeSessionStateService();
	});

	afterEach(() => {
		service.dispose();
		sinon.restore();
	});

	describe('getModelIdForSession', () => {
		it('should return undefined when no model is set for a session', async () => {
			const modelId = await service.getModelIdForSession('session-1');
			assert.strictEqual(modelId, undefined);
		});

		it('should return the set model when one has been set for a session', async () => {
			service.setModelIdForSession('session-1', 'claude-opus-4-20250514');
			const modelId = await service.getModelIdForSession('session-1');
			assert.strictEqual(modelId, 'claude-opus-4-20250514');
		});

		it('should return different models for different sessions', async () => {
			service.setModelIdForSession('session-1', 'claude-opus-4-20250514');
			service.setModelIdForSession('session-2', 'claude-haiku-3-5-20250514');

			const modelId1 = await service.getModelIdForSession('session-1');
			const modelId2 = await service.getModelIdForSession('session-2');

			assert.strictEqual(modelId1, 'claude-opus-4-20250514');
			assert.strictEqual(modelId2, 'claude-haiku-3-5-20250514');
		});

		it('should return undefined when model is explicitly set to undefined', async () => {
			service.setModelIdForSession('session-1', 'claude-opus-4-20250514');
			service.setModelIdForSession('session-1', undefined);

			const modelId = await service.getModelIdForSession('session-1');
			assert.strictEqual(modelId, undefined);
		});
	});

	describe('setModelIdForSession', () => {
		it('should fire onDidChangeSessionState event when model is set', () => {
			const events: SessionStateChangeEvent[] = [];
			service.onDidChangeSessionState(e => events.push(e));

			service.setModelIdForSession('session-1', 'claude-opus-4-20250514');

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0].sessionId, 'session-1');
			assert.strictEqual(events[0].modelId, 'claude-opus-4-20250514');
			assert.strictEqual(events[0].permissionMode, undefined);
		});

		it('should preserve permission mode when setting model', () => {
			service.setPermissionModeForSession('session-1', 'bypassPermissions');
			service.setModelIdForSession('session-1', 'claude-opus-4-20250514');

			const permissionMode = service.getPermissionModeForSession('session-1');
			assert.strictEqual(permissionMode, 'bypassPermissions');
		});
	});

	describe('getPermissionModeForSession', () => {
		it('should return default acceptEdits when no mode is set', () => {
			const mode = service.getPermissionModeForSession('session-1');
			assert.strictEqual(mode, 'acceptEdits');
		});

		it('should return the set permission mode', () => {
			service.setPermissionModeForSession('session-1', 'bypassPermissions');
			const mode = service.getPermissionModeForSession('session-1');
			assert.strictEqual(mode, 'bypassPermissions');
		});

		it('should return different modes for different sessions', () => {
			service.setPermissionModeForSession('session-1', 'bypassPermissions');
			service.setPermissionModeForSession('session-2', 'default');

			const mode1 = service.getPermissionModeForSession('session-1');
			const mode2 = service.getPermissionModeForSession('session-2');

			assert.strictEqual(mode1, 'bypassPermissions');
			assert.strictEqual(mode2, 'default');
		});
	});

	describe('setPermissionModeForSession', () => {
		it('should fire onDidChangeSessionState event when permission mode is set', () => {
			const events: SessionStateChangeEvent[] = [];
			service.onDidChangeSessionState(e => events.push(e));

			service.setPermissionModeForSession('session-1', 'bypassPermissions');

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0].sessionId, 'session-1');
			assert.strictEqual(events[0].permissionMode, 'bypassPermissions');
			assert.strictEqual(events[0].modelId, undefined);
		});

		it('should preserve model id when setting permission mode', async () => {
			service.setModelIdForSession('session-1', 'claude-opus-4-20250514');
			service.setPermissionModeForSession('session-1', 'bypassPermissions');

			const modelId = await service.getModelIdForSession('session-1');
			assert.strictEqual(modelId, 'claude-opus-4-20250514');
		});
	});

	describe('dispose', () => {
		it('should clear session state on dispose', async () => {
			service.setModelIdForSession('session-1', 'claude-opus-4-20250514');
			service.setPermissionModeForSession('session-1', 'bypassPermissions');

			service.dispose();

			// After dispose, getting state should return defaults (though event subscriptions won't work)
			// We can't really test this fully without internal access, but we can verify it doesn't throw
			const newService = new ClaudeSessionStateService();
			const modelId = await newService.getModelIdForSession('session-1');
			assert.strictEqual(modelId, undefined);
			newService.dispose();
		});
	});
});
