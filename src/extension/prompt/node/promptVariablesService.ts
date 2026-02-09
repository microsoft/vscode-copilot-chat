/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatLanguageModelToolReference, ChatPromptReference } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';


export const IPromptVariablesService = createServiceIdentifier<IPromptVariablesService>('IPromptVariablesService');

export interface IPromptVariablesService {
	readonly _serviceBrand: undefined;
	resolveVariablesInPrompt(message: string, variables: readonly ChatPromptReference[]): Promise<{ message: string }>;
	resolveToolReferencesInPrompt(message: string, toolReferences: readonly ChatLanguageModelToolReference[]): Promise<string>;
}

export class NullPromptVariablesService implements IPromptVariablesService {
	declare readonly _serviceBrand: undefined;

	async resolveVariablesInPrompt(message: string, variables: readonly ChatPromptReference[]): Promise<{ message: string }> {
		return { message };
	}

	async resolveToolReferencesInPrompt(message: string, toolReferences: readonly ChatLanguageModelToolReference[]): Promise<string> {
		return message;
	}
}
