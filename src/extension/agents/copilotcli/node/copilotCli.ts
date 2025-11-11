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
import { createServiceIdentifier } from '../../../../util/common/services';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { getCopilotLogger } from './logger';
import { ensureNodePtyShim } from './nodePtyShim';
import { PermissionRequest } from './permissionHelpers';

const COPILOT_CLI_MODEL_MEMENTO_KEY = 'github.copilot.cli.sessionModel';
const DEFAULT_CLI_MODEL = 'claude-sonnet-4';

export class CopilotCLISessionOptions {
	public readonly isolationEnabled: boolean;
	public readonly workingDirectory?: string;
	private readonly model?: string;
	private readonly mcpServers?: SessionOptions['mcpServers'];
	private readonly logger: ReturnType<typeof getCopilotLogger>;
	private readonly requestPermissionRejected: NonNullable<SessionOptions['requestPermission']>;
	private requestPermissionHandler: NonNullable<SessionOptions['requestPermission']>;
	constructor(options: { model?: string; isolationEnabled?: boolean; workingDirectory?: string; mcpServers?: SessionOptions['mcpServers'] }, logger: ILogService) {
		this.isolationEnabled = !!options.isolationEnabled;
		this.workingDirectory = options.workingDirectory;
		this.model = options.model;
		this.mcpServers = options.mcpServers;
		this.logger = getCopilotLogger(logger);
		this.requestPermissionRejected = async (permission: PermissionRequest): ReturnType<NonNullable<SessionOptions['requestPermission']>> => {
			logger.info(`[CopilotCLISession] Permission request denied for permission as no handler was set: ${permission.kind}`);
			return {
				kind: "denied-interactively-by-user"
			};
		};
		this.requestPermissionHandler = this.requestPermissionRejected;
	}

	public addPermissionHandler(handler: NonNullable<SessionOptions['requestPermission']>): IDisposable {
		this.requestPermissionHandler = handler;
		return toDisposable(() => {
			if (this.requestPermissionHandler === handler) {
				this.requestPermissionHandler = this.requestPermissionRejected;
			}
		});
	}

	public toSessionOptions(): Readonly<SessionOptions & { requestPermission: NonNullable<SessionOptions['requestPermission']> }> {
		const allOptions: SessionOptions = {
			env: {
				...process.env,
				COPILOTCLI_DISABLE_NONESSENTIAL_TRAFFIC: '1'
			},
			logger: this.logger,
			requestPermission: async (request: PermissionRequest) => {
				return await this.requestPermissionHandler(request);
			}
		};

		if (this.workingDirectory) {
			allOptions.workingDirectory = this.workingDirectory;
		}
		if (this.model) {
			allOptions.model = this.model as unknown as SessionOptions['model'];
		}
		if (this.mcpServers && Object.keys(this.mcpServers).length > 0) {
			allOptions.mcpServers = this.mcpServers;
		}
		return allOptions as Readonly<SessionOptions & { requestPermission: NonNullable<SessionOptions['requestPermission']> }>;
	}
}

export interface ICopilotCLIModels {
	readonly _serviceBrand: undefined;
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
			await this.ensureNodePtyShim();
			return await import('@github/copilot/sdk');
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Failed to load @github/copilot/sdk: ${error}`);
			throw error;
		}
	}

	protected async ensureNodePtyShim(): Promise<void> {
		await ensureNodePtyShim(this.extensionContext.extensionPath, this.envService.appRoot, this.logService);
	}
}

export async function getAuthInfo(authentService: IAuthenticationService): Promise<SessionOptions['authInfo']> {
	const copilotToken = await authentService.getAnyGitHubSession();
	return {
		type: 'token',
		token: copilotToken?.accessToken ?? '',
		host: 'https://github.com'
	};
}
