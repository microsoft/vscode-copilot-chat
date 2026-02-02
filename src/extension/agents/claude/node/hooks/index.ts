/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Import all hook modules to trigger self-registration
import './loggingHooks';
import './sessionHooks';
import './subagentHooks';
import './toolHooks';

// Re-export registry and build function
export { buildHooksFromRegistry, claudeHookRegistry, registerClaudeHook } from './claudeHookRegistry';
export type { ClaudeHookRegistryType, IClaudeHookHandlerCtor } from './claudeHookRegistry';
