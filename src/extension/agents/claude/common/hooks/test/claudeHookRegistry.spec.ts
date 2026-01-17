/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import {
	buildHooksFromRegistry,
	claudeHookRegistry,
	IClaudeHookHandlerCtor,
	registerClaudeHook
} from '../claudeHookRegistry';

describe('claudeHookRegistry', () => {
	// Store original registry state to restore after tests
	let originalRegistry: typeof claudeHookRegistry;

	beforeEach(() => {
		// Deep copy the registry to restore later
		originalRegistry = {};
		for (const [key, value] of Object.entries(claudeHookRegistry)) {
			originalRegistry[key as HookEvent] = value;
		}
		// Clear the registry for isolated tests
		for (const key of Object.keys(claudeHookRegistry)) {
			delete claudeHookRegistry[key as HookEvent];
		}
	});

	afterEach(() => {
		// Clear current registry
		for (const key of Object.keys(claudeHookRegistry)) {
			delete claudeHookRegistry[key as HookEvent];
		}
		// Restore original registry
		for (const [key, value] of Object.entries(originalRegistry)) {
			claudeHookRegistry[key as HookEvent] = value;
		}
	});

	describe('registerClaudeHook', () => {
		it('registers a handler for a new hook event', () => {
			class TestHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}

			registerClaudeHook('Notification', TestHandler);

			expect(claudeHookRegistry['Notification']).toBeDefined();
			expect(claudeHookRegistry['Notification']!.length).toBe(1);
			expect(claudeHookRegistry['Notification']![0]).toBe(TestHandler);
		});

		it('appends handlers for the same hook event', () => {
			class FirstHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}
			class SecondHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}

			registerClaudeHook('SessionStart', FirstHandler);
			registerClaudeHook('SessionStart', SecondHandler);

			expect(claudeHookRegistry['SessionStart']!.length).toBe(2);
			expect(claudeHookRegistry['SessionStart']![0]).toBe(FirstHandler);
			expect(claudeHookRegistry['SessionStart']![1]).toBe(SecondHandler);
		});

		it('handles multiple different hook events', () => {
			class NotificationHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}
			class SessionHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}

			registerClaudeHook('Notification', NotificationHandler);
			registerClaudeHook('SessionEnd', SessionHandler);

			expect(claudeHookRegistry['Notification']!.length).toBe(1);
			expect(claudeHookRegistry['SessionEnd']!.length).toBe(1);
		});

		it('preserves registration order', () => {
			class Handler1 implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}
			class Handler2 implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}
			class Handler3 implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}

			registerClaudeHook('PreToolUse', Handler1);
			registerClaudeHook('PreToolUse', Handler2);
			registerClaudeHook('PreToolUse', Handler3);

			expect(claudeHookRegistry['PreToolUse']![0]).toBe(Handler1);
			expect(claudeHookRegistry['PreToolUse']![1]).toBe(Handler2);
			expect(claudeHookRegistry['PreToolUse']![2]).toBe(Handler3);
		});
	});

	describe('buildHooksFromRegistry', () => {
		it('returns empty object when registry is empty', () => {
			const mockInstantiationService = createMockInstantiationService();

			const result = buildHooksFromRegistry(mockInstantiationService);

			expect(Object.keys(result).length).toBe(0);
		});

		it('creates instances using instantiation service', () => {
			class TestHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}

			registerClaudeHook('UserPromptSubmit', TestHandler);

			const handlerInstance = new TestHandler();
			const mockInstantiationService = createMockInstantiationService((ctor: IClaudeHookHandlerCtor) => {
				if (ctor === TestHandler) {
					return handlerInstance;
				}
				return new ctor();
			});

			const result = buildHooksFromRegistry(mockInstantiationService);

			expect(result['UserPromptSubmit']).toBeDefined();
			expect(result['UserPromptSubmit']!.length).toBe(1);
			expect(result['UserPromptSubmit']![0]).toBe(handlerInstance);
		});

		it('creates instances for multiple handlers on same event', () => {
			class Handler1 implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}
			class Handler2 implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}

			registerClaudeHook('Stop', Handler1);
			registerClaudeHook('Stop', Handler2);

			const instance1 = new Handler1();
			const instance2 = new Handler2();
			const mockInstantiationService = createMockInstantiationService((ctor: IClaudeHookHandlerCtor) => {
				if (ctor === Handler1) {
					return instance1;
				}
				if (ctor === Handler2) {
					return instance2;
				}
				return new ctor();
			});

			const result = buildHooksFromRegistry(mockInstantiationService);

			expect(result['Stop']!.length).toBe(2);
			expect(result['Stop']![0]).toBe(instance1);
			expect(result['Stop']![1]).toBe(instance2);
		});

		it('creates instances for multiple hook events', () => {
			class PreCompactHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}
			class PermissionHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}

			registerClaudeHook('PreCompact', PreCompactHandler);
			registerClaudeHook('PermissionRequest', PermissionHandler);

			const preCompactInstance = new PreCompactHandler();
			const permissionInstance = new PermissionHandler();
			const mockInstantiationService = createMockInstantiationService((ctor: IClaudeHookHandlerCtor) => {
				if (ctor === PreCompactHandler) {
					return preCompactInstance;
				}
				if (ctor === PermissionHandler) {
					return permissionInstance;
				}
				return new ctor();
			});

			const result = buildHooksFromRegistry(mockInstantiationService);

			expect(result['PreCompact']!.length).toBe(1);
			expect(result['PermissionRequest']!.length).toBe(1);
			expect(result['PreCompact']![0]).toBe(preCompactInstance);
			expect(result['PermissionRequest']![0]).toBe(permissionInstance);
		});

		it('skips hook events with empty handler arrays', () => {
			// Manually set an empty array (edge case)
			claudeHookRegistry['SubagentStart'] = [];

			const mockInstantiationService = createMockInstantiationService();

			const result = buildHooksFromRegistry(mockInstantiationService);

			expect(result['SubagentStart']).toBeUndefined();
		});

		it('calls createInstance for each handler constructor', () => {
			class Handler1 implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}
			class Handler2 implements HookCallbackMatcher {
				readonly hooks: HookCallback[] = [];
			}

			registerClaudeHook('PostToolUse', Handler1);
			registerClaudeHook('PostToolUse', Handler2);

			const createInstanceMock = vi.fn((ctor: IClaudeHookHandlerCtor) => new ctor());
			const mockInstantiationService = {
				createInstance: createInstanceMock,
				invokeFunction: vi.fn(),
				createChild: vi.fn()
			} as unknown as IInstantiationService;

			buildHooksFromRegistry(mockInstantiationService);

			expect(createInstanceMock).toHaveBeenCalledTimes(2);
			expect(createInstanceMock).toHaveBeenCalledWith(Handler1);
			expect(createInstanceMock).toHaveBeenCalledWith(Handler2);
		});
	});

	describe('integration', () => {
		it('registered handlers with actual hook callbacks work correctly', async () => {
			const hookResult: HookJSONOutput = { continue: true };

			class FunctionalHandler implements HookCallbackMatcher {
				readonly hooks: HookCallback[];

				constructor() {
					this.hooks = [async (): Promise<HookJSONOutput> => hookResult];
				}
			}

			registerClaudeHook('Notification', FunctionalHandler);

			const mockInstantiationService = createMockInstantiationService();
			const result = buildHooksFromRegistry(mockInstantiationService);

			expect(result['Notification']).toBeDefined();
			const handler = result['Notification']![0];
			expect(handler.hooks.length).toBe(1);

			// Execute the hook callback with all required arguments
			const callbackResult = await handler.hooks[0]({} as never, undefined, {} as never);
			expect(callbackResult).toBe(hookResult);
		});
	});
});

function createMockInstantiationService(createInstanceFn?: (ctor: IClaudeHookHandlerCtor) => HookCallbackMatcher): IInstantiationService {
	return {
		createInstance: createInstanceFn ?? ((ctor: IClaudeHookHandlerCtor) => new ctor()),
		invokeFunction: vi.fn(),
		createChild: vi.fn()
	} as unknown as IInstantiationService;
}
