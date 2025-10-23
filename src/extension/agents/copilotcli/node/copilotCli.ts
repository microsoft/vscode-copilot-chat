/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionOptions } from '@github/copilot/sdk';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { Disposable, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { getCopilotLogger } from './logger';

export class CopilotCLISessionOptionsService {
	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
	) { }

	public async createOptions(options: SessionOptions, permissionHandler: CopilotCLIPermissionsHandler) {
		const copilotToken = await this._authenticationService.getCopilotToken();
		const workingDirectory = await this.getWorkspaceFolderPath();
		const allOptions: SessionOptions = {
			copilotToken: copilotToken.token,
			env: {
				...process.env,
				COPILOTCLI_DISABLE_NONESSENTIAL_TRAFFIC: '1'
			},
			logger: getCopilotLogger(this.logService),
			requestPermission: async (permissionRequest) => {
				return await permissionHandler.getPermissions(permissionRequest);
			},
			...options
		};

		if (workingDirectory) {
			allOptions.workingDirectory = workingDirectory;
		}
		return allOptions;
	}
	private async getWorkspaceFolderPath() {
		if (this.workspaceService.getWorkspaceFolders().length === 0) {
			return undefined;
		}
		if (this.workspaceService.getWorkspaceFolders().length === 1) {
			return this.workspaceService.getWorkspaceFolders()[0].fsPath;
		}
		const folder = await this.workspaceService.showWorkspaceFolderPicker();
		return folder?.uri?.fsPath;
	}
}

export interface ICopilotCLIPermissions {
	onDidRequestPermissions(handler: SessionOptions['requestPermission']): IDisposable;
}

export class CopilotCLIPermissionsHandler extends Disposable implements ICopilotCLIPermissions {
	private _handler: SessionOptions['requestPermission'] | undefined;

	public onDidRequestPermissions(handler: SessionOptions['requestPermission']): IDisposable {
		this._handler = handler;
		return this._register(toDisposable(() => {
			this._handler = undefined;
		}));
	}

	public async getPermissions(permission: Parameters<NonNullable<SessionOptions['requestPermission']>>[0]): Promise<ReturnType<NonNullable<SessionOptions['requestPermission']>>> {
		if (!this._handler) {
			return {
				kind: "denied-interactively-by-user"
			};
		}
		return await this._handler(permission);
	}
}