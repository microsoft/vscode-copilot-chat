/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { createServiceIdentifier } from '../../../../util/common/services';
import type { SDKEvent } from './copilotcliClient';

export interface ICopilotCLISession {
	readonly id: string;
	readonly label: string;
	readonly events: readonly SDKEvent[];
	readonly timestamp: Date;
}

export interface ICopilotCLISessionService {
	readonly _serviceBrand: undefined;
	getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]>;
	getSession(sessionId: string, token: CancellationToken): Promise<ICopilotCLISession | undefined>;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');

export class CopilotCLISessionService implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	async getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]> {
		// TODO: Implement session loading from disk
		return [];
	}

	async getSession(sessionId: string, token: CancellationToken): Promise<ICopilotCLISession | undefined> {
		const all = await this.getAllSessions(token);
		return all.find(session => session.id === sessionId);
	}
}
