/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';
import { ModelConfiguration } from './dataTypes/xtabPromptOptions';

export interface IInlineEditsModelService {
	readonly _serviceBrand: undefined;

	readonly modelInfo: vscode.InlineCompletionModelInfo | undefined;

	readonly onModelListUpdated: Event<void>;

	setCurrentModelId(modelId: string): Promise<void>;

	selectedModelConfiguration(): ModelConfiguration;

	defaultModelConfiguration(): ModelConfiguration;
}

export const IInlineEditsModelService = createServiceIdentifier<IInlineEditsModelService>('IInlineEditsModelService');
