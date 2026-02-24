/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CustomAgentConfig } from '@github/copilot-sdk';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ICopilotCLIAgents } from '../../agents/copilotcli/node/copilotCli';

// Store last used Agent per workspace.
const COPILOT_CLI_AGENT_MEMENTO_KEY = 'github.copilot.cli.customAgent';
// Store last used Agent for a Session.
const COPILOT_CLI_SESSION_AGENTS_MEMENTO_KEY = 'github.copilot.cli.sessionAgents';
/**
 * @deprecated Use empty strings to represent default model/agent instead.
 * Left here for backward compatibility (for state stored by older versions of Chat extension).
 */
export const COPILOT_CLI_DEFAULT_AGENT_ID = '___vscode_default___';

export class CopilotCLIAgents extends Disposable implements ICopilotCLIAgents<CustomAgentConfig> {
	declare _serviceBrand: undefined;
	private sessionAgents: Record<string, { agentId?: string; createdDateTime: number }> = {};
	private _agentsPromise?: Promise<Readonly<CustomAgentConfig>[]>;
	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}
	private readonly _onDidChangeAgents = this._register(new Emitter<void>());
	readonly onDidChangeAgents: Event<void> = this._onDidChangeAgents.event;

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
		return agents.find(agent => agent.name.toLowerCase() === agentId)?.name;
	}

	async getDefaultAgent(): Promise<string> {
		const agentId = this.extensionContext.workspaceState.get<string>(COPILOT_CLI_AGENT_MEMENTO_KEY, '').toLowerCase();
		if (!agentId || agentId === COPILOT_CLI_DEFAULT_AGENT_ID) {
			return '';
		}

		const agents = await this.getAgents();
		return agents.find(agent => agent.name.toLowerCase() === agentId)?.name ?? '';
	}
	async setDefaultAgent(agent: string | undefined): Promise<void> {
		await this.extensionContext.workspaceState.update(COPILOT_CLI_AGENT_MEMENTO_KEY, agent);
	}
	async trackUsedAgent(sessionId: string, agent: string | undefined): Promise<void> {
		await this.extensionContext.workspaceState.update(COPILOT_CLI_AGENT_MEMENTO_KEY, agent);
	}
	async resolveAgent(agentId: string): Promise<CustomAgentConfig | undefined> {
		const customAgents = await this.getAgents();
		agentId = agentId.toLowerCase();
		const agent = customAgents.find(agent => agent.name.toLowerCase() === agentId);
		// Return a clone to allow mutations (to tools, etc).
		return agent ? this.cloneAgent(agent) : undefined;
	}

	async getAgents(): Promise<Readonly<CustomAgentConfig>[]> {
		// Cache the promise to avoid concurrent fetches
		if (!this._agentsPromise) {
			this._agentsPromise = this.getAgentsImpl().catch((error) => {
				this.logService.error('[CopilotCLIAgents] Failed to fetch custom agents', error);
				this._agentsPromise = undefined;
				return [];
			});
		}

		return this._agentsPromise;
	}

	async getAgentsImpl(): Promise<Readonly<CustomAgentConfig>[]> {
		return [];
	}

	private cloneAgent(agent: CustomAgentConfig): CustomAgentConfig {
		return JSON.parse(JSON.stringify(agent)) as CustomAgentConfig;
	}
}
