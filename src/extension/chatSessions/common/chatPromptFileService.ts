/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatResource } from 'vscode';
import { ParsedPromptFile } from '../../../platform/promptFiles/common/promptsService';
import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';

export const IChatPromptFileService = createServiceIdentifier<IChatPromptFileService>('IChatPromptFileService');

export interface IChatPromptFileService extends IDisposable {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCustomAgents: Event<void>;
	readonly onDidChangeInstructions: Event<void>;
	readonly onDidChangeSkills: Event<void>;
	readonly customAgents: readonly ChatResource[];
	readonly instructions: readonly ChatResource[];
	readonly skills: readonly ChatResource[];
	/**
	 * @deprecated Use the `customAgents` property and listen to `onDidChangeCustomAgents` for changes instead.
	 */
	getCustomAgents(): ParsedPromptFile[];
}
