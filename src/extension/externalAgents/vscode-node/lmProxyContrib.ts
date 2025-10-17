/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { Disposable, MutableDisposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { LanguageModelProxyProvider } from '../node/modelProxyProvider';
import { Event } from '../../../util/vs/base/common/event';

export class LanguageModelProxyContrib extends Disposable implements IExtensionContribution {
	readonly id = 'LanguageModelProxy';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAuthenticationService authenticationService: IAuthenticationService
	) {
		super();

		const providerDisposable = this._register(new MutableDisposable<vscode.Disposable>());
		const updateRegistration = () => {
			const token = authenticationService.copilotToken;
			// if (token?.sku === '') { // ??
			// }

			if (!providerDisposable.value && token) {
				providerDisposable.value = vscode.lm.registerLanguageModelProxyProvider(instantiationService.createInstance(LanguageModelProxyProvider));
			} else if (providerDisposable.value && !token) {
				providerDisposable.clear();
			}
		};

		this._register(Event.runAndSubscribe(authenticationService.onDidAuthenticationChange, updateRegistration));
	}
}