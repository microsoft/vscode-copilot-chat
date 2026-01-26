/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { GitRelatedFilesProvider } from '../node/gitRelatedFilesProvider';

export class RelatedFilesProviderContribution extends Disposable implements IExtensionContribution {

	constructor(@IInstantiationService private readonly _instantiationService: IInstantiationService) {
		super();

		this._register(vscode.chat.registerRelatedFilesProvider(this._instantiationService.createInstance(GitRelatedFilesProvider), { description: 'Git' }));
	}
}
