/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';


export function getAdditionalWelcomeMessage(accessor: ServicesAccessor): vscode.MarkdownString | undefined {
	const configurationService = accessor.get(IConfigurationService);
	if (configurationService.getConfig(ConfigKey.TeamInternal.InternalWelcomeHintEnabled)) { // can only be true for internal users
		const openSettingsCommand = 'workbench.action.openSettings';
		const messageString = new vscode.MarkdownString(vscode.l10n.t({
			message: 'If handling customer data, [disable telemetry]({0}).',
			args: [`command:${openSettingsCommand}?${encodeURIComponent('["telemetry.telemetryLevel"]')}`],
			// To make sure the translators don't break the link
			comment: [`{Locked=']({'}`]
		}));
		messageString.isTrusted = { enabledCommands: [openSettingsCommand] };
		return messageString;
	}
	return undefined;
}
