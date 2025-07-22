/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ToolGrouping } from './toolGrouping';
import { IToolGrouping, IToolGroupingService } from './virtualToolTypes';

export class ToolGroupingService implements IToolGroupingService {
	declare readonly _serviceBrand: undefined;

	constructor(@IInstantiationService private readonly _instantiationService: IInstantiationService) { }

	create(tools: readonly LanguageModelToolInformation[]): IToolGrouping {
		return this._instantiationService.createInstance(ToolGrouping, tools);
	}
}
