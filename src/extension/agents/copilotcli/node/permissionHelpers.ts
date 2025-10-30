/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionOptions } from '@github/copilot/sdk';
import { ToolName } from '../../../tools/common/toolNames';

export interface PermissionToolParams {
	tool: string;
	input: unknown;
}

/**
 * Pure function mapping a Copilot CLI permission request -> tool invocation params.
 * Keeps logic out of session class for easier unit testing.
 */
export function getConfirmationToolParams(permissionRequest: PermissionRequest): PermissionToolParams {
	if (permissionRequest.kind === 'shell') {
		return {
			tool: ToolName.CoreTerminalConfirmationTool,
			input: {
				message: permissionRequest.intention || permissionRequest.fullCommandText || codeBlock(permissionRequest),
				command: permissionRequest.fullCommandText as string | undefined,
				isBackground: false
			}
		};
	}

	if (permissionRequest.kind === 'write') {
		return {
			tool: ToolName.CoreConfirmationTool,
			input: {
				title: permissionRequest.intention || 'Copilot CLI Permission Request',
				message: permissionRequest.fileName ? `Edit ${permissionRequest.fileName}` : codeBlock(permissionRequest),
				confirmationType: 'basic'
			}
		};
	}

	if (permissionRequest.kind === 'mcp') {
		const serverName = permissionRequest.serverName as string | undefined;
		const toolTitle = permissionRequest.toolTitle as string | undefined;
		const toolName = permissionRequest.toolName as string | undefined;
		const args = permissionRequest.args;
		return {
			tool: ToolName.CoreConfirmationTool,
			input: {
				title: toolTitle || `MCP Tool: ${toolName || 'Unknown'}`,
				message: serverName
					? `Server: ${serverName}\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
					: `\`\`\`json\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
				confirmationType: 'basic'
			}
		};
	}

	if (permissionRequest.kind === 'read' && typeof permissionRequest.intention === 'string' && permissionRequest.intention) {
		return {
			tool: ToolName.CoreConfirmationTool,
			input: {
				title: 'Read file(s)',
				message: permissionRequest.intention,
				confirmationType: 'basic'
			}
		};
	}

	return {
		tool: ToolName.CoreConfirmationTool,
		input: {
			title: 'Copilot CLI Permission Request',
			message: codeBlock(permissionRequest),
			confirmationType: 'basic'
		}
	};
}

function codeBlock(obj: Record<string, unknown>): string {
	return `\n\n\`\`\`\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}


/** TYPES FROM @github/copilot */

/**
 * A permission request which will be used to check tool or path usage against config and/or request user approval.
 */
export declare type PermissionRequest = Parameters<NonNullable<SessionOptions['requestPermission']>>[0] | { kind: 'read'; intention: string; path: string };

