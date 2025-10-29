/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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

declare type Command = {
	readonly identifier: string;
	readonly readOnly: boolean;
};


/**
 * This is just a type to warn that there's a good chance it's not a real path, because
 * it was _very_ heuristically parsed out of a command.
 */
declare type PossiblePath = string;


/**
 * A permission request for executing shell commands.
 */
declare type ShellPermissionRequest = {
	readonly kind: "shell";
	/** The full command that the user is being asked to approve, e.g. `echo foo && find -exec ... && git push` */
	readonly fullCommandText: string;
	/** A concise summary of the user's intention, e.g. "Echo foo and find a file and then run git push" */
	readonly intention: string;
	/**
	 * The commands that are being invoked in the shell invocation.
	 *
	 * As a special case, which might be better represented in the type system, if there were no parsed commands
	 * e.g. `export VAR=value`, then this will have a single entry with identifier equal to the fullCommandText.
	 */
	readonly commands: ReadonlyArray<Command>;
	/**
	 * Possible file paths that the command might access.
	 *
	 * This is entirely heuristic, so it's pretty untrustworthy.
	 */
	readonly possiblePaths: ReadonlyArray<PossiblePath>;
	/**
	 * Indicates whether any command in the script has redirection to write to a file.
	 */
	readonly hasWriteFileRedirection: boolean;
	/**
	 * If there are complicated constructs, then persistent approval is not supported.
	 * e.g. `cat $(echo "foo")` should not be persistently approvable because it's hard
	 * for the user to understand the implications.
	 */
	readonly canOfferSessionApproval: boolean;
};


/**
 * A permission request for writing to new or existing files.
 */
declare type WritePermissionRequest = {
	readonly kind: "write";
	/** The intention of the edit operation, e.g. "Edit file" or "Create file" */
	readonly intention: string;
	/** The name of the file being edited */
	readonly fileName: string;
	/** The diff of the changes being made */
	readonly diff: string;
};


/**
 * A permission request for invoking an MCP tool.
 */
declare type MCPPermissionRequest = {
	readonly kind: "mcp";
	/** The name of the MCP Server being targeted e.g. "github-mcp-server" */
	readonly serverName: string;
	/** The name of the tool being targeted e.g. "list_issues" */
	readonly toolName: string;
	/** The title of the tool being targeted e.g. "List Issues" */
	readonly toolTitle: string;
	/**
	 * The _hopefully_ JSON arguments that will be passed to the MCP tool.
	 *
	 * This should be an object, but it's not parsed before this point so we can't guarantee that.
	 * */
	readonly args: unknown;
	/**
	 * Whether the tool is read-only (e.g. a `view` operation) or not (e.g. an `edit` operation).
	 */
	readonly readOnly: boolean;
};


/**
 * A permission request which will be used to check tool or path usage against config and/or request user approval.
 */
export declare type PermissionRequest = ShellPermissionRequest | WritePermissionRequest | MCPPermissionRequest | { kind: 'read'; intention: string };

