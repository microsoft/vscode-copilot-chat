/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../types/src';
import { CompletionState } from '../../completionState';
import { Context } from '../../context';
import { LRUCacheMap } from '../../helpers/cache';
import { TelemetryWithExp } from '../../telemetry';
import { ContextProviderRegistry, ResolvedContextItem } from '../contextProviderRegistry';

export class ContextProviderBridge {
	private scheduledResolutions = new LRUCacheMap<string, Promise<ResolvedContextItem[]>>(25);

	constructor(private readonly ctx: Context) { }

	schedule(
		completionState: CompletionState,
		completionId: string,
		opportunityId: string,
		telemetryData: TelemetryWithExp,
		cancellationToken?: CancellationToken,
		options?: { data?: unknown }
	) {
		const registry = this.ctx.get(ContextProviderRegistry);
		const { textDocument, originalPosition, originalOffset, originalVersion, editsWithPosition } = completionState;

		const resolutionPromise = registry.resolveAllProviders(
			completionId,
			opportunityId,
			{
				uri: textDocument.uri,
				languageId: textDocument.detectedLanguageId,
				version: originalVersion,
				offset: originalOffset,
				position: originalPosition,
				proposedEdits: editsWithPosition.length > 0 ? editsWithPosition : undefined,
			},
			telemetryData,
			cancellationToken,
			options?.data
		);

		this.scheduledResolutions.set(completionId, resolutionPromise);
		// intentionally not awaiting to avoid blocking
	}

	async resolution(id: string): Promise<ResolvedContextItem[]> {
		const resolutionPromise = this.scheduledResolutions.get(id);
		if (resolutionPromise) {
			return await resolutionPromise;
		}
		return [];
	}
}
