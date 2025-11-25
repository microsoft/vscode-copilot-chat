/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { OrganizationAndEnterpriseAgentProvider } from './organizationAndEnterpriseAgentProvider';

export class OrganizationAndEnterpriseAgentContribution extends Disposable implements IExtensionContribution {
	readonly id = 'OrganizationAndEnterpriseAgents';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();

		if ('registerCustomAgentsProvider' in vscode.chat) {
			// Only register the provider if the setting is enabled
			if (configurationService.getConfig(ConfigKey.ShowOrganizationAndEnterpriseAgents)) {
				const provider = instantiationService.createInstance(OrganizationAndEnterpriseAgentProvider);
				this._register(vscode.chat.registerCustomAgentsProvider(provider));
			}
		}
	}
}
