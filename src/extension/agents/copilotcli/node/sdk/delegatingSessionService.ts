/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SweCustomAgent } from '@github/copilot/sdk';
import type { CancellationToken, Uri } from 'vscode';
import { ILogService } from '../../../../../platform/log/common/logService';
import { Emitter, Event } from '../../../../../util/vs/base/common/event';
import { Lazy } from '../../../../../util/vs/base/common/lazy';
import { Disposable, IReference } from '../../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ICopilotCLISDKSelector } from '../copilotCliSdkSelector';
import { ICopilotCLISession } from '../copilotcliSession';
import { CopilotCLISessionService, ICopilotCLISessionItem, ICopilotCLISessionService } from '../copilotcliSessionService';
import { NewSdkCopilotCLISessionService } from './copilotcliSessionService';

/**
 * Lazily creates either a CopilotCLISessionService or NewSdkCopilotCLISessionService
 * based on the ICopilotCLISDKSelector.useGithubCopilotSDK() result.
 * The SDK selector is evaluated once on first access; changes require a VS Code reload.
 */
export class DelegatingCopilotCLISessionService extends Disposable implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private readonly _service: Lazy<Promise<CopilotCLISessionService | NewSdkCopilotCLISessionService>>;

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	public readonly onDidChangeSessions: Event<void> = this._onDidChangeSessions.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICopilotCLISDKSelector sdkSelector: ICopilotCLISDKSelector,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._service = new Lazy(async () => {
			const useNewSdk = await sdkSelector.useGithubCopilotSDK();
			this.logService.trace(`[DelegatingSessionService] Using ${useNewSdk ? 'new' : 'old'} SDK`);
			const service = useNewSdk
				? this._register(instantiationService.createInstance(NewSdkCopilotCLISessionService))
				: this._register(instantiationService.createInstance(CopilotCLISessionService));
			this._register(service.onDidChangeSessions(() => this._onDidChangeSessions.fire()));
			return service;
		});
	}

	async getSessionWorkingDirectory(sessionId: string, token: CancellationToken): Promise<Uri | undefined> {
		const service = await this._service.value;
		return service.getSessionWorkingDirectory(sessionId, token);
	}

	async getAllSessions(filter: (sessionId: string) => boolean | undefined, token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]> {
		const service = await this._service.value;
		return service.getAllSessions(filter, token);
	}

	async deleteSession(sessionId: string): Promise<void> {
		const service = await this._service.value;
		return service.deleteSession(sessionId);
	}

	async getSession(sessionId: string, options: { model?: string; workingDirectory?: Uri; isolationEnabled?: boolean; readonly: boolean; agent?: SweCustomAgent }, token: CancellationToken): Promise<IReference<ICopilotCLISession> | undefined> {
		const service = await this._service.value;
		return service.getSession(sessionId, options, token);
	}

	async createSession(options: { model?: string; workingDirectory?: Uri; isolationEnabled?: boolean; agent?: SweCustomAgent }, token: CancellationToken): Promise<IReference<ICopilotCLISession>> {
		const service = await this._service.value;
		return service.createSession(options, token);
	}
}
