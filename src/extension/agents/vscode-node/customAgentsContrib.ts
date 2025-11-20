/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { CustomAgentsProvider } from './customAgentsProvider';

export class CustomAgentsContribution extends Disposable implements IExtensionContribution {
	readonly id = 'CustomAgents';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		if ('registerCustomAgentsProvider' in vscode.chat) {
			const provider = instantiationService.createInstance(CustomAgentsProvider);
			this._register(vscode.chat.registerCustomAgentsProvider(provider));
		}
	}
}
