/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Import from @github/copilot/sdk - types are defined in copilot-sdk.d.ts
import type { AgentOptions, CopilotCLISessionManager, RunnerLogger, SDKEvent, Session } from '@github/copilot/sdk';
import { createServiceIdentifier } from '../../../../util/common/services';

// Re-export SDK types
export type { AgentOptions, CopilotCLISessionManager, RunnerLogger, SDKEvent, Session };

export const ICopilotCLISdkService = createServiceIdentifier<ICopilotCLISdkService>('ICopilotCLISdkService');

export interface ICopilotCLISdkService {
	readonly _serviceBrand: undefined;

	/**
	 * Creates a new CopilotCLI agent and queries it with the given prompt
	 * @param prompt The user's prompt/instruction
	 * @param options Agent configuration options
	 * @returns AsyncGenerator of SDK events
	 */
	query(prompt: string, options: AgentOptions): AsyncGenerator<SDKEvent>;
}

/**
 * Service that wraps the CopilotCLI SDK Agent for dependency injection
 */
export class CopilotCLISdkService implements ICopilotCLISdkService {
	readonly _serviceBrand: undefined;

	async *query(prompt: string, options: AgentOptions): AsyncGenerator<SDKEvent> {
		// Dynamically import the SDK
		const { Agent } = await import('@github/copilot/sdk');
		const agent = new Agent(options);
		yield* agent.query(prompt);
	}
}
