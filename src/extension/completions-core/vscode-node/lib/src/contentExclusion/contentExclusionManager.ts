/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionsIgnoreServiceBridge } from '../../../bridge/src/completionsIgnoreServiceBridge';
import { Context } from '../context';
import { IIgnoreService } from '../../../../../../platform/ignore/common/ignoreService';
import { URI } from '../../../../../../util/vs/base/common/uri';

export enum StatusBarEvent {
	UPDATE = 'UPDATE',
}

/**
 * This class is responsible for managing the repository control feature
 * Listens to token events to get feature flag state
 * Listens to TextDocumentEvents events to re-evaluate and update the status bar
 * Provides public facing isBlocked
 */
export class CopilotContentExclusionManager {

	private readonly ignoreService: IIgnoreService;

	constructor(private ctx: Context) {
		this.ignoreService = this.ctx.get(CompletionsIgnoreServiceBridge).ignoreService;
	}

	get enabled() {
		return this.ignoreService.isEnabled;
	}

	async evaluate(
		uri: string,
		fileContent: string,
		shouldUpdateStatusBar?: StatusBarEvent
	): Promise<PolicyEvaluationResult> {
		const isCopilotIgnored = await this.ignoreService.isCopilotIgnored(URI.parse(uri));
		return { isBlocked: isCopilotIgnored };
	}
}

type PolicyEvaluationResult = {
	/**
	 * Should we block copilot functionality
	 */
	isBlocked: boolean;
}