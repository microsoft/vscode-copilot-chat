/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env } from 'vscode';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { BaseGHTelemetrySender } from '../common/ghTelemetrySender';
import { ITelemetryUserConfig } from '../common/telemetry';
import { AzureInsightReporter } from '../node/azureInsightsReporter';

export class GitHubTelemetrySender extends BaseGHTelemetrySender {
	constructor(
		configService: IConfigurationService,
		envService: IEnvService,
		telemetryConfig: ITelemetryUserConfig,
		domainService: IDomainService,
		capiClientService: ICAPIClientService,
		extensionName: string,
		standardTelemetryAIKey: string,
		enhancedTelemetryAIKey: string,
		tokenStore: ICopilotTokenStore
	) {
		const telemeryLoggerFactory = (enhanced: boolean) => {
			if (enhanced) {
				return env.createTelemetryLogger(new AzureInsightReporter(capiClientService, envService, tokenStore, extensionName, enhancedTelemetryAIKey), { ignoreBuiltInCommonProperties: true, ignoreUnhandledErrors: true });
			} else {
				return env.createTelemetryLogger(new AzureInsightReporter(capiClientService, envService, tokenStore, extensionName, standardTelemetryAIKey), { ignoreBuiltInCommonProperties: true, ignoreUnhandledErrors: true });
			}
		};
		super(tokenStore, telemeryLoggerFactory, configService, telemetryConfig, envService, domainService);
	}
}