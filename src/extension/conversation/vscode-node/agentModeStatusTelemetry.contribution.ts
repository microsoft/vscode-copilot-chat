/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';

export class AgentModeStatusTelemetryContribution {

	constructor(
		@ITelemetryService _telemetryService: ITelemetryService,
		@IConfigurationService _configurationService: IConfigurationService,
	) {
		// Get the effective value of chat.agent.enabled
		const isAgentModeEnabled = _configurationService.getNonExtensionConfig<boolean>('chat.agent.enabled') ?? true;

		// Check if chat.agent.enabled is configured by user
		const inspect = vscode.workspace.getConfiguration().inspect<boolean>('chat.agent.enabled');
		const isAgentModeUserConfigured = (
			inspect?.globalValue !== undefined
			|| inspect?.globalLanguageValue !== undefined
			|| inspect?.workspaceFolderValue !== undefined
			|| inspect?.workspaceFolderLanguageValue !== undefined
			|| inspect?.workspaceValue !== undefined
			|| inspect?.workspaceLanguageValue !== undefined
		);

		/* __GDPR__
			"agentModeStatusOnActivation" : {
				"owner": "pierceboggan",
				"comment": "Track whether agent mode is disabled by user or IT policy on extension activation",
				"isAgentModeEnabled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether agent mode is effectively enabled", "isMeasurement": true },
				"isAgentModeUserConfigured": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether agent mode was configured by the user", "isMeasurement": true }
			}
		*/
		_telemetryService.sendMSFTTelemetryEvent(
			'agentModeStatusOnActivation',
			{},
			{
				isAgentModeEnabled: toNumber(isAgentModeEnabled),
				isAgentModeUserConfigured: toNumber(isAgentModeUserConfigured),
			}
		);
	}
}

function toNumber(v: boolean): 1 | 0 {
	return v ? 1 : 0;
}
