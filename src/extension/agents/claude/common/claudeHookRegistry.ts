/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';

/**
 * Constructor type for a hook handler class that implements HookCallbackMatcher.
 * The instantiation service will handle dependency injection.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IClaudeHookHandlerCtor = new (...args: any[]) => HookCallbackMatcher;

/**
 * Registry mapping HookEvent types to their handler constructors.
 */
export type ClaudeHookRegistryType = Partial<Record<HookEvent, IClaudeHookHandlerCtor[]>>;

/**
 * Global registry of hook handler constructors organized by HookEvent.
 */
export const claudeHookRegistry: ClaudeHookRegistryType = {};

/**
 * Registers a hook handler constructor for a specific HookEvent.
 * Call this at module load time after defining a hook handler class.
 *
 * @param hookEvent The event type this handler responds to
 * @param ctor The constructor for the hook handler class
 */
export function registerClaudeHook(hookEvent: HookEvent, ctor: IClaudeHookHandlerCtor): void {
	if (!claudeHookRegistry[hookEvent]) {
		claudeHookRegistry[hookEvent] = [];
	}
	claudeHookRegistry[hookEvent]!.push(ctor);
}

/**
 * Builds the hooks configuration object from the registry using dependency injection.
 *
 * @param instantiationService The instantiation service for creating hook instances with DI
 * @returns Hooks configuration object ready to pass to Claude SDK options
 */
export function buildHooksFromRegistry(
	instantiationService: IInstantiationService
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const result: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

	for (const [hookEvent, ctors] of Object.entries(claudeHookRegistry) as [HookEvent, IClaudeHookHandlerCtor[]][]) {
		if (!ctors || ctors.length === 0) {
			continue;
		}

		result[hookEvent] = ctors.map(ctor => instantiationService.createInstance(ctor));
	}

	return result;
}
