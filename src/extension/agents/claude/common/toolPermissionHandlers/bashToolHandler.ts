/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BashInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import * as l10n from '@vscode/l10n';
import { IClaudeToolConfirmationParams, IClaudeToolPermissionHandler } from '../claudeToolPermission';
import { registerToolPermissionHandler } from '../claudeToolPermissionRegistry';
import { ClaudeToolNames } from '../claudeTools';

/**
 * Handler for the Bash tool.
 * Shows terminal-style confirmation with the command highlighted.
 */
export class BashToolHandler implements IClaudeToolPermissionHandler<ClaudeToolNames.Bash> {
	public readonly toolNames = [ClaudeToolNames.Bash] as const;

	public getConfirmationParams(
		toolName: ClaudeToolNames.Bash,
		input: BashInput
	): IClaudeToolConfirmationParams {
		return {
			title: l10n.t('Use {0}?', toolName),
			message: `\`\`\`\n${JSON.stringify(input, null, 2)}\n\`\`\``,
			confirmationType: 'terminal',
			terminalCommand: input.command
		};
	}
}

// Self-register the handler
registerToolPermissionHandler(
	[ClaudeToolNames.Bash],
	BashToolHandler
);
