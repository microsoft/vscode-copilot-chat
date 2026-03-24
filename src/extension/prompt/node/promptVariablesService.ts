/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatLanguageModelToolReference, ChatPromptReference } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';


export const IPromptVariablesService = createServiceIdentifier<IPromptVariablesService>('IPromptVariablesService');

export interface IPromptVariablesService {
	readonly _serviceBrand: undefined;
	resolvePromptReferencesInPrompt(message: string, variables: readonly ChatPromptReference[]): Promise<{ message: string }>;
	resolveToolReferencesInPrompt(message: string, toolReferences: readonly ChatLanguageModelToolReference[]): Promise<string>;

	/**
	 * Replace all known `{{VARIABLE}}` template placeholders in {@link content}.
	 *
	 * @param content  The raw template string (skill, agent, prompt, or instructions content).
	 * @param sessionId  The chat session ID used to resolve session-scoped
	 *   variables.  May be `undefined` when the session is not (yet) known;
	 *   in that case session-scoped variables are left unresolved.
	 * @returns The content with all resolvable placeholders replaced.
	 */
	resolveTemplateVariables(content: string, sessionId: string | undefined): string;
}

export class NullPromptVariablesService implements IPromptVariablesService {
	declare readonly _serviceBrand: undefined;

	async resolvePromptReferencesInPrompt(message: string, variables: readonly ChatPromptReference[]): Promise<{ message: string }> {
		return { message };
	}

	async resolveToolReferencesInPrompt(message: string, toolReferences: readonly ChatLanguageModelToolReference[]): Promise<string> {
		return message;
	}

	resolveTemplateVariables(content: string, _sessionId: string | undefined): string {
		return content;
	}
}
