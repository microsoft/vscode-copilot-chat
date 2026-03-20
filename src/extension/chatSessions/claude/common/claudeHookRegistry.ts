/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName, IOTelService, SpanKind, SpanStatusCode, truncateForOTel } from '../../../../platform/otel/common/index';
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

/**
 * Emits an OTel span for a hook execution in the debug panel.
 *
 * @param otelService The OTel service to emit spans
 * @param hookType The hook event type (e.g. 'PreToolUse', 'SessionStart')
 * @param hookCommand Display label for the command (e.g. 'PreToolUse:Glob')
 * @param sessionId The Claude session ID
 * @param input Hook-specific input data to serialize
 * @param options Optional: output data and error info
 */
export function emitHookOTelSpan(
	otelService: IOTelService,
	hookType: string,
	hookCommand: string,
	sessionId: string,
	input: Record<string, unknown>,
	options?: { output?: string; error?: string }
): void {
	const span = otelService.startSpan(`execute_hook ${hookType}`, {
		kind: SpanKind.INTERNAL,
		attributes: {
			[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_HOOK,
			'copilot_chat.hook_type': hookType,
			'copilot_chat.hook_command': hookCommand,
			[CopilotChatAttr.CHAT_SESSION_ID]: sessionId,
		},
	});
	try {
		span.setAttribute('copilot_chat.hook_input', truncateForOTel(JSON.stringify(input)));
	} catch { /* swallow serialization errors */ }
	if (options?.output) {
		try {
			span.setAttribute('copilot_chat.hook_output', truncateForOTel(options.output));
		} catch { /* swallow */ }
	}
	if (options?.error) {
		span.setAttribute('copilot_chat.hook_result_kind', 'error');
		span.setStatus(SpanStatusCode.ERROR, options.error);
	} else {
		span.setAttribute('copilot_chat.hook_result_kind', 'success');
		span.setStatus(SpanStatusCode.OK);
	}
	span.end();
}
