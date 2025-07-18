/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { createDecorator } from '../../../util/vs/platform/instantiation/common/instantiation';

export const IIntentDetectionModelManagementService = createDecorator<IIntentDetectionModelManagementService>('intentDetectionModelManagementService');

export interface IIntentDetectionModelManagementService {
	readonly _serviceBrand: undefined;
	getIntentDetectionModel(modelName: string, modelVendor: string): Promise<IChatEndpoint | undefined>;
	setIntentDetectionModel(modelName: string, modelVendor: string, intentModelName: string): Promise<IChatEndpoint>;
	registerIntentDetectionModel(intentModelName: string, intentModelVendor: string, intentModelEndpoint: IChatEndpoint): void;
	getRegisteredIntentDetectionModels(): { intentModelName: string; intentModelVendor: string; intentModelEndpoint: IChatEndpoint }[];

}