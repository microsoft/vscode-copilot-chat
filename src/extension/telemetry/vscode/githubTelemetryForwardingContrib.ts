/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env } from 'vscode';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';

export class GithubTelemetryForwardingContrib extends Disposable implements IExtensionContribution {
	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		const channel = env.getDataChannel<IEditTelemetryData>('editTelemetry');
		this._register(channel.onDidReceiveData((args) => {
			if (!isGithubExtensionDataEvent(args.data.eventName, args.data.data)) {
				return;
			}
			const data = translateToGithubProperties(args.data.eventName, args.data.data);
			const { properties, measurements } = dataToPropsAndMeasurements(data);
			this._telemetryService.sendGHTelemetryEvent('vscode.' + args.data.eventName, properties, measurements);
		}));
	}
}

function isGithubExtensionDataEvent(eventName: string, data: Record<string, unknown>): boolean {
	// TODO: should this also apply to other/all events?
	if (eventName === 'inlineCompletion.endOfLife' && 'extensionId' in data) {
		const extId = data['extensionId'];
		if (typeof extId === 'string' && extId !== 'github.copilot' && extId !== 'github.copilot-chat') {
			return false;
		}
	}
	return true;
}

function translateToGithubProperties(eventName: string, data: Record<string, unknown>): Record<string, unknown> {
	const githubProperties: Record<string, unknown> = { ...data };
	for (const [key, value] of Object.entries(data)) {
		const translatedProperty = translateToGithubProperty(eventName, key, value);
		if (translatedProperty) {
			githubProperties[translatedProperty.key] = translatedProperty.value;
			delete githubProperties[key];
		}
	}
	return githubProperties;
}

function translateToGithubProperty(eventName: string, key: string, value: unknown): { key: string; value: unknown } | undefined {
	if (eventName === 'inlineCompletion.endOfLife') {
		switch (key as keyof InlineCompletionEndOfLifeEvent) {
			case 'id': return { key: 'opportunityId', value };
			case 'shown': return { key: 'isShown', value: boolToNum(value) };
			case 'languageId': return { key: 'activeDocumentLanguageId', value };
			case 'superseded': return { key: 'supersededByOpportunityId', value: value ? 'unknown' : undefined };
			case 'reason': return { key: 'acceptance', value: value === 'accepted' ? 'accepted' : value === 'rejected' ? 'rejected' : 'notAccepted' };
			case 'editorType': return { key: 'isNotebook', value: boolToNum(value === 'notebook') };
		}
	}

	return undefined;
}

function dataToPropsAndMeasurements(data: Record<string, unknown>): { properties: Record<string, string>; measurements: Record<string, number> } {
	const properties: Record<string, string> = {};
	const measurements: Record<string, number> = {};
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === 'number') {
			measurements[key] = value;
		} else if (typeof value === 'string') {
			properties[key] = value;
		}
	}
	return { properties, measurements };
}

function boolToNum(value: unknown): number | undefined {
	return typeof value === 'boolean' ? (value ? 1 : 0) : undefined;
}

interface IEditTelemetryData {
	eventName: string;
	data: Record<string, unknown>;
}

type InlineCompletionEndOfLifeEvent = {
	id: string;
	extensionId: string;
	extensionVersion: string;
	shown: boolean;
	shownDuration: number;
	shownDurationUncollapsed: number;
	timeUntilShown: number | undefined;
	timeUntilProviderRequest: number;
	timeUntilProviderResponse: number;
	reason: 'accepted' | 'rejected' | 'ignored';
	partiallyAccepted: number;
	partiallyAcceptedCountSinceOriginal: number;
	partiallyAcceptedRatioSinceOriginal: number;
	partiallyAcceptedCharactersSinceOriginal: number;
	preceeded: boolean;
	requestReason: string;
	languageId: string;
	error: string | undefined;
	typingInterval: number;
	typingIntervalCharacterCount: number;
	superseded: boolean;
	editorType: string;
	viewKind: string | undefined;
	cursorColumnDistance: number | undefined;
	cursorLineDistance: number | undefined;
	lineCountOriginal: number | undefined;
	lineCountModified: number | undefined;
	characterCountOriginal: number | undefined;
	characterCountModified: number | undefined;
	disjointReplacements: number | undefined;
	sameShapeReplacements: boolean | undefined;
};