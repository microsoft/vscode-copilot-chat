/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../../../../util/vs/platform/instantiation/common/instantiation';
import { ResolvedContextItem } from '../contextProviderRegistry';
import { ICompletionsContextProviderService } from '../contextProviderStatistics';
import { filterContextItemsByType, type DiagnosticChunkWithId } from './contextItemSchemas';

export function getDiagnosticsFromContextItems(
	accessor: ServicesAccessor,
	completionId: string,
	resolvedContextItems: ResolvedContextItem[]
): DiagnosticChunkWithId[] {
	const diagnosticsContextItems = filterContextItemsByType(resolvedContextItems, 'DiagnosticChunk');

	// Set expectations for the diagnostics provided.
	for (const item of diagnosticsContextItems) {
		setupExpectationsForDiagnostics(accessor, completionId, item.data, item.providerId);
	}

	// Flatten and sort the traits by importance.
	// TODO: once we deprecate the old API, importance should also dictate elision.
	const diagnostics: DiagnosticChunkWithId[] = diagnosticsContextItems.flatMap(p => p.data);
	return diagnostics.sort((a, b) => (a.importance ?? 0) - (b.importance ?? 0));
}

function setupExpectationsForDiagnostics(accessor: ServicesAccessor, completionId: string, diagnostics: DiagnosticChunkWithId[], providerId: string) {
	const statistics = accessor.get(ICompletionsContextProviderService).getStatisticsForCompletion(completionId);

	diagnostics.forEach(t => {
		statistics.addExpectations(providerId, [[t, 'included']]);
	});
}