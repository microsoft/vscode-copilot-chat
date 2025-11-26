/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions, SweCustomAgent } from '@github/copilot/sdk';
import type { ChatSessionProviderOptionItem, Uri } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
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
// Store last used Agent per workspace.
const COPILOT_CLI_AGENT_MEMENTO_KEY = 'github.copilot.cli.customAgent';
// Store last used Agent for a Session.
const COPILOT_CLI_SESSION_AGENTS_MEMENTO_KEY = 'github.copilot.cli.sessionAgents';
export const COPILOT_CLI_DEFAULT_AGENT_ID = '___vscode_default___';

export class CopilotCLISessionOptions {
	public readonly isolationEnabled: boolean;
	public readonly workingDirectory?: Uri;
	private readonly model?: string;
	private readonly agent?: SweCustomAgent;
	private readonly customAgents?: SweCustomAgent[];
	private readonly mcpServers?: SessionOptions['mcpServers'];
	private readonly logger: ReturnType<typeof getCopilotLogger>;
	private readonly requestPermissionRejected: NonNullable<SessionOptions['requestPermission']>;
	private requestPermissionHandler: NonNullable<SessionOptions['requestPermission']>;
	constructor(options: { model?: string; isolationEnabled?: boolean; workingDirectory?: Uri; mcpServers?: SessionOptions['mcpServers']; agent?: SweCustomAgent; customAgents?: SweCustomAgent[] }, logger: ILogService) {
		this.isolationEnabled = !!options.isolationEnabled;
		this.workingDirectory = options.workingDirectory;
		this.model = options.model;
		this.mcpServers = options.mcpServers;
		this.agent = options.agent;
		this.customAgents = options.customAgents;
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
		if (this.agent) {
			allOptions.selectedCustomAgent = this.agent;
		}
		if (this.customAgents) {
			allOptions.customAgents = this.customAgents;
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

export interface ICopilotCLIAgents {
	readonly _serviceBrand: undefined;
	getDefaultAgent(): Promise<string>;
	resolveAgent(agentId: string): Promise<SweCustomAgent | undefined>;
	setDefaultAgent(agent: string | undefined): Promise<void>;
	getAgents(): Promise<SweCustomAgent[]>;
	trackSessionAgent(sessionId: string, agent: string | undefined): Promise<void>;
	getSessionAgent(sessionId: string): Promise<string | undefined>;
}

export const ICopilotCLIAgents = createServiceIdentifier<ICopilotCLIAgents>('ICopilotCLIAgents');

export class CopilotCLIAgents implements ICopilotCLIAgents {
	declare _serviceBrand: undefined;
	private sessionAgents: Record<string, { agentId?: string; createdDateTime: number }> = {};
	constructor(
		// @ICopilotCLISDK private readonly _copilotCLISDK: ICopilotCLISDK,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		// @ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }
	async trackSessionAgent(sessionId: string, agent: string | undefined): Promise<void> {
		const details = Object.keys(this.sessionAgents).length ? this.sessionAgents : this.extensionContext.workspaceState.get<Record<string, { agentId?: string; createdDateTime: number }>>(COPILOT_CLI_SESSION_AGENTS_MEMENTO_KEY, this.sessionAgents);

		details[sessionId] = { agentId: agent, createdDateTime: Date.now() };
		this.sessionAgents = details;

		// Prune entries older than 7 days.
		const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const [key, value] of Object.entries(details)) {
			if (value.createdDateTime < sevenDaysAgo) {
				delete details[key];
			}
		}

		await this.extensionContext.workspaceState.update(COPILOT_CLI_SESSION_AGENTS_MEMENTO_KEY, details);
	}

	async getSessionAgent(sessionId: string): Promise<string | undefined> {
		const details = this.extensionContext.workspaceState.get<Record<string, { agentId?: string; createdDateTime: number }>>(COPILOT_CLI_SESSION_AGENTS_MEMENTO_KEY, this.sessionAgents);
		// Check in-memory cache first before reading from memento.
		// Possibly the session agent was just set and not yet persisted.
		const agentId = this.sessionAgents[sessionId]?.agentId ?? details[sessionId]?.agentId;
		if (!agentId || agentId === COPILOT_CLI_DEFAULT_AGENT_ID) {
			return undefined;
		}
		const agents = await this.getAgents();
		return agents.find(agent => agent.name === agentId)?.name;
	}

	async getDefaultAgent(): Promise<string> {
		const agentId = this.extensionContext.workspaceState.get<string>(COPILOT_CLI_AGENT_MEMENTO_KEY, COPILOT_CLI_DEFAULT_AGENT_ID);
		if (agentId === COPILOT_CLI_DEFAULT_AGENT_ID) {
			return agentId;
		}

		const agents = await this.getAgents();
		return agents.find(agent => agent.name === agentId)?.name ?? COPILOT_CLI_DEFAULT_AGENT_ID;
	}
	async setDefaultAgent(agent: string | undefined): Promise<void> {
		await this.extensionContext.workspaceState.update(COPILOT_CLI_AGENT_MEMENTO_KEY, agent);
	}
	async trackUsedAgent(sessionId: string, agent: string | undefined): Promise<void> {
		await this.extensionContext.workspaceState.update(COPILOT_CLI_AGENT_MEMENTO_KEY, agent);
	}
	async resolveAgent(agentId: string): Promise<SweCustomAgent | undefined> {
		const customAgents = await this.getAgents();
		return customAgents.find(agent => agent.name === agentId);
	}

	async getAgents(): Promise<SweCustomAgent[]> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLICustomAgentsEnabled)) {
			return [];
		}
		// const [auth, { getCustomAgents }, workingDirectory] = await Promise.all([this.copilotCLISDK.getAuthInfo(), this.copilotCLISDK.getPackage(), this.copilotCLISDK.getDefaultWorkingDirectory()]);
		// if (!auth) {
		// 	this.logService.warn('[CopilotCLISession] No authentication info available, cannot fetch custom agents');
		// 	return [];
		// }
		// if (!workingDirectory) {
		// 	this.logService.trace('[CopilotCLISession] No working directory available, cannot fetch custom agents');
		// 	return [];
		// }
		// return getCustomAgents(auth, workingDirectory.fsPath, undefined, getCopilotLogger(this.logService));
		return [];
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
	getDefaultWorkingDirectory(): Promise<Uri | undefined>;
}

export class CopilotCLISDK implements ICopilotCLISDK {
	declare _serviceBrand: undefined;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IEnvService private readonly envService: IEnvService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IAuthenticationService private readonly authentService: IAuthenticationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

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

