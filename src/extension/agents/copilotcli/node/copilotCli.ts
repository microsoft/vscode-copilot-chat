/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions } from '@github/copilot/sdk';
import type { ChatSessionProviderOptionItem, Uri } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { getCopilotLogger } from './logger';
import { ensureNodePtyShim } from './nodePtyShim';
import { PermissionRequest } from './permissionHelpers';
import { ensureRipgrepShim } from './ripgrepShim';

const COPILOT_CLI_MODEL_MEMENTO_KEY = 'github.copilot.cli.sessionModel';
const COPILOT_CLI_REQUEST_MAP_KEY = 'github.copilot.cli.requestMap';

export class CopilotCLISessionOptions {
	public readonly isolationEnabled: boolean;
	public readonly workingDirectory?: Uri;
	private readonly model?: string;
	private readonly mcpServers?: SessionOptions['mcpServers'];
	private readonly logger: ReturnType<typeof getCopilotLogger>;
	private readonly requestPermissionRejected: NonNullable<SessionOptions['requestPermission']>;
	private requestPermissionHandler: NonNullable<SessionOptions['requestPermission']>;
	constructor(options: { model?: string; isolationEnabled?: boolean; workingDirectory?: Uri; mcpServers?: SessionOptions['mcpServers'] }, logger: ILogService) {
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
			logger: this.logger,
			requestPermission: async (request: PermissionRequest) => {
				return await this.requestPermissionHandler(request);
			}
		};

		if (this.workingDirectory) {
			allOptions.workingDirectory = this.workingDirectory.fsPath;
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
	getDefaultModel(): Promise<ChatSessionProviderOptionItem | undefined>;
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
		@ILogService private readonly logService: ILogService,
	) {
		this._availableModels = new Lazy<Promise<ChatSessionProviderOptionItem[]>>(() => this._getAvailableModels());
	}
	public toModelProvider(modelId: string) {
		return modelId;
	}
	public async getDefaultModel() {
		// First item in the list is always the default model (SDK sends the list ordered based on default preference)
		const models = await this.getAvailableModels();
		if (!models.length) {
			return;
		}
		const defaultModel = models[0];
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
		const [{ getAvailableModels }, authInfo] = await Promise.all([this.copilotCLISDK.getPackage(), this.copilotCLISDK.getAuthInfo()]);
		try {
			const models = await getAvailableModels(authInfo);
			return models.map(model => ({
				id: model.model,
				name: model.label
			} satisfies ChatSessionProviderOptionItem));
		} catch (ex) {
			this.logService.error(`[CopilotCLISession] Failed to fetch models`, ex);
			return [];
		}
	}
}

/**
 * Service interface to abstract dynamic import of the Copilot CLI SDK for easier unit testing.
 * Tests can provide a mock implementation returning a stubbed SDK shape.
 */
export interface ICopilotCLISDK {
	readonly _serviceBrand: undefined;
	getPackage(): Promise<typeof import('@github/copilot/sdk')>;
	getAuthInfo(): Promise<NonNullable<SessionOptions['authInfo']>>;
	getRequestId(sdkRequestId: string): RequestDetails['details'] | undefined;
	setRequestId(sdkRequestId: string, details: { requestId: string; toolIdEditMap: Record<string, string> }): void;
	getDefaultWorkingDirectory(): Promise<Uri | undefined>;
}

type RequestDetails = { details: { requestId: string; toolIdEditMap: Record<string, string> }; createdDateTime: number };
export class CopilotCLISDK implements ICopilotCLISDK {
	declare _serviceBrand: undefined;
	private requestMap: Record<string, RequestDetails> = {};

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IEnvService private readonly envService: IEnvService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IAuthenticationService private readonly authentService: IAuthenticationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		this.requestMap = this.extensionContext.workspaceState.get<Record<string, RequestDetails>>(COPILOT_CLI_REQUEST_MAP_KEY, {});
	}

	getRequestId(sdkRequestId: string): RequestDetails['details'] | undefined {
		return this.requestMap[sdkRequestId]?.details;
	}

	setRequestId(sdkRequestId: string, details: { requestId: string; toolIdEditMap: Record<string, string> }): void {
		this.requestMap[sdkRequestId] = { details, createdDateTime: Date.now() };
		// Prune entries older than 7 days
		const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const [key, value] of Object.entries(this.requestMap)) {
			if (value.createdDateTime < sevenDaysAgo) {
				delete this.requestMap[key];
			}
		}
		this.extensionContext.workspaceState.update(COPILOT_CLI_REQUEST_MAP_KEY, this.requestMap);
	}

	public async getPackage(): Promise<typeof import('@github/copilot/sdk')> {
		try {
			// Ensure the node-pty shim exists before importing the SDK (required for CLI sessions)
			await this.ensureShims();
			return await import('@github/copilot/sdk');
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Failed to load @github/copilot/sdk: ${error}`);
			throw error;
		}
	}

	protected async ensureShims(): Promise<void> {
		await Promise.all([
			ensureNodePtyShim(this.extensionContext.extensionPath, this.envService.appRoot, this.logService),
			ensureRipgrepShim(this.extensionContext.extensionPath, this.envService.appRoot, this.logService)
		]);
	}

	public async getAuthInfo(): Promise<NonNullable<SessionOptions['authInfo']>> {
		const copilotToken = await this.authentService.getAnyGitHubSession();
		return {
			type: 'token',
			token: copilotToken?.accessToken ?? '',
			host: 'https://github.com'
		};
	}

	public async getDefaultWorkingDirectory(): Promise<Uri | undefined> {
		if (this.workspaceService.getWorkspaceFolders().length === 0) {
			return undefined;
		}
		if (this.workspaceService.getWorkspaceFolders().length === 1) {
			return this.workspaceService.getWorkspaceFolders()[0];
		}
		const folder = await this.workspaceService.showWorkspaceFolderPicker();
		return folder?.uri;
	}
}

