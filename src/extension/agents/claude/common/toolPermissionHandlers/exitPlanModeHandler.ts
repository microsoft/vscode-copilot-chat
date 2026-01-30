/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { IClaudeToolConfirmationParams, IClaudeToolPermissionHandler } from '../claudeToolPermission';
import { registerToolPermissionHandler } from '../claudeToolPermissionRegistry';
import { ClaudeToolNames, ExitPlanModeInput } from '../claudeTools';

/**
 * Handler for the ExitPlanMode tool.
 * Shows a confirmation dialog with Claude's plan before proceeding.
 */
export class ExitPlanModeToolHandler implements IClaudeToolPermissionHandler<ClaudeToolNames.ExitPlanMode> {
	public readonly toolNames = [ClaudeToolNames.ExitPlanMode] as const;

	public getConfirmationParams(
		_toolName: ClaudeToolNames.ExitPlanMode,
		input: ExitPlanModeInput
	): IClaudeToolConfirmationParams {
		return {
			title: l10n.t('Ready to code?'),
			message: l10n.t("Here is Claude's plan:\n\n{0}", input.plan ?? '')
		};
	}
}

// Self-register the handler
registerToolPermissionHandler(
	[ClaudeToolNames.ExitPlanMode],
	ExitPlanModeToolHandler
);
