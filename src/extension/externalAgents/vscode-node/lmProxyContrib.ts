/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { LanguageModelProxyProvider } from '../node/modelProxyProvider';

export class LanguageModelProxyContrib extends Disposable implements IExtensionContribution {
	readonly id = 'LanguageModelProxy';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(vscode.lm.registerLanguageModelProxyProvider(instantiationService.createInstance(LanguageModelProxyProvider)));
	}
}