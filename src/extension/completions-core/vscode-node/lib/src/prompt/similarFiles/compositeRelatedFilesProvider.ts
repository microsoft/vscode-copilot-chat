/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, getConfig } from '../../config';
import { Context } from '../../context';
import { Features } from '../../experiments/features';
import { NeighboringFileType } from './neighborFiles';
import {
	EmptyRelatedFilesResponse,
	RelatedFilesDocumentInfo,
	RelatedFilesProvider,
	RelatedFilesResponse,
	relatedFilesLogger,
} from './relatedFiles';
import { TelemetryWithExp } from '../../telemetry';
import { CancellationToken as ICancellationToken } from '../../../../types/src';

const cppLanguageIds = ['cpp', 'c', 'cuda-cpp'];
const typescriptLanguageIds = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'];
const csharpLanguageIds = ['csharp'];
const neighborFileTypeMap = new Map<string, NeighboringFileType>([
	...cppLanguageIds.map(id => [id, NeighboringFileType.RelatedCpp] as const),
	...typescriptLanguageIds.map(id => [id, NeighboringFileType.RelatedTypeScript] as const),
	...csharpLanguageIds.map(id => [id, NeighboringFileType.RelatedCSharpRoslyn] as const),
]);

function getNeighboringFileType(languageId: string): NeighboringFileType {
	return neighborFileTypeMap.get(languageId) ?? NeighboringFileType.RelatedOther;
}

type ProviderCallback = (
	uri: string,
	context: { flags: Record<string, unknown> },
	cancellationToken: ICancellationToken
) => Promise<RelatedFilesResponse | undefined>;

type Provider = {
	languageId: string;
	extensionId: string;
	callback: ProviderCallback;
};

export class CompositeRelatedFilesProvider extends RelatedFilesProvider {
	protected providers: Map<string, Map<string, Provider>> = new Map();
	protected telemetrySent = false;
	private reportedUnknownProviders = new Set<string>();
	constructor(context: Context) {
		super(context);
	}
	override async getRelatedFilesResponse(
		docInfo: RelatedFilesDocumentInfo,
		telemetryData: TelemetryWithExp,
		cancellationToken: ICancellationToken | undefined
	) {
		const startTime = Date.now();
		const languageId = docInfo.clientLanguageId.toLowerCase();
		const fileType = getNeighboringFileType(languageId);
		if (fileType === NeighboringFileType.RelatedOther && !this.reportedUnknownProviders.has(languageId)) {
			this.reportedUnknownProviders.add(languageId);
			relatedFilesLogger.warn(this.context, `unknown language ${languageId}`);
		}
		this.relatedFilesTelemetry(telemetryData);

		relatedFilesLogger.debug(this.context, `Fetching related files for ${docInfo.uri}`);
		if (!this.isActive(languageId, telemetryData)) {
			relatedFilesLogger.debug(this.context, 'language-server related-files experiment is not active.');
			return EmptyRelatedFilesResponse;
		}

		const languageProviders = this.providers.get(languageId);
		if (!languageProviders) {
			return EmptyRelatedFilesResponse;
		}
		try {
			return this.convert(docInfo.uri, languageProviders, startTime, telemetryData, cancellationToken);
		} catch (error) {
			// When the command returns an empty std::optional, we get an Error exception with message:
			// "Received message which is neither a response nor a notification message: {"jsonrpc": "2.0","id": 22}"
			this.relatedFileNonresponseTelemetry(languageId, telemetryData);
			// Return undefined to inform the caller that the command failed.
			return undefined;
		}
	}
	async convert(
		uri: string,
		providers: Map<string, Provider>,
		startTime: number,
		telemetryData: TelemetryWithExp,
		token: ICancellationToken | undefined
	): Promise<RelatedFilesResponse | undefined> {
		if (!token) {
			token = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose() { } }),
			};
		}
		const combined: RelatedFilesResponse = { entries: [], traits: [] };
		let allProvidersReturnedUndefined: boolean = providers.size > 0;
		for (const provider of providers.values()) {
			const response = await provider.callback(uri, { flags: {} }, token);
			if (response) {
				allProvidersReturnedUndefined = false;
				combined.entries.push(...response.entries);
				if (response.traits) {
					combined.traits!.push(...response.traits);
				}
				for (const entry of response.entries) {
					for (const uri of entry.uris) {
						relatedFilesLogger.debug(this.context, uri.toString());
					}
				}
			}
		}
		this.performanceTelemetry(Date.now() - startTime, telemetryData);
		return allProvidersReturnedUndefined ? undefined : combined;
	}
	registerRelatedFilesProvider(extensionId: string, languageId: string, provider: ProviderCallback) {
		const languageProvider = this.providers.get(languageId);
		if (languageProvider) {
			languageProvider.set(extensionId, { extensionId, languageId, callback: provider });
		} else {
			this.providers.set(languageId, new Map([[extensionId, { extensionId, languageId, callback: provider }]]));
		}
	}
	unregisterRelatedFilesProvider(extensionId: string, languageId: string, callback: ProviderCallback) {
		const languageProvider = this.providers.get(languageId);
		if (languageProvider) {
			const currentProvider = languageProvider.get(extensionId);
			if (currentProvider && currentProvider.callback === callback) {
				languageProvider.delete(extensionId);
			}
		}
	}
	/**
	 * Providers should manage their own telemetry.
	 * These four methods are for backward compatibility with the C++ provider.
	 */
	isActive(languageId: string, telemetryData: TelemetryWithExp): boolean {
		if (csharpLanguageIds.includes(languageId)) {
			return (
				this.context.get(Features).relatedFilesVSCodeCSharp(telemetryData) ||
				getConfig(this.context, ConfigKey.RelatedFilesVSCodeCSharp)
			);
		} else if (typescriptLanguageIds.includes(languageId)) {
			return (
				this.context.get(Features).relatedFilesVSCodeTypeScript(telemetryData) ||
				getConfig(this.context, ConfigKey.RelatedFilesVSCodeTypeScript)
			);
		} else if (cppLanguageIds.includes(languageId)) {
			return (
				this.context.get(Features).cppHeadersEnableSwitch(telemetryData)
			);
		}
		return (
			this.context.get(Features).relatedFilesVSCode(telemetryData) ||
			getConfig(this.context, ConfigKey.RelatedFilesVSCode)
		);
	}
	relatedFilesTelemetry(telemetryData: TelemetryWithExp) { }
	relatedFileNonresponseTelemetry(language: string, telemetryData: TelemetryWithExp) { }
	performanceTelemetry(duration: number, telemetryData: TelemetryWithExp) { }
}
