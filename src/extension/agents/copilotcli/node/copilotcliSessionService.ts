/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import type { CopilotCLISessionManager, SDKEvent } from './copilotcliClient';
import { parseChatMessagesToEvents } from './copilotcliToolInvocationFormatter';

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

	private _sessionManager: CopilotCLISessionManager | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	private async getSessionManager(): Promise<CopilotCLISessionManager> {
		if (!this._sessionManager) {
			try {
				const { CopilotCLISessionManager } = await import('@github/copilot/sdk');
				this._sessionManager = new CopilotCLISessionManager({
					logger: {
						isDebug: () => false,
						debug: (msg: string) => this.logService.debug(msg),
						log: (msg: string) => this.logService.trace(msg),
						info: (msg: string) => this.logService.info(msg),
						notice: (msg: string | Error) => this.logService.info(typeof msg === 'string' ? msg : msg.message),
						warning: (msg: string | Error) => this.logService.warn(typeof msg === 'string' ? msg : msg.message),
						error: (msg: string | Error) => this.logService.error(typeof msg === 'string' ? msg : msg.message),
						startGroup: () => { },
						endGroup: () => { }
					}
				});
			} catch (error) {
				this.logService.error(`Failed to initialize CopilotCLISessionManager: ${error}`);
				throw error;
			}
		}
		return this._sessionManager;
	}

	async getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]> {
		try {
			const sessionManager = await this.getSessionManager();
			const sessionMetadataList = await sessionManager.listSessions();

			// Convert SessionMetadata to ICopilotCLISession
			const sessions: ICopilotCLISession[] = await Promise.all(
				sessionMetadataList.map(async (metadata) => {
					try {
						// Get the full session to access chat messages
						const sdkSession = await sessionManager.getSession(metadata.id);
						const chatMessages = await sdkSession.getChatMessages();

						// Convert chat messages to SDKEvents using shared parser
						const events = parseChatMessagesToEvents(chatMessages);

						return {
							id: metadata.id,
							label: metadata.selectedModel || `Session ${metadata.id.slice(0, 8)}`,
							events: events,
							timestamp: metadata.startTime
						};
					} catch (error) {
						this.logService.warn(`Failed to load session ${metadata.id}: ${error}`);
						// Return minimal session info if we can't load the full session
						return {
							id: metadata.id,
							label: metadata.selectedModel || `Session ${metadata.id.slice(0, 8)}`,
							events: [],
							timestamp: metadata.startTime
						};
					}
				})
			);

			return sessions;
		} catch (error) {
			this.logService.error(`Failed to get all sessions: ${error}`);
			return [];
		}
	}

	async getSession(sessionId: string, token: CancellationToken): Promise<ICopilotCLISession | undefined> {
		const all = await this.getAllSessions(token);
		return all.find(session => session.id === sessionId);
	}
}
