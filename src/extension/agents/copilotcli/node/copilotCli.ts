/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions } from '@github/copilot/sdk';
import type { ChatSessionProviderOptionItem } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { Disposable, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { getCopilotLogger } from './logger';
import { ensureNodePtyShim } from './nodePtyShim';

const COPILOT_CLI_MODEL_MEMENTO_KEY = 'github.copilot.cli.sessionModel';
const DEFAULT_CLI_MODEL = 'claude-sonnet-4';

export interface ICopilotCLIModels {
	_serviceBrand: undefined;
	toModelProvider(modelId: string): string;
	getDefaultModel(): Promise<ChatSessionProviderOptionItem>;
	setDefaultModel(model: ChatSessionProviderOptionItem): Promise<void>;
	getAvailableModels(): Promise<ChatSessionProviderOptionItem[]>;
}

export const ICopilotCLISDK = createServiceIdentifier<ICopilotCLISDK>('ICopilotCLISDK');

export const ICopilotCLIModels = createServiceIdentifier<ICopilotCLIModels>('ICopilotCLIModels');

export class CopilotCLIModels implements ICopilotCLIModels {
	declare _serviceBrand: undefined;
	private readonly _availableModels: Lazy<Promise<ChatSessionProviderOptionItem[]>>;
	constructor(
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		this._availableModels = new Lazy<Promise<ChatSessionProviderOptionItem[]>>(() => this._getAvailableModels());
	}
	public toModelProvider(modelId: string) {
		return modelId;
	}
	public async getDefaultModel() {
		// We control this
		const models = await this.getAvailableModels();
		const defaultModel = models.find(m => m.id.toLowerCase() === DEFAULT_CLI_MODEL.toLowerCase()) ?? models[0];
		const preferredModelId = this.extensionContext.globalState.get<string>(COPILOT_CLI_MODEL_MEMENTO_KEY, defaultModel.id);

		return models.find(m => m.id === preferredModelId) ?? defaultModel;
	}

	public async setDefaultModel(model: ChatSessionProviderOptionItem): Promise<void> {
		await this.extensionContext.globalState.update(COPILOT_CLI_MODEL_MEMENTO_KEY, model.id);
	}

	public async getAvailableModels(): Promise<ChatSessionProviderOptionItem[]> {
		// No need to query sdk multiple times, cache the result, this cannot change during a vscode session.
		return this._availableModels.value;
	}

	private async _getAvailableModels(): Promise<ChatSessionProviderOptionItem[]> {
		const { getAvailableModels } = await this.copilotCLISDK.getPackage();
		const models = await getAvailableModels();
		return models.map(model => ({
			id: model.model,
			name: model.label
		} satisfies ChatSessionProviderOptionItem));
	}
}

/**
 * Service interface to abstract dynamic import of the Copilot CLI SDK for easier unit testing.
 * Tests can provide a mock implementation returning a stubbed SDK shape.
 */
export interface ICopilotCLISDK {
	readonly _serviceBrand: undefined;
	getPackage(): Promise<typeof import('@github/copilot/sdk')>;
}

export class CopilotCLISDK implements ICopilotCLISDK {
	declare _serviceBrand: undefined;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IEnvService private readonly envService: IEnvService,
		@ILogService private readonly logService: ILogService,
	) { }

	public async getPackage(): Promise<typeof import('@github/copilot/sdk')> {
		try {
			// Ensure the node-pty shim exists before importing the SDK (required for CLI sessions)
			await ensureNodePtyShim(this.extensionContext.extensionPath, this.envService.appRoot, this.logService);
			return await import('@github/copilot/sdk');
		} catch (error) {
			this.logService.error(`[CopilotCLISDK] Failed to load @github/copilot/sdk: ${error}`);
			throw error;
		}
	}
}

export interface ICopilotCLISessionOptionsService {
	readonly _serviceBrand: undefined;
	createOptions(
		options: SessionOptions,
		permissionHandler: CopilotCLIPermissionsHandler
	): Promise<SessionOptions>;
}
export const ICopilotCLISessionOptionsService = createServiceIdentifier<ICopilotCLISessionOptionsService>('ICopilotCLISessionOptionsService');

export class CopilotCLISessionOptionsService implements ICopilotCLISessionOptionsService {
	declare _serviceBrand: undefined;
	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
	) { }

	public async createOptions(options: SessionOptions, permissionHandler: CopilotCLIPermissionsHandler) {
		const copilotToken = await this._authenticationService.getAnyGitHubSession();
		const workingDirectory = options.workingDirectory ?? await this.getWorkspaceFolderPath();
		const allOptions: SessionOptions = {
			env: {
				...process.env,
				COPILOTCLI_DISABLE_NONESSENTIAL_TRAFFIC: '1'
			},
			logger: getCopilotLogger(this.logService),
			requestPermission: async (permissionRequest) => {
				return await permissionHandler.getPermissions(permissionRequest);
			},
			authInfo: {
				type: 'token',
				token: copilotToken?.accessToken ?? '',
				host: 'https://github.com'
			},
			...options,
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


/**
 * Perhaps temporary interface to handle permission requests from the Copilot CLI SDK
 * Perhaps because the SDK needs a better way to handle this in long term per session.
 */
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