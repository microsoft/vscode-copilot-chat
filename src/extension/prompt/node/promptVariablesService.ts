/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatLanguageModelToolReference, ChatPromptReference } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { URI } from '../../../util/vs/base/common/uri';


export const IPromptVariablesService = createServiceIdentifier<IPromptVariablesService>('IPromptVariablesService');

export interface IPromptVariablesService {
	readonly _serviceBrand: undefined;
	resolvePromptReferencesInPrompt(message: string, variables: readonly ChatPromptReference[]): Promise<{ message: string }>;
	resolveToolReferencesInPrompt(message: string, toolReferences: readonly ChatLanguageModelToolReference[]): Promise<string>;

	/**
	 * Replace all known `{{VARIABLE}}` template placeholders in {@link content}.
	 *
	 * @param content  The raw template string (skill, agent, prompt, or instructions content).
	 * @param sessionResource  The current chat session resource, used for resolving variables that depend on the session context (e.g. `{{CURRENT_SESSION_LOG}}`).
	 * @returns The content with all resolvable placeholders replaced.
	 */
	resolveTemplateVariables(content: string, sessionResource: URI | undefined): string;
}

export class NullPromptVariablesService implements IPromptVariablesService {
	declare readonly _serviceBrand: undefined;

	async resolvePromptReferencesInPrompt(message: string, variables: readonly ChatPromptReference[]): Promise<{ message: string }> {
		return { message };
	}

	async resolveToolReferencesInPrompt(message: string, toolReferences: readonly ChatLanguageModelToolReference[]): Promise<string> {
		return message;
	}

	resolveTemplateVariables(content: string, sessionResource: URI | undefined): string {
		return content;
	}
}
