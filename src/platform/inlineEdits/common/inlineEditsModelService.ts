/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
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

export interface IUndesiredModelsManager {
	readonly _serviceBrand: undefined;
	isUndesiredModelId(modelId: string): boolean;
	addUndesiredModelId(modelId: string): Promise<void>;
	removeUndesiredModelId(modelId: string): Promise<void>;
}

export const IUndesiredModelsManager = createServiceIdentifier<IUndesiredModelsManager>('IUndesiredModelsManager');

export namespace UndesiredModels {

	const UNDESIRED_MODELS_KEY = 'copilot.chat.nextEdits.undesiredModelIds';
	type UndesiredModelsValue = string[];

	export class Manager implements IUndesiredModelsManager {
		declare _serviceBrand: undefined;

		constructor(
			@IVSCodeExtensionContext private readonly _vscodeExtensionContext: IVSCodeExtensionContext,
		) {
		}

		isUndesiredModelId(modelId: string) {
			const models = this._getModels();
			return models.includes(modelId);
		}

		addUndesiredModelId(modelId: string): Promise<void> {
			const models = this._getModels();
			if (!models.includes(modelId)) {
				models.push(modelId);
				return this._setModels(models);
			}
			return Promise.resolve();
		}

		removeUndesiredModelId(modelId: string): Promise<void> {
			const models = this._getModels();
			const index = models.indexOf(modelId);
			if (index !== -1) {
				models.splice(index, 1);
				return this._setModels(models);
			}
			return Promise.resolve();
		}

		private _getModels(): string[] {
			return this._vscodeExtensionContext.globalState.get<UndesiredModelsValue>(UNDESIRED_MODELS_KEY) ?? [];
		}

		private _setModels(models: string[]): Promise<void> {
			return new Promise((resolve, reject) => {
				this._vscodeExtensionContext.globalState.update(UNDESIRED_MODELS_KEY, models).then(resolve, reject);
			});
		}
	}
}

export class NullUndesiredModelsManager implements IUndesiredModelsManager {
	declare _serviceBrand: undefined;

	isUndesiredModelId(_modelId: string): boolean {
		return false;
	}
	addUndesiredModelId(_modelId: string): Promise<void> {
		return Promise.resolve();
	}
	removeUndesiredModelId(_modelId: string): Promise<void> {
		return Promise.resolve();
	}
}
