/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../platform/log/common/logService';
import { Disposable, isDisposable } from '../../util/vs/base/common/lifecycle';
import { IInstantiationService, ServicesAccessor } from '../../util/vs/platform/instantiation/common/instantiation';

export interface IExtensionContribution {

	id?: string;

	/**
	 * Dispose of the contribution.
	 */
	dispose?(): void;
}

export interface IExtensionContributionFactory {
	create(accessor: ServicesAccessor): IExtensionContribution | void;
}

export function asContributionFactory(ctor: { new(...args: any[]): any }): IExtensionContributionFactory {
	return {
		create(accessor: ServicesAccessor): IExtensionContribution {
			const instantiationService = accessor.get(IInstantiationService);
			return instantiationService.createInstance(ctor);
		}
	};
}

export class ContributionCollection extends Disposable {
	constructor(
		contribs: IExtensionContributionFactory[],
		@ILogService logService: ILogService,
		@IInstantiationService instaService: IInstantiationService,
	) {
		super();

		for (const contribution of contribs) {
			let instance: IExtensionContribution | void | undefined;
			try {
				instance = instaService.invokeFunction(contribution.create);

				if (isDisposable(instance)) {
					this._register(instance);
				}
			} catch (error) {
				logService.error(error, `Error while loading contribution`);
			}
		}
	}
}
