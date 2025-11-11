/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions } from '@github/copilot/sdk';
import type { CancellationToken, ChatParticipantToolToken } from 'vscode';
import { URI } from '../../../../util/vs/base/common/uri';
import { ServicesAccessor } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { createEditConfirmation } from '../../../tools/node/editFileToolUtils';

type CoreTerminalConfirmationToolParams = {
	tool: ToolName.CoreTerminalConfirmationTool;
	input: {
		message: string;
		command: string | undefined;
		isBackground: boolean;
	};
}

type CoreConfirmationToolParams = {
	tool: ToolName.CoreConfirmationTool;
	input: {
		title: string;
		message: string;
		confirmationType: 'basic';
	};
}

export async function requestPermission(
	accessor: ServicesAccessor,
	permissionRequest: PermissionRequest,
	toolsService: IToolsService,
	toolInvocationToken: ChatParticipantToolToken,
	token: CancellationToken,
): Promise<boolean> {

	const toolParams = await getConfirmationToolParams(accessor, permissionRequest);
	if (!toolParams) {
		return true;
	}
	const { tool, input } = toolParams;
	const result = await toolsService.invokeTool(tool, { input, toolInvocationToken }, token);

	const firstResultPart = result.content.at(0);
	return (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes');
}

export async function requiresFileEditconfirmation(accessor: ServicesAccessor, permissionRequest: PermissionRequest): Promise<boolean> {
	const confirmationInfo = await getFileEditConfirmationToolParams(accessor, permissionRequest);
	return confirmationInfo !== undefined;
}

async function getFileEditConfirmationToolParams(accessor: ServicesAccessor, permissionRequest: PermissionRequest): Promise<CoreConfirmationToolParams | undefined> {
	if (permissionRequest.kind !== 'write') {
		return;
	}
	const file = permissionRequest.fileName ? URI.file(permissionRequest.fileName) : undefined;
	if (!file) {
		return;
	}
	const confirmationInfo = await createEditConfirmation(accessor, [file]);
	const confirmationMessage = confirmationInfo.confirmationMessages;
	if (!confirmationMessage) {
		return;
	}

	return {
		tool: ToolName.CoreConfirmationTool,
		input: {
			title: confirmationMessage.title,
			message: typeof confirmationMessage.message === 'string' ? confirmationMessage.message : confirmationMessage.message.value,
			confirmationType: 'basic'
		}
	};
}
/**
 * Pure function mapping a Copilot CLI permission request -> tool invocation params.
 * Keeps logic out of session class for easier unit testing.
 */
export async function getConfirmationToolParams(accessor: ServicesAccessor, permissionRequest: PermissionRequest): Promise<CoreTerminalConfirmationToolParams | CoreConfirmationToolParams | undefined> {
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
		return getFileEditConfirmationToolParams(accessor, permissionRequest);
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