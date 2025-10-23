/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../context';
import { ResolvedContextItem } from '../contextProviderRegistry';
import { filterContextItemsByType, TraitWithId } from './contextItemSchemas';
import { ContextProviderStatistics } from '../contextProviderStatistics';
import { telemetry, TelemetryProperties, TelemetryWithExp } from '../../telemetry';
import { Trait } from '../../../../types/src';

export function getTraitsFromContextItems(
	ctx: Context,
	completionId: string,
	resolvedContextItems: ResolvedContextItem[]
): TraitWithId[] {
	const traitsContextItems = filterContextItemsByType(resolvedContextItems, 'Trait');

	// Set expectations for the traits
	for (const item of traitsContextItems) {
		setupExpectationsForTraits(ctx, completionId, item.data, item.providerId);
	}

	// Flatten and sort the traits by importance.
	// TODO: once we deprecate the old API, importance should also dictate elision.
	const traits: TraitWithId[] = traitsContextItems.flatMap(p => p.data);
	return traits.sort((a, b) => (a.importance ?? 0) - (b.importance ?? 0));
}

function setupExpectationsForTraits(ctx: Context, completionId: string, traits: TraitWithId[], providerId: string) {
	const statistics = ctx.get(ContextProviderStatistics).getStatisticsForCompletion(completionId);

	traits.forEach(t => {
		statistics.addExpectations(providerId, [[t, 'included']]);
	});
}

// Maintain a list of names for traits we'd like to report in telemetry.
// The key is the trait name, and the value is the corresponding name of the telemetry property as listed in the hydro schema.
const traitNamesForTelemetry: Map<string, string> = new Map([
	['TargetFrameworks', 'targetFrameworks'],
	['LanguageVersion', 'languageVersion'],
]);

export function ReportTraitsTelemetry(
	eventName: string,
	ctx: Context,
	traits: Trait[],
	detectedLanguageId: string,
	clientLanguageId: string,
	telemetryData: TelemetryWithExp
) {
	if (traits.length > 0) {
		const properties: TelemetryProperties = {};
		properties.detectedLanguageId = detectedLanguageId;
		properties.languageId = clientLanguageId;

		for (const trait of traits) {
			const mappedTraitName = traitNamesForTelemetry.get(trait.name);
			if (mappedTraitName) {
				properties[mappedTraitName] = trait.value;
			}
		}

		const telemetryDataExt = telemetryData.extendedBy(properties, {});
		return telemetry(ctx, eventName, telemetryDataExt);
	}
}
