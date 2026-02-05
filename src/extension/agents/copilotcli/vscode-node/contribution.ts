/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../../common/contributions';

export class CopilotCLIContrib extends Disposable implements IExtensionContribution {
	readonly id = 'copilotCLI';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
	}
}
