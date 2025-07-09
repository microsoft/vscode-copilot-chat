/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { LRUCache } from 'lru-cache';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ContextKind, ILanguageContextService, KnownSources, type ContextItem, type RequestContext } from '../../../platform/languageServer/common/languageContextService';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Queue } from '../../../util/vs/base/common/async';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import * as protocol from '../common/serverProtocol';
import { InspectorDataProvider } from './inspector';
import { ThrottledDebouncer } from './throttledDebounce';
import { ContextItemResultBuilder, ContextItemSummary, ResolvedRunnableResult, type OnCachePopulatedEvent, type OnContextComputedEvent, type OnContextComputedOnTimeoutEvent } from './types';

namespace Copilot {

	type DocumentUri = string;

	/**
	* The ContextProvider API allows extensions to provide additional context items that
	* Copilot can use in its prompt. This file contains type definitions for the methods
	* and the data structures used by the API.
	*
	* Note: providing context is not enough to ensure that the context will be used in the prompt.
	*
	* The API is exposed as an export of the Copilot extension. To use it, you can cast the
	* exported object to the ContextProviderApiV1 interface.
	*
	* Example:
	* ```
	* const copilot = vscode.extensions.getExtension("github.copilot");
	* const contextProviderAPI = copilot.exports.getContextProviderAPI("v1") as ContextProviderApiV1;
	* ```
	*/
	export interface ContextProviderApiV1 {
		registerContextProvider<T extends SupportedContextItem>(provider: ContextProvider<T>): vscode.Disposable;
	}

	/**
	* Each extension can register a number of context providers, uniquely identified by their ID.
	* In addition, each provider has to provide:
	* - a DocumentSelector, to specify the file types for which the provider is active
	* - a ContextResolver, a function that returns the context items for a given request
	*
	* Example:
	* ```
	* contextProviderAPI.registerContextProvider<Trait>({
	*  id: "pythonProvider",
	*  selector: [{ language: "python" }],
	*  resolver: {
	*      resolve: async (request, token) => {
	*        return [{name: 'traitName', value: 'traitValue'}];
	*      }
	*  }
	* });
	* ```
	*/
	export interface ContextProvider<T extends SupportedContextItem> {
		id: string;
		selector: vscode.DocumentSelector;
		resolver: ContextResolver<T>;
	}

	export interface ContextResolver<T extends SupportedContextItem> {
		resolve(request: ResolveRequest, token: vscode.CancellationToken): Promise<T> | Promise<T[]> | AsyncIterable<T>;
		// Optional method to be invoked if the request timed out. This requests additional context items.
		resolveOnTimeout?(request: ResolveRequest): T | readonly T[] | undefined;
	}

	/**
	 * The first argument of the resolve method is a ResolveRequest object, which informs
	 * the provider about:
	 * - the completionId, a unique identifier for the completion request
	 * - the documentContext, which contains information about the document for which the context is requested
	 * - the activeExperiments, a map of active experiments and their values
	 * - the timeBudget the provider has to provide context items
	 * - the previousUsageStatistics, which contains information about the last request to the provider
	 */
	export type Status = 'full' | 'partial' | 'none';

	export type ContextUsageStatistics = {
		usage: Status;
		resolution: Status;
	};

	interface TextEdit {
		/**
		* The range of the text document to be manipulated. To insert
		* text into a document create a range where start === end.
		*/
		range: protocol.Range;
		/**
		* The string to be inserted. For delete operations use an
		* empty string.
		*/
		newText: string;
	}

	export type ProposedTextEdit = TextEdit & {
		positionAfterEdit: protocol.Position;
		// Indicates whether the edit is suggested by the IDE. Otherwise it's assumed to be speculative
		source?: 'selectedCompletionInfo';
	};

	export interface DocumentContext {
		uri: DocumentUri;
		languageId: string;
		version: number;
		offset: number;
		position?: protocol.Position;
		proposedEdits?: ProposedTextEdit[];
	}
	export interface ResolveRequest {
		// A unique ID to correlate the request with the completion request.
		completionId: string;
		documentContext: DocumentContext;

		activeExperiments: Map<string, string | number | boolean | string[]>;

		/**
		 * The number of milliseconds for the context provider to provide context items.
		 * After the time budget runs out, the request will be cancelled via the CancellationToken.
		 * Providers can use this value as a hint when computing context. Providers should expect the
		 * request to be cancelled once the time budget runs out.
		 */
		timeBudget: number;

		/**
		 * Various statistics about the last completion request. This can be used by the context provider
		 * to make decisions about what context to provide for the current call.
		 */
		previousUsageStatistics?: ContextUsageStatistics;
	}

	/**
	 * These are the data types that can be provided by a context provider. Any non-conforming
	 * context items will be filtered out.
	 */
	interface ContextItem {
		/**
		 * Specifies the relative importance with respect to items of the same type.
		 * Cross-type comparisons is currently handled by the wishlist.
		 * Accepted values are integers in the range [0, 100], where 100 is the highest importance.
		 * Items with non-conforming importance values will be filtered out.
		 * Default value is 0.
		 */
		importance?: number;
	}

	// A key-value pair used for short string snippets.
	export interface Trait extends ContextItem {
		name: string;
		value: string;
	}

	// Code snippet extracted from a file. The URI is used for content exclusion.
	export interface CodeSnippet extends ContextItem {
		uri: string;
		value: string;
		// Additional URIs that contribute the same code snippet.
		additionalUris?: string[];
	}

	export type SupportedContextItem = Trait | CodeSnippet;

}

enum ExecutionTarget {
	Semantic,
	Syntax
}

type ExecConfig = {
	readonly lowPriority?: boolean;
	readonly nonRecoverable?: boolean;
	readonly cancelOnResourceChange?: vscode.Uri;
	readonly executionTarget?: ExecutionTarget;
};

enum ErrorLocation {
	Client = 'client',
	Server = 'server'
}

enum ErrorPart {
	ServerPlugin = 'server-plugin',
	TypescriptPlugin = 'typescript-plugin',
	CopilotExtension = 'copilot-extension'
}

interface TypeScriptServerError extends Error {
	response: {
		type: 'response';
		command: string;
		message: string;
	};
	version: {
		displayName: string;
	};
}
namespace TypeScriptServerError {
	export function is(value: Error): value is TypeScriptServerError {
		const candidate = value as TypeScriptServerError;
		return candidate instanceof Error && candidate.response !== undefined && candidate.version !== undefined && typeof candidate.version.displayName === 'string';
	}
}

class TelemetrySender {

	private readonly telemetryService: ITelemetryService;
	private readonly logService: ILogService;
	private sendRequestTelemetryCounter: number;
	private sendSpeculativeRequestTelemetryCounter: number;

	constructor(telemetryService: ITelemetryService, logService: ILogService) {
		this.telemetryService = telemetryService;
		this.logService = logService;
		this.sendRequestTelemetryCounter = 0;
		this.sendSpeculativeRequestTelemetryCounter = 0;
	}

	public sendSpeculativeRequestTelemetry(context: RequestContext, originalRequestId: string, numberOfItems: number): void {
		const sampleTelemetry = Math.max(1, Math.min(100, context.sampleTelemetry ?? 1));
		const shouldSendTelemetry = sampleTelemetry === 1 || this.sendSpeculativeRequestTelemetryCounter % sampleTelemetry === 0;
		this.sendSpeculativeRequestTelemetryCounter++;

		if (shouldSendTelemetry) {
			/* __GDPR__
				"typescript-context-plugin.completion-context.speculative" : {
					"owner": "dirkb",
					"comment": "Telemetry for copilot inline completion context",
					"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
					"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" },
					"originalRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The original request id for which this is a speculative request" },
					"numberOfItems": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of items in the speculative request", "isMeasurement": true },
					"sampleTelemetry": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The sampling rate for telemetry. A value of 1 means every request is logged, a value of 5 means every 5th request is logged, etc.", "isMeasurement": true }
				}
			*/
			this.telemetryService.sendMSFTTelemetryEvent(
				'typescript-context-plugin.completion-context.speculative',
				{
					requestId: context.requestId,
					source: context.source ?? KnownSources.unknown,
					originalRequestId: originalRequestId
				},
				{
					numberOfItems: numberOfItems,
					sampleTelemetry: sampleTelemetry
				}
			);
		}
		this.logService.logger.debug(`TypeScript Copilot context speculative request: [${context.requestId} - ${originalRequestId}, numberOfItems: ${numberOfItems}]`);
	}

	public sendRequestTelemetry(document: vscode.TextDocument, position: vscode.Position, context: RequestContext, data: ContextItemSummary, timeTaken: number, cacheState: { before: CacheState; after: CacheState } | undefined): void {
		const stats = data.stats;
		const nodePath = data?.path ? JSON.stringify(data.path) : JSON.stringify([0]);
		const items = stats.items;
		const totalSize = stats.totalSize;
		const fileSize = document.getText().length;

		const sampleTelemetry = Math.max(1, Math.min(100, context.sampleTelemetry ?? 1));
		const shouldSendTelemetry = sampleTelemetry === 1 || this.sendRequestTelemetryCounter % sampleTelemetry === 0;
		this.sendRequestTelemetryCounter++;
		if (shouldSendTelemetry) {
			/* __GDPR__
				"typescript-context-plugin.completion-context.request" : {
					"owner": "dirkb",
					"comment": "Telemetry for copilot inline completion context",
					"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
					"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" },
					"nodePath": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The syntax kind path to the AST node the position resolved to." },
					"cancelled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request got cancelled on the client side" },
					"timedOut": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request timed out on the server side" },
					"tokenBudgetExhausted": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the token budget was exhausted" },
					"serverTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time taken on the server side", "isMeasurement": true },
					"contextComputeTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time taken on the server side to compute the context", "isMeasurement": true },
					"timeTaken": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time taken to provide the completion", "isMeasurement": true },
					"total": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Total number of context items", "isMeasurement": true },
					"snippets": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of code snippets", "isMeasurement": true },
					"traits": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of traits", "isMeasurement": true },
					"yielded": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of yielded items", "isMeasurement": true },
					"items": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Detailed information about each context item delivered." },
					"totalSize": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Total size of all context items", "isMeasurement": true },
					"fileSize": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The size of the file", "isMeasurement": true },
					"cachedItems": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of cache items", "isMeasurement": true },
					"referencedItems": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of referenced items", "isMeasurement": true },
					"isSpeculative": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was speculative" },
					"beforeCacheState": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The cache state before the request was sent" },
					"afterCacheState": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The cache state after the request was sent" },
					"fromCache": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the context was fully provided from cache" },
					"sampleTelemetry": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The sampling rate for telemetry. A value of 1 means every request is logged, a value of 5 means every 5th request is logged, etc.", "isMeasurement": true }
				}
			*/
			this.telemetryService.sendMSFTTelemetryEvent(
				'typescript-context-plugin.completion-context.request',
				{
					requestId: context.requestId,
					source: context.source ?? KnownSources.unknown,
					nodePath: nodePath,
					cancelled: data.cancelled.toString(),
					timedOut: data.timedOut.toString(),
					tokenBudgetExhausted: data.tokenBudgetExhausted.toString(),
					items: JSON.stringify(items),
					isSpeculative: (context.proposedEdits !== undefined && context.proposedEdits.length > 0 ? true : false).toString(),
					beforeCacheState: cacheState?.before.toString(),
					afterCacheState: cacheState?.after.toString(),
					fromCache: data.fromCache.toString(),
				},
				{
					serverTime: data.serverTime,
					contextComputeTime: data.contextComputeTime,
					timeTaken,
					total: stats.total,
					snippets: stats.snippets,
					traits: stats.traits,
					yielded: stats.yielded,
					totalSize: totalSize,
					fileSize: fileSize,
					cachedItems: data.cachedItems,
					referencedItems: data.referencedItems,
					sampleTelemetry: sampleTelemetry
				}
			);
		}
		this.logService.logger.debug(`TypeScript Copilot context: [${context.requestId}, ${context.source ?? KnownSources.unknown}, ${JSON.stringify(position, undefined, 0)}, ${JSON.stringify(nodePath, undefined, 0)}, ${JSON.stringify(stats, undefined, 0)}, cacheItems:${data.cachedItems}, cacheState:${JSON.stringify(cacheState, undefined, 0)}, budgetExhausted:${data.tokenBudgetExhausted}, cancelled:${data.cancelled}, timedOut:${data.timedOut}, fileSize:${fileSize}] in [${timeTaken},${data.serverTime},${data.contextComputeTime}]ms.${data.timedOut ? ' Timed out.' : ''}`);
		if (data.errorData !== undefined && data.errorData.length > 0) {
			const errorData = data.errorData;
			for (const error of errorData) {
				/* __GDPR__
					"typescript-context-plugin.completion-context.error" : {
						"owner": "dirkb",
						"comment": "Telemetry for copilot inline completion context errors",
						"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
						"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" },
						"code": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The failure code", "isMeasurement": true },
						"message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The failure message" }
					}
				*/
				this.telemetryService.sendMSFTTelemetryEvent(
					'typescript-context-plugin.completion-context.error',
					{
						requestId: context.requestId,
						source: context.source ?? KnownSources.unknown,
						message: error.message
					},
					{
						code: error.code
					}
				);
				this.logService.logger.error('Error computing context:', `${error.message} [${error.code}]`);
			}
		}
	}

	public sendRequestOnTimeoutTelemetry(context: RequestContext, data: ContextItemSummary, cacheState: CacheState): void {
		const stats = data.stats;
		const items = stats.items;
		const totalSize = stats.totalSize;
		/* __GDPR__
			"typescript-context-plugin.completion-context.on-timeout" : {
				"owner": "dirkb",
				"comment": "Telemetry for copilot inline completion context on timeout",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
				"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" },
				"total": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Total number of context items", "isMeasurement": true },
				"snippets": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of code snippets", "isMeasurement": true },
				"traits": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of traits", "isMeasurement": true },
				"yielded": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of yielded items", "isMeasurement": true },
				"items": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Detailed information about each context item delivered." },
				"totalSize": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Total size of all context items", "isMeasurement": true },
				"cacheState": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The cache state for the onTimeout request" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'typescript-context-plugin.completion-context.on-timeout',
			{
				requestId: context.requestId,
				source: context.source ?? KnownSources.unknown,
				items: JSON.stringify(items),
				cacheState: cacheState.toString()
			},
			{
				total: stats.total,
				snippets: stats.snippets,
				traits: stats.traits,
				yielded: stats.yielded,
				totalSize: totalSize
			}
		);
		this.logService.logger.debug(`TypeScript Copilot context on timeout: [${context.requestId}, ${JSON.stringify(stats, undefined, 0)}]`);
	}

	public sendRequestFailureTelemetry(context: RequestContext, data: { error: protocol.ErrorCode; message: string; stack?: string }): void {
		/* __GDPR__
			"typescript-context-plugin.completion-context.failed" : {
				"owner": "dirkb",
				"comment": "Telemetry for copilot inline completion context in failure case",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
				"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" },
				"code:": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The failure code" },
				"message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The failure message" },
				"stack": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The failure stack" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'typescript-context-plugin.completion-context.failed',
			{
				requestId: context.requestId,
				source: context.source ?? KnownSources.unknown,
				code: data.error,
				message: data.message,
				stack: data.stack ?? 'Not available'
			}
		);
	}

	public sendRequestCancelledTelemetry(context: RequestContext): void {
		/* __GDPR__
			"typescript-context-plugin.completion-context.cancelled" : {
				"owner": "dirkb",
				"comment": "Telemetry for copilot inline completion context in cancellation case",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
				"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'typescript-context-plugin.completion-context.cancelled',
			{
				requestId: context.requestId,
				source: context.source ?? KnownSources.unknown
			}
		);
		this.logService.logger.debug(`TypeScript Copilot context request ${context.requestId} got cancelled.`);
	}

	public sendActivationTelemetry(response: protocol.PingResponse | undefined, error: any | undefined): void {
		if (response !== undefined) {
			const body: protocol.PingResponse['body'] | undefined = response?.body;
			if (body?.kind === 'ok') {
				/* __GDPR__
					"typescript-context-plugin.activation.ok" : {
						"owner": "dirkb",
						"comment": "Telemetry for TypeScript server plugin",
						"session": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the TypeScript server had a session" },
						"supported": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the TypeScript server version is supported" },
						"version": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The version of the TypeScript server" }
					}
				*/
				this.telemetryService.sendMSFTTelemetryEvent(
					'typescript-context-plugin.activation.ok',
					{
						session: body.session.toString(),
						supported: body.supported.toString(),
						version: body.version ?? 'unknown'
					}
				);
			} else if (body?.kind === 'error') {
				this.sendActivationFailedTelemetry(ErrorLocation.Server, ErrorPart.ServerPlugin, body.message, body.stack);
			} else {
				this.sendUnknownPingResponseTelemetry(ErrorLocation.Server, ErrorPart.ServerPlugin, response);
			}
		} else if (error !== undefined) {
			if (TypeScriptServerError.is(error)) {
				this.sendActivationFailedTelemetry(ErrorLocation.Server, ErrorPart.ServerPlugin, error.response.message ?? error.message, undefined, error.version.displayName);
			} else if (error instanceof Error) {
				this.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.ServerPlugin, error.message, error.stack);
			} else {
				this.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.ServerPlugin, 'Unknown error', undefined);
			}
		} else {
			this.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.ServerPlugin, 'Neither response nor error received.', undefined);
		}
	}

	public sendActivationFailedTelemetry(location: ErrorLocation, part: ErrorPart, message: string, stack?: string | undefined, version?: string | undefined): void {
		/* __GDPR__
			"typescript-context-plugin.activation.failed" : {
				"owner": "dirkb",
				"comment": "Telemetry for TypeScript server plugin",
				"location": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The location of the failure" },
				"part": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The part that errored" },
				"message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The failure message" },
				"stack": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The failure stack" },
				"version": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The version" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'typescript-context-plugin.activation.failed',
			{
				location: location,
				part: part,
				message: message,
				stack: stack ?? 'Not available',
				version: version ?? 'Not specified'
			}
		);
	}

	private sendUnknownPingResponseTelemetry(location: ErrorLocation, part: ErrorPart, response: object): void {
		/* __GDPR__
			"typescript-context-plugin.activation.unknown-ping-response" : {
				"owner": "dirkb",
				"comment": "Telemetry for TypeScript server plugin",
				"location": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The location of the failure" },
				"part": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The part that errored" },
				"response": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The response literal" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'typescript-context-plugin.activation.unknown-ping-response',
			{
				location: location,
				part: part,
				response: JSON.stringify(response, undefined, 0)
			}
		);
	}

	public sendIntegrationTelemetry(requestId: string, document: string, versionMismatch?: string): void {
		/* __GDPR__
			"typescript-context-plugin.integration.failed" : {
				"owner": "dirkb",
				"comment": "Telemetry for Copilot inline chat integration.",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
				"document": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The document for which the integration failed" },
				"versionMismatch": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The version mismatch" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'typescript-context-plugin.integration.failed',
			{
				requestId: requestId,
				document: document,
				versionMismatch: versionMismatch
			}
		);
	}

	public sendInlineCompletionProviderTelemetry(source: KnownSources, registered: boolean): void {
		if (registered) {
			/* __GDPR__
				"typescript-context-plugin.inline-completion-provider.registered" : {
					"owner": "dirkb",
					"comment": "Telemetry for Copilot inline completions",
					"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" }
				}
			*/
			this.telemetryService.sendMSFTTelemetryEvent(
				'typescript-context-plugin.inline-completion-provider.registered',
				{
					source: source
				}
			);
		} else {
			/* __GDPR__
				"typescript-context-plugin.inline-completion-provider.unregistered" : {
					"owner": "dirkb",
					"comment": "Telemetry for Copilot inline completions",
					"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" }
				}
			*/
			this.telemetryService.sendMSFTTelemetryEvent(
				'typescript-context-plugin.inline-completion-provider.unregistered',
				{
					source: source
				}
			);
		}
	}
}

type RequestInfo = {
	readonly document: string;
	readonly version: number;
	readonly languageId: string;
	readonly position: vscode.Position;
	readonly requestId: string;
	readonly path: number[];
};

type ContextRequestState = {
	client: readonly ResolvedRunnableResult[];
	clientOnTimeout: readonly ResolvedRunnableResult[];
	server: readonly protocol.CachedContextRunnableResult[];
	resultMap: Map<protocol.ContextRunnableResultId, ResolvedRunnableResult>;
	itemMap: Map<protocol.ContextItemKey, protocol.FullContextItem>;
};

type CacheInfo = {
	version: number;
	state: CacheState;
}

enum CacheState {
	NotPopulated = 'NotPopulated',
	PartiallyPopulated = 'PartiallyPopulated',
	FullyPopulated = 'FullyPopulated'
}

type ManagerUpdateResult = {
	resolved: ResolvedRunnableResult[];
	serverComputed: Set<string>;
	cached: number;
	referenced: number;
};

class RunnableResultManager implements vscode.Disposable {

	private readonly disposables = new DisposableStore();
	private requestInfo: RequestInfo | undefined;

	private cacheInfo: CacheInfo;
	private results: Map<protocol.ContextRunnableResultId, ResolvedRunnableResult>;
	private readonly withInRangeRunnableResults: { resultId: protocol.ContextRunnableResultId; range: vscode.Range }[];
	private readonly outsideRangeRunnableResults: { resultId: protocol.ContextRunnableResultId; ranges: vscode.Range[] }[] = [];
	private readonly neighborFileRunnableResults: { resultId: protocol.ContextRunnableResultId }[];

	constructor() {
		this.requestInfo = undefined;
		this.results = new Map();

		this.cacheInfo = {
			version: 0,
			state: CacheState.NotPopulated
		};
		this.withInRangeRunnableResults = [];
		this.outsideRangeRunnableResults = [];
		this.neighborFileRunnableResults = [];

		this.disposables.add(vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
			if (this.requestInfo === undefined || event.contentChanges.length === 0) {
				return;
			}
			if (event.document.uri.toString() !== this.requestInfo.document) {
				if (this.affectsTypeScript(event)) {
					this.clear();
				}
			} else {
				for (const change of event.contentChanges) {
					const changeRange = change.range;
					for (let i = 0; i < this.withInRangeRunnableResults.length;) {
						const entry = this.withInRangeRunnableResults[i];
						if (entry.range.contains(changeRange)) {
							entry.range = this.applyTextContentChangeEventToWithinRange(change, entry.range);
							i++;
						} else {
							const id = entry.resultId;
							this.results.delete(id);
							this.withInRangeRunnableResults.splice(i, 1);
						}
					}
					for (let i = 0; i < this.outsideRangeRunnableResults.length;) {
						const entry = this.outsideRangeRunnableResults[i];
						const ranges = this.applyTextContentChangeEventToOutsideRanges(change, entry.ranges);
						if (ranges === undefined) {
							const id = entry.resultId;
							this.results.delete(id);
							this.outsideRangeRunnableResults.splice(i, 1);
						} else {
							entry.ranges = ranges;
							i++;
						}
					}
					this.cacheInfo.version = event.document.version;
				}
			}
		}));
		this.disposables.add(vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
			if (this.requestInfo?.document === document.uri.toString()) {
				this.clear();
			}
		}));
		this.disposables.add(vscode.window.onDidChangeActiveTextEditor(() => {
			this.clear();
		}));
		this.disposables.add(vscode.window.tabGroups.onDidChangeTabs(() => {
			for (const item of this.neighborFileRunnableResults) {
				this.results.delete(item.resultId);
			}
			this.neighborFileRunnableResults.length = 0;
		}));
	}

	public clear(): void {
		this.requestInfo = undefined;
		this.results.clear();

		this.cacheInfo = {
			version: 0,
			state: CacheState.NotPopulated
		};
		this.withInRangeRunnableResults.length = 0;
		this.outsideRangeRunnableResults.length = 0;
		this.neighborFileRunnableResults.length = 0;
	}

	public getCacheState(): CacheState {
		return this.cacheInfo.state;
	}

	public update(document: vscode.TextDocument, version: number, position: vscode.Position, context: RequestContext, body: protocol.ComputeContextResponse.OK, requestState: ContextRequestState | undefined): ManagerUpdateResult {
		const itemMap = requestState?.itemMap ?? new Map();
		const usedResults = requestState?.resultMap ?? new Map();

		this.withInRangeRunnableResults.length = 0;
		this.outsideRangeRunnableResults.length = 0;
		this.neighborFileRunnableResults.length = 0;
		this.results = new Map();
		this.cacheInfo = {
			version: version,
			state: CacheState.NotPopulated
		};

		let cachedItems = 0;
		let referencedItems = 0;
		const serverComputed: Set<string> = new Set();
		this.requestInfo = {
			document: document.uri.toString(),
			version: version,
			languageId: document.languageId,
			position: position,
			requestId: context.requestId,
			path: body.path ?? [0]
		};

		if (body.runnableResults === undefined || body.runnableResults.length === 0) {
			return { resolved: [], cached: cachedItems, referenced: referencedItems, serverComputed: serverComputed };
		}

		const serverItems: Set<protocol.ContextItemKey> = new Set();
		// Add new client side context items to the item map.
		if (body.contextItems !== undefined && body.contextItems.length > 0) {
			for (const item of body.contextItems) {
				if (protocol.ContextItem.hasKey(item)) {
					itemMap.set(item.key, item);
					serverItems.add(item.key);
				}
			}
		}
		const updateRunnableResult = (resultItem: protocol.ContextRunnableResultTypes): ResolvedRunnableResult | undefined => {
			let result: ResolvedRunnableResult | undefined;
			if (resultItem.kind === protocol.ContextRunnableResultKind.ComputedResult) {
				serverComputed.add(resultItem.id);
				const items: protocol.FullContextItem[] = [];
				for (const contextItem of resultItem.items) {
					if (contextItem.kind === protocol.ContextKind.Reference) {
						const referenced: protocol.FullContextItem | undefined = itemMap.get(contextItem.key);
						if (referenced !== undefined) {
							referencedItems++;
							items.push(referenced);
							if (!serverItems.has(contextItem.key)) {
								cachedItems++;
							}
						}
					} else {
						items.push(contextItem);
					}
				}
				result = ResolvedRunnableResult.from(resultItem, items);
			} else if (resultItem.kind === protocol.ContextRunnableResultKind.Reference) {
				result = usedResults.get(resultItem.id);
				if (result !== undefined) {
					cachedItems += result.items.length;
				}
			}
			if (result === undefined) {
				return;
			}
			this.results.set(result.id, result);
			if (result.cache !== undefined) {
				if (result.cache.scope.kind === protocol.CacheScopeKind.WithinRange) {
					const scopeRange = result.cache.scope.range;
					const range = new vscode.Range(scopeRange.start.line, scopeRange.start.character, scopeRange.end.line, scopeRange.end.character);
					this.withInRangeRunnableResults.push({ range, resultId: result.id });
				} else if (result.cache.scope.kind === protocol.CacheScopeKind.NeighborFiles) {
					this.neighborFileRunnableResults.push({ resultId: result.id });
				} else if (result.cache.scope.kind === protocol.CacheScopeKind.OutsideRange) {
					const ranges: vscode.Range[] = [];
					for (const scopeRange of result.cache.scope.ranges) {
						ranges.push(new vscode.Range(scopeRange.start.line, scopeRange.start.character, scopeRange.end.line, scopeRange.end.character));
					}
					this.outsideRangeRunnableResults.push({ resultId: result.id, ranges });
				}
			}
			this.updateCacheState(result.state);
			return result;
		};

		const results: ResolvedRunnableResult[] = [];
		for (const runnableResult of body.runnableResults) {
			const result = updateRunnableResult(runnableResult);
			if (result !== undefined) {
				results.push(result);
			}
		}
		return { resolved: results, cached: cachedItems, referenced: referencedItems, serverComputed: serverComputed };
	}

	private updateCacheState(state: protocol.ContextRunnableState): void {
		switch (this.cacheInfo.state) {
			case CacheState.NotPopulated:
				switch (state) {
					case protocol.ContextRunnableState.Finished:
						this.cacheInfo.state = CacheState.FullyPopulated;
						break;
					case protocol.ContextRunnableState.IsFull:
					case protocol.ContextRunnableState.InProgress:
						this.cacheInfo.state = CacheState.PartiallyPopulated;
						break;
					default:
						this.cacheInfo.state = CacheState.NotPopulated;
				}
				break;
			case CacheState.PartiallyPopulated:
				// If the cache is partially populated we can only stay in that state.
				break;
			case CacheState.FullyPopulated:
				switch (state) {
					case protocol.ContextRunnableState.Finished:
						// If the cache is fully populated we can only stay in that state.
						break;
					case protocol.ContextRunnableState.IsFull:
					case protocol.ContextRunnableState.InProgress:
						this.cacheInfo.state = CacheState.PartiallyPopulated;
						break;
					default:
						this.cacheInfo.state = CacheState.NotPopulated;
				}
				break;
		}
	}

	public getRequestId(): string | undefined {
		return this.requestInfo?.requestId;
	}

	public getNodePath(): number[] {
		return this.requestInfo?.path ?? [0];
	}

	public getRunnableResult(id: protocol.ContextRunnableResultId): ResolvedRunnableResult | undefined {
		return this.results.get(id);
	}

	public getContextRequestState(document: vscode.TextDocument, position: vscode.Position): ContextRequestState | undefined {
		if (this.requestInfo?.document !== document.uri.toString()) {
			return undefined;
		}
		if (this.cacheInfo.version !== document.version) {
			this.clear();
			return undefined;
		}
		const items: Map<protocol.ContextItemKey, protocol.FullContextItem> = new Map();
		const client: ResolvedRunnableResult[] = [];
		const clientOnTimeout: ResolvedRunnableResult[] = [];
		const server: protocol.CachedContextRunnableResult[] = [];
		if (this.isCacheFullyUpToDate(document, position)) {
			for (const item of this.results.values()) {
				client.push(item);
			}
		} else {
			const handleRunnableResult = (id: string, rr: ResolvedRunnableResult) => {
				const cache = rr.cache;
				const cachedResult: protocol.CachedContextRunnableResult = {
					id: id,
					kind: protocol.ContextRunnableResultKind.CacheEntry,
					state: rr.state,
					items: []
				};
				let skipItems = false;
				if (cache !== undefined) {
					cachedResult.cache = cache;
					const emitMode = cache.emitMode;
					if (emitMode === protocol.EmitMode.ClientBased) {
						client.push(rr);
						skipItems = rr.state !== protocol.ContextRunnableState.Finished;
					} else if (emitMode === protocol.EmitMode.ClientBasedOnTimeout) {
						clientOnTimeout.push(rr);
					}
				}
				server.push(cachedResult);

				if (skipItems) {
					return;
				}

				// Add cached context items to the result;
				for (const item of rr.items) {
					if (!protocol.ContextItem.hasKey(item)) {
						continue;
					}
					const key = item.key;
					let size: number | undefined = undefined;
					switch (item.kind) {
						case protocol.ContextKind.Snippet:
							size = protocol.CodeSnippet.sizeInChars(item);
							break;
						case protocol.ContextKind.Trait:
							size = protocol.Trait.sizeInChars(item);
							break;
						default:
					}
					cachedResult.items.push(protocol.CachedContextItem.create(key, size));
					items.set(key, item);
				}
			};
			// Clear all within runnable results that don't contain the requested position.
			for (let i = 0; i < this.withInRangeRunnableResults.length;) {
				const entry = this.withInRangeRunnableResults[i];
				if (entry.range.contains(position)) {
					i++;
					continue;
				}
				const id = entry.resultId;
				this.results.delete(id);
				this.withInRangeRunnableResults.splice(i, 1);
			}
			for (const [id, item] of this.results.entries()) {
				handleRunnableResult(id, item);
			}
		}
		return { client, clientOnTimeout, server, itemMap: items, resultMap: new Map(this.results) };
	}

	private isCacheFullyUpToDate(document: vscode.TextDocument, position: vscode.Position): boolean {
		if (this.requestInfo === undefined) {
			return false;
		}
		if (this.requestInfo.document !== document.uri.toString()) {
			return false;
		}

		// Same document, version and position. Cache can be full used.
		if (this.requestInfo.version === document.version && this.requestInfo.position.isEqual(position)) {
			return true;
		}

		// Document is older than cached request. Not up to date.
		if (this.requestInfo.version > document.version) {
			return false;
		}

		// if the position is not contained in all ranges return false.
		for (const runnable of this.withInRangeRunnableResults) {
			if (!runnable.range.contains(position)) {
				return false;
			}
		}

		const range = position.isBefore(this.requestInfo.position) ? new vscode.Range(position, this.requestInfo.position) : new vscode.Range(this.requestInfo.position, position);
		const text = document.getText(range);
		return text.trim().length === 0;
	}

	public dispose(): void {
		this.clear();
		this.disposables.dispose();
	}

	private affectsTypeScript(event: vscode.TextDocumentChangeEvent): boolean {
		const languageId = event.document.languageId;
		return languageId === 'typescript' || languageId === 'typescriptreact' || languageId === 'javascript' || languageId === 'javascriptreact' || languageId === 'json';
	}

	private applyTextContentChangeEventToWithinRange(event: vscode.TextDocumentContentChangeEvent, range: vscode.Range): vscode.Range {
		// The start stays untouched since the change range is contained in the range.
		const eventRange = event.range;
		const eventText = event.text;

		// Calculate how many lines the new text adds or removes
		const linesDelta = (eventText.match(/\n/g) || []).length - (eventRange.end.line - eventRange.start.line);

		// Calculate the new end position
		const endLine = range.end.line + linesDelta;

		let endCharacter = range.end.character;
		if (eventRange.end.line === range.end.line) {
			// Calculate the character delta for the last line of the change
			const lastNewLineIndex = eventText.lastIndexOf('\n');
			const newTextLength = lastNewLineIndex !== -1 ? eventText.length - lastNewLineIndex - 1 : eventText.length;
			const oldTextLength = eventRange.end.character - (eventRange.end.line > eventRange.start.line ? 0 : eventRange.start.character);
			const charDelta = newTextLength - oldTextLength;
			endCharacter += charDelta;
		}
		return new vscode.Range(range.start, new vscode.Position(endLine, endCharacter));
	}

	private applyTextContentChangeEventToOutsideRanges(event: vscode.TextDocumentContentChangeEvent, ranges: vscode.Range[]): vscode.Range[] | undefined {
		if (ranges.length === 0) {
			return ranges;
		}
		const changeRange = event.range;
		const eventText = event.text;

		// Quick optimization: if change is completely after last range, no ranges need adjustment
		const lastRange = ranges[ranges.length - 1];
		if (changeRange.start.isAfter(lastRange.end)) {
			return ranges;
		}
		// Calculate how many lines the new text adds or removes
		const linesDelta = (eventText.match(/\n/g) || []).length - (changeRange.end.line - changeRange.start.line);
		const adjustedRanges: vscode.Range[] = [];

		for (const range of ranges) {
			if (range.end.isBefore(changeRange.start)) {
				// Range is completely before change, no adjustment needed
				adjustedRanges.push(range);
			} else if (range.start.isAfter(changeRange.end)) {
				// Range is completely after change, adjust by lines delta
				if (linesDelta === 0) {
					adjustedRanges.push(range);
				} else {
					adjustedRanges.push(new vscode.Range(
						new vscode.Position(range.start.line + linesDelta, range.start.character),
						new vscode.Position(range.end.line + linesDelta, range.end.character)
					));
				}
			} else {

				// The range intersects with the range with will invalidate the cache entry.
				return undefined;
			}
		}

		return adjustedRanges;
	}
}

namespace TextDocuments {
	export function consider(document: vscode.TextDocument): boolean {
		return document.uri.scheme === 'file' && (document.languageId === 'typescript' || document.languageId === 'typescriptreact');
	}
}

class NeighborFileModel implements vscode.Disposable {

	private readonly disposables;
	private readonly order: LRUCache<string, string>;

	constructor() {
		this.disposables = new DisposableStore();
		this.order = new LRUCache<string, string>({ max: 32 });
		this.disposables.add(vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
			if (editor === undefined) {
				return;
			}
			const document = editor.document;
			if (TextDocuments.consider(document)) {
				this.order.set(document.uri.toString(), document.uri.fsPath);
			}
		}));
		this.disposables.add(vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
			this.order.delete(document.uri.toString());
		}));
		this.disposables.add(vscode.window.tabGroups.onDidChangeTabs((e: vscode.TabChangeEvent) => {
			for (const tab of e.closed) {
				if (tab.input instanceof vscode.TabInputText) {
					this.order.delete(tab.input.uri.toString());
				}
			}
		}));
		const openTextDocuments: Set<string> = new Set();
		for (const document of vscode.workspace.textDocuments) {
			if (TextDocuments.consider(document)) {
				openTextDocuments.add(document.uri.toString());
			}
		}
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText && openTextDocuments.has(tab.input.uri.toString())) {
					this.order.set(tab.input.uri.toString(), tab.input.uri.fsPath);
				}
			}
		}
		if (vscode.window.activeTextEditor !== undefined) {
			const document = vscode.window.activeTextEditor.document;
			if (TextDocuments.consider(document)) {
				this.order.set(document.uri.toString(), document.uri.fsPath);
			}
		}
	}

	public getNeighborFiles(currentDocument: vscode.TextDocument): string[] {
		const result: string[] = [];
		const currentUri = currentDocument.uri.toString();
		for (const [key, value] of this.order.entries()) {
			if (key === currentUri) {
				continue;
			}
			result.push(value);
			if (result.length >= 10) {
				break;
			}
		}
		return result;
	}

	public dispose(): void {
		this.disposables.dispose();
	}
}

enum CancellationState {
	Delay,
	PassThrough
}
class DelayedCancellationToken implements vscode.CancellationToken {

	private readonly token: vscode.CancellationToken;
	private readonly cacheState: CacheState;
	private readonly cachePopulationTimeout: number;
	private readonly cancelThreshold: number;

	private cancellationState: CancellationState;
	// This doesn't capture the event only since the event itself can be undefined.
	private cancellationEvent: { event: any } | undefined;
	private readonly emitter: vscode.EventEmitter<any>;
	private readonly eventDisposable: vscode.Disposable;

	constructor(token: vscode.CancellationToken, startTime: number, timeBudget: number, cacheState: CacheState, cachePopulationTimeout: number) {
		this.token = token;
		this.cacheState = cacheState;
		this.cachePopulationTimeout = cachePopulationTimeout < 0 ? 0 : cachePopulationTimeout;

		// Keep on running if we have only 20 ms left. The server will auto cancel the request.
		if (cacheState === CacheState.FullyPopulated) {
			this.cancelThreshold = Math.max(0, startTime + timeBudget - 20);
		} else {
			this.cancelThreshold = Math.max(startTime + this.cachePopulationTimeout, startTime + timeBudget - 20);
		}
		this.cancellationState = timeBudget > 0 ? CancellationState.Delay : CancellationState.PassThrough;

		this.cancellationEvent = undefined;
		this.emitter = new vscode.EventEmitter<any>();

		this.eventDisposable = token.onCancellationRequested((e: any) => {
			// We received a cancellation request and the time budget is already or almost
			// exhausted. So the server plugin will auto cancel the request. We don't forward the
			// cancellation to ensure that what got computed is cached correctly. It might
			// not since the TS Server itself handles cancellation as well and might return
			// an empty result.

			if (this.cancellationState === CancellationState.PassThrough) {
				this.emitter.fire(e);
			} else if (this.shouldCancel()) {
				this.cancellationState = CancellationState.PassThrough;
				this.emitter.fire(e);
				this.cancellationEvent = undefined;
			} else {
				this.cancellationEvent = { event: e };
			}
		});
	}

	public clear(): void {
		this.cancellationState = CancellationState.PassThrough;
		this.cancellationEvent = undefined;
		this.eventDisposable.dispose();
	}

	public get onCancellationRequested(): vscode.Event<any> {
		return this.emitter.event;
	}

	public get isCancellationRequested(): boolean {
		if (this.cancellationState === CancellationState.PassThrough) {
			return this.token.isCancellationRequested;
		} else if (this.shouldCancel()) {
			const result = this.token.isCancellationRequested;
			if (result) {
				this.flushOutstandingCancellation();
			}
			return result;
		} else {
			return false;
		}
	}

	public flushOutstandingCancellation(): void {
		this.cancellationState = CancellationState.PassThrough;
		if (this.cancellationEvent !== undefined) {
			this.emitter.fire(this.cancellationEvent.event);
			this.cancellationEvent = undefined;
		}
	}

	private shouldCancel(): boolean {
		// If the cache is not populated, we don't want to cancel and keep the
		// request running until the time budget is exhausted. This is to ensure that
		// the request can be cached correctly.
		if (this.cacheState === CacheState.NotPopulated) {
			return false;
		}
		return Date.now() < this.cancelThreshold;
	}
}

type ComputeContextRequestArgs = {
	file: vscode.Uri;
	line: number;
	offset: number;
	startTime: number;
	timeBudget?: number;
	tokenBudget?: number;
	neighborFiles?: readonly string[];
	clientSideRunnableResults?: readonly protocol.CachedContextRunnableResult[];
	$traceId?: string;
};
namespace ComputeContextRequestArgs {
	export function create(document: vscode.TextDocument, position: vscode.Position, context: RequestContext, startTime: number, timeBudget: number, neighborFiles: readonly string[] | undefined, clientSideRunnableResults: readonly protocol.CachedContextRunnableResult[] | undefined): ComputeContextRequestArgs {
		return {
			file: vscode.Uri.file(document.fileName),
			line: position.line + 1,
			offset: position.character + 1,
			startTime: startTime,
			timeBudget: timeBudget,
			tokenBudget: context.tokenBudget ?? 7 * 1024,
			neighborFiles: neighborFiles !== undefined && neighborFiles.length > 0 ? neighborFiles : undefined,
			clientSideRunnableResults: clientSideRunnableResults,
			$traceId: context.requestId
		};
	}
}

export class LanguageContextServiceImpl implements ILanguageContextService, vscode.Disposable {

	readonly _serviceBrand: undefined;

	private static readonly ExecConfig: ExecConfig = { executionTarget: ExecutionTarget.Semantic };

	private readonly isDebugging: boolean;
	private _isActivated: Promise<boolean> | undefined;
	private telemetrySender: TelemetrySender;

	private readonly runnableResultManager: RunnableResultManager;
	private readonly neighborFileModel: NeighborFileModel;

	private inflightCancellationToken: DelayedCancellationToken | undefined;
	private onTimeOut: { requestId: string; results: readonly ResolvedRunnableResult[] | undefined; contextItemResult: ContextItemResultBuilder; itemMap: Map<protocol.ContextItemKey, protocol.ContextItem> } | undefined;
	private readonly cachePopulationTimeout: number;

	private readonly disposables = new DisposableStore();
	private _onCachePopulated: vscode.EventEmitter<OnCachePopulatedEvent>;
	public readonly onCachePopulated: vscode.Event<OnCachePopulatedEvent>;

	private _onContextComputed: vscode.EventEmitter<OnContextComputedEvent>;
	public readonly onContextComputed: vscode.Event<OnContextComputedEvent>;

	private _onContextComputedOnTimeout: vscode.EventEmitter<OnContextComputedOnTimeoutEvent>;
	public readonly onContextComputedOnTimeout: vscode.Event<OnContextComputedOnTimeoutEvent>;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ITelemetryService readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService
	) {
		this.isDebugging = process.execArgv.some((arg) => /^--(?:inspect|debug)(?:-brk)?(?:=\d+)?$/i.test(arg));
		this.telemetrySender = new TelemetrySender(telemetryService, logService);
		this.runnableResultManager = new RunnableResultManager();
		this.neighborFileModel = new NeighborFileModel();
		this.inflightCancellationToken = undefined;
		this.onTimeOut = undefined;
		this.cachePopulationTimeout = this.getCachePopulationTimeout();

		this.disposables = new DisposableStore();
		this._onCachePopulated = this.disposables.add(new vscode.EventEmitter<OnCachePopulatedEvent>());
		this.onCachePopulated = this._onCachePopulated.event;

		this._onContextComputed = this.disposables.add(new vscode.EventEmitter<OnContextComputedEvent>());
		this.onContextComputed = this._onContextComputed.event;

		this._onContextComputedOnTimeout = this.disposables.add(new vscode.EventEmitter<OnContextComputedOnTimeoutEvent>());
		this.onContextComputedOnTimeout = this._onContextComputedOnTimeout.event;
	}

	public dispose(): void {
		this.runnableResultManager.dispose();
		this.neighborFileModel.dispose();
		this.inflightCancellationToken = undefined;
	}

	async isActivated(documentOrLanguageId: vscode.TextDocument | string): Promise<boolean> {
		const languageId = typeof documentOrLanguageId === 'string' ? documentOrLanguageId : documentOrLanguageId.languageId;
		if (languageId !== 'typescript' && languageId !== 'typescriptreact') {
			return false;
		}
		if (this._isActivated === undefined) {
			this._isActivated = this.doIsTypeScriptActivated(languageId);
		}
		return this._isActivated;
	}

	private async doIsTypeScriptActivated(languageId: string): Promise<boolean> {

		let activated = false;

		try {
			// Check that the TypeScript extension is installed and runs in the same extension host.
			const typeScriptExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
			if (typeScriptExtension === undefined) {
				return false;
			}

			// Make sure the TypeScript extension is activated.
			await typeScriptExtension.activate();

			// Send a ping request to see if the TS server plugin got installed correctly.
			const response: protocol.PingResponse | undefined = await vscode.commands.executeCommand('typescript.tsserverRequest', '_.copilot.ping', LanguageContextServiceImpl.ExecConfig, new vscode.CancellationTokenSource().token);
			this.telemetrySender.sendActivationTelemetry(response, undefined);
			if (response !== undefined) {
				if (response.body?.kind === 'ok') {
					this.logService.logger.info('TypeScript server plugin activated.');
					activated = true;
				} else {
					this.logService.logger.error('TypeScript server plugin not activated:', response.body?.message ?? 'Message not provided.');
				}
			} else {
				this.logService.logger.error('TypeScript server plugin not activated:', 'No ping response received.');
			}
		} catch (error) {
			this.telemetrySender.sendActivationTelemetry(undefined, error);
			this.logService.logger.error('Error pinging TypeScript server plugin:', error);
		}

		return activated;
	}

	async populateCache(document: vscode.TextDocument, position: vscode.Position, context: RequestContext): Promise<void> {
		if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact') {
			return;
		}
		if (this.inflightCancellationToken !== undefined) {
			// We have a normal request running. Do not issue a cache request.
			return;
		}
		const startTime = Date.now();
		const contextRequestState = this.runnableResultManager.getContextRequestState(document, position);
		if (contextRequestState !== undefined && contextRequestState.server.length === 0) {
			// There is nothing to do on the server. Cache is up to date.
			return;
		}
		const neighborFiles: string[] = this.neighborFileModel.getNeighborFiles(document);
		const timeBudget = this.cachePopulationTimeout;
		const args: ComputeContextRequestArgs = ComputeContextRequestArgs.create(document, position, context, startTime, timeBudget, neighborFiles, contextRequestState?.server);
		try {
			const isDebugging = this.isDebugging;
			const forDebugging: ContextItem[] | undefined = isDebugging ? [] : undefined;
			const tokenSource = new vscode.CancellationTokenSource();
			const token = tokenSource.token;
			const documentVersion = document.version;
			const start = Date.now();
			const cacheState = this.runnableResultManager.getCacheState();
			let response: protocol.ComputeContextResponse;
			try {
				response = await vscode.commands.executeCommand('typescript.tsserverRequest', '_.copilot.context', args, LanguageContextServiceImpl.ExecConfig, token);
			} finally {
				tokenSource.dispose();
			}
			const timeTaken = Date.now() - start;
			if (protocol.ComputeContextResponse.isCancelled(response)) {
				this.telemetrySender.sendRequestCancelledTelemetry(context);
				return;
			} else if (protocol.ComputeContextResponse.isOk(response)) {
				const body: protocol.ComputeContextResponse.OK = response.body;
				const contextItemResult = new ContextItemResultBuilder(timeTaken);
				const { resolved, cached, referenced, serverComputed } = this.runnableResultManager.update(document, documentVersion, position, context, body, contextRequestState);
				contextItemResult.cachedItems += cached;
				contextItemResult.referencedItems += referenced;
				contextItemResult.serverComputed = serverComputed;
				if (resolved.length > 0) {
					// Update the stats for telemetry.
					for (const runnableResult of resolved) {
						for (const item of contextItemResult.update(runnableResult)) {
							forDebugging?.push(item);
						}
					}
				}
				contextItemResult.updateResponse(body, token);
				this.telemetrySender.sendRequestTelemetry(document, position, context, contextItemResult, timeTaken, { before: cacheState, after: this.runnableResultManager.getCacheState() });
				isDebugging && forDebugging?.length;
				this._onCachePopulated.fire({ document, position, results: resolved, summary: contextItemResult });
				return;
			} else if (protocol.ComputeContextResponse.isError(response)) {
				this.telemetrySender.sendRequestFailureTelemetry(context, response.body);
				console.error('Error computing context:', response.body.message, response.body.stack);
			}
		} catch (error) {
		}
	}

	async *getContext(document: vscode.TextDocument, position: vscode.Position, context: RequestContext, token: vscode.CancellationToken): AsyncIterable<ContextItem> {
		if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact') {
			return;
		}
		const isDebugging = this.isDebugging;
		const forDebugging: ContextItem[] | undefined = isDebugging ? [] : undefined;
		const startTime = Date.now();
		const isSpeculativeRequest = context.proposedEdits !== undefined;
		const contextItemResult = new ContextItemResultBuilder(0);
		const neighborFiles: string[] = this.neighborFileModel.getNeighborFiles(document);
		const timeBudget = context.timeBudget ?? 150;
		const contextRequestState = this.runnableResultManager.getContextRequestState(document, position);
		const itemMap: Map<protocol.ContextItemKey, protocol.ContextItem> = contextRequestState?.itemMap ?? new Map();

		this.onTimeOut = { requestId: context.requestId, results: contextRequestState?.clientOnTimeout, contextItemResult: contextItemResult, itemMap };
		if (contextRequestState !== undefined) {
			for (const runnableResult of contextRequestState.client) {
				for (const item of contextItemResult.update(runnableResult, true)) {
					forDebugging?.push(item);
					yield item;
				}
			}
			// No server items to refresh or recompute. So we are done.
			if (contextRequestState.server.length === 0) {
				if (isSpeculativeRequest) {
					this.telemetrySender.sendSpeculativeRequestTelemetry(context, this.runnableResultManager.getRequestId() ?? 'unknown', contextItemResult.stats.yielded);
				} else {
					const cacheState = this.runnableResultManager.getCacheState();
					contextItemResult.path = this.runnableResultManager.getNodePath();
					contextItemResult.serverTime = 0;
					contextItemResult.contextComputeTime = 0;
					contextItemResult.fromCache = true;
					this.telemetrySender.sendRequestTelemetry(
						document, position, context, contextItemResult, Date.now() - startTime,
						{ before: cacheState, after: cacheState }
					);
					isDebugging && forDebugging?.length;
					this._onContextComputed.fire({ document, position, results: contextRequestState.client, summary: contextItemResult });
				}
				return;
			}
		}

		const args: ComputeContextRequestArgs = ComputeContextRequestArgs.create(document, position, context, startTime, timeBudget, neighborFiles, contextRequestState?.server);
		try {
			if (this.inflightCancellationToken !== undefined) {
				this.inflightCancellationToken.flushOutstandingCancellation();
			}
			const cacheState = this.runnableResultManager.getCacheState();
			const delayedCancellationToken = new DelayedCancellationToken(token, startTime, timeBudget, cacheState, this.cachePopulationTimeout);
			const documentVersion = document.version;
			this.inflightCancellationToken = delayedCancellationToken;
			const start = Date.now();
			let response: protocol.ComputeContextResponse;
			try {
				response = await vscode.commands.executeCommand('typescript.tsserverRequest', '_.copilot.context', args, LanguageContextServiceImpl.ExecConfig, delayedCancellationToken);
			} finally {
				if (this.inflightCancellationToken === delayedCancellationToken) {
					this.inflightCancellationToken = undefined;
				}
				delayedCancellationToken.clear();
			}
			const timeTaken = Date.now() - start;
			contextItemResult.totalTime = timeTaken;
			if (protocol.ComputeContextResponse.isCancelled(response)) {
				this.telemetrySender.sendRequestCancelledTelemetry(context);
				return;
			} else if (protocol.ComputeContextResponse.isOk(response)) {
				const body: protocol.ComputeContextResponse.OK = response.body;
				const { resolved, cached, referenced, serverComputed } = this.runnableResultManager.update(document, documentVersion, position, context, body, contextRequestState);
				contextItemResult.cachedItems += cached;
				contextItemResult.referencedItems += referenced;
				contextItemResult.serverComputed = serverComputed;
				if (resolved.length > 0) {
					for (const runnableResult of resolved) {
						for (const item of contextItemResult.update(runnableResult)) {
							forDebugging?.push(item);
							yield item;
						}
					}
				}
				contextItemResult.updateResponse(body, token);
				this.telemetrySender.sendRequestTelemetry(document, position, context, contextItemResult, timeTaken, { before: cacheState, after: this.runnableResultManager.getCacheState() });
				isDebugging && forDebugging?.length;
				this._onContextComputed.fire({ document, position, results: resolved, summary: contextItemResult });
				return;
			} else if (protocol.ComputeContextResponse.isError(response)) {
				this.telemetrySender.sendRequestFailureTelemetry(context, response.body);
				console.error('Error computing context:', response.body.message, response.body.stack);
			}
		} catch (error) {
			console.error('Error computing context:', error);
		}
		return;
	}

	getContextOnTimeout(document: vscode.TextDocument, position: vscode.Position, context: RequestContext): readonly ContextItem[] | undefined {
		if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact') {
			return;
		}
		if (this.onTimeOut === undefined || this.onTimeOut.requestId !== context.requestId) {
			return;
		}
		const contextItemSummary = this.onTimeOut.contextItemResult;
		if (this.onTimeOut.results === undefined) {
			this.telemetrySender.sendRequestOnTimeoutTelemetry(context, contextItemSummary, this.runnableResultManager.getCacheState());
			return;
		}
		const result: ContextItem[] = [];
		for (const runnableResult of this.onTimeOut.results) {
			for (const item of contextItemSummary.update(runnableResult)) {
				result.push(item);
			}
		}
		this.telemetrySender.sendRequestOnTimeoutTelemetry(context, contextItemSummary, this.runnableResultManager.getCacheState());
		this._onContextComputedOnTimeout.fire({ document, position, results: this.onTimeOut.results, summary: contextItemSummary });
		return result;
	}

	private getCachePopulationTimeout(): number {
		const result = this.configurationService.getExperimentBasedConfig(ConfigKey.TypeScriptLanguageContextCacheTimeout, this.experimentationService);
		return result ?? 500;
	}
}

const showContextInspectorViewContextKey = `github.copilot.chat.showContextInspectorView`;
export class InlineCompletionContribution implements vscode.Disposable {

	private disposables: DisposableStore;
	private registrations: DisposableStore | undefined;
	private readonly registrationQueue: Queue<void>;

	private readonly telemetrySender: TelemetrySender;
	private readonly selectionChangeDebouncer: ThrottledDebouncer;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ILogService readonly logService: ILogService,
		@ITelemetryService readonly telemetryService: ITelemetryService,
		@ILanguageContextService private readonly languageContextService: ILanguageContextService
	) {
		this.registrations = undefined;
		this.telemetrySender = new TelemetrySender(telemetryService, logService);
		this.registrationQueue = new Queue<void>();
		this.selectionChangeDebouncer = new ThrottledDebouncer();

		this.disposables = new DisposableStore();
		if (languageContextService instanceof LanguageContextServiceImpl) {
			this.disposables.add(vscode.commands.registerCommand('github.copilot.debug.showContextInspectorView', async () => {
				await vscode.commands.executeCommand('setContext', showContextInspectorViewContextKey, true);
				await vscode.commands.executeCommand('context-inspector.focus');
			}));
			this.disposables.add(vscode.window.registerTreeDataProvider('context-inspector', new InspectorDataProvider(languageContextService)));
		}

		// Check if there are any TypeScript files open in the workspace.
		const open = vscode.workspace.textDocuments.some((document) => document.languageId === 'typescript' || document.languageId === 'typescriptreact');
		if (open) {
			this.typeScriptFileOpen();
		} else {
			const disposable = vscode.workspace.onDidOpenTextDocument((document) => {
				if (document.languageId === 'typescript' || document.languageId === 'typescriptreact') {
					disposable.dispose();
					this.typeScriptFileOpen();
				}
			});
		}
	}

	dispose() {
		this.registrations?.dispose();
		this.disposables.dispose();
		this.registrationQueue.dispose();
		this.selectionChangeDebouncer.dispose();
	}

	private typeScriptFileOpen(): void {
		this.checkRegistration();
		this.disposables.add(this.configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(ConfigKey.TypeScriptLanguageContext.fullyQualifiedId)) {
				this.checkRegistration();
			}
		}));
	}

	private checkRegistration(): void {
		this.registrationQueue.queue(async () => {
			const value = this.getConfig();
			if (value === 'on') {
				await this.register();
			} else {
				this.unregister();
			}
		}).catch((error: any) => this.logService.logger.error('Error checking TypeScript context provider registration:', error));
	}

	private async register(): Promise<void> {
		if (! await this.isTypeScriptRunning()) {
			return;
		}

		const languageContextService = this.languageContextService;
		const logService = this.logService;
		try {
			if (! await languageContextService.isActivated('typescript')) {
				return;
			}

			const copilotAPI = await this.getCopilotApi();
			if (copilotAPI === undefined) {
				logService.logger.warn('Copilot API is undefined, unable to register context provider.');
				return;
			}

			if (this.registrations !== undefined) {
				this.registrations.dispose();
				this.registrations = undefined;
			}
			this.registrations = new DisposableStore();
			let lastDocumentChange: { document: string; time: number } | undefined = undefined;
			this.registrations.add(vscode.workspace.onDidChangeTextDocument((event) => {
				const time = Date.now();
				lastDocumentChange = undefined;
				const document = event.document;
				if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact') {
					return;
				}
				if (event.contentChanges.length === 0) {
					return;
				}
				const activeEditor = vscode.window.activeTextEditor;
				if (activeEditor === undefined || activeEditor.document.uri.toString() !== document.uri.toString()) {
					return;
				}
				lastDocumentChange = { document: document.uri.toString(), time: time };
			}));

			this.registrations.add(vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (lastDocumentChange === undefined) {
					return;
				}
				if (editor === undefined) {
					lastDocumentChange = undefined;
					return;
				}
				const document = editor.document;
				if (lastDocumentChange.document !== document.uri.toString()) {
					lastDocumentChange = undefined;
				}
			}));

			this.registrations.add(vscode.window.onDidChangeTextEditorSelection(async (event) => {
				const time = Date.now();
				const document = event.textEditor.document;

				function getPosition(tokenBudget: number): vscode.Position | undefined {
					const activeEditor = vscode.window.activeTextEditor;
					if (event.textEditor !== activeEditor) {
						return undefined;
					}
					if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact') {
						return;
					}
					if (event.selections.length !== 1) {
						return undefined;
					}
					const range = event.selections[0];
					if (!range.isEmpty) {
						return undefined;
					}
					const line = document.lineAt(range.start.line);
					const end = line.text.substring(range.start.character);
					// If we are not on an empty line or the end of the line is not empty, we don't want to trigger the context request.
					if (line.text.trim().length !== 0 && end.length > 0) {
						return undefined;
					}

					// If the last document change was within 500 ms, we don't want to trigger the context request. Instead we wait for the next change or
					// a normal inline completion request.
					if (lastDocumentChange !== undefined && lastDocumentChange.document === document.uri.toString() && time - lastDocumentChange.time < 500) {
						return undefined;
					}
					if (tokenBudget <= 0) {
						return undefined;
					}
					return range.start;
				}
				const tokenBudget = this.getTokenBudget(document);
				const position = getPosition(tokenBudget);
				if (position === undefined) {
					this.selectionChangeDebouncer.cancel();
					return;
				}

				const populateCache = async (document: vscode.TextDocument, position: vscode.Position, check: boolean) => {
					if (check) {
						const activeTextEditor = vscode.window.activeTextEditor;
						if (activeTextEditor === undefined || activeTextEditor.document.uri.toString() !== document.uri.toString()) {
							return;
						}
						const selections = activeTextEditor.selections;
						if (selections === undefined || selections.length !== 1) {
							return;
						}
						const selection = selections[0];
						if (!selection.isEmpty || selection.start.line !== position.line || selection.start.character !== position.character) {
							return;
						}
					}
					const context: RequestContext = {
						requestId: generateUuid(),
						timeBudget: 50,
						tokenBudget: tokenBudget,
						source: KnownSources.populateCache,
						proposedEdits: undefined
					};
					languageContextService.populateCache(event.textEditor.document, position, context).catch(() => {
						// Error got log inside the cache population call.
					});
				};
				try {
					if (event.kind === vscode.TextEditorSelectionChangeKind.Command || event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
						this.selectionChangeDebouncer.cancel();
						populateCache(document, position, false);
					}
					this.selectionChangeDebouncer.trigger(populateCache, document, position, true);
				} catch (error) {
					console.error(error);
				}
			}));

			const telemetrySender = this.telemetrySender;
			const self = this;
			const resolver: Copilot.ContextResolver<Copilot.SupportedContextItem> = {
				async *resolve(request: Copilot.ResolveRequest, token: vscode.CancellationToken): AsyncIterable<Copilot.SupportedContextItem> {
					const isSpeculativeRequest = request.documentContext.proposedEdits !== undefined;
					const [document, position] = self.getDocumentAndPosition(request, token);
					if (document === undefined || position === undefined) {
						return;
					}
					const tokenBudget = self.getTokenBudget(document);
					if (tokenBudget <= 0) {
						telemetrySender.sendRequestTelemetry(document, position, { requestId: request.completionId, source: KnownSources.completion }, ContextItemSummary.DefaultExhausted, 0, undefined);
						return [];
					}
					const context: RequestContext = {
						requestId: request.completionId,
						timeBudget: request.timeBudget,
						tokenBudget: tokenBudget,
						source: KnownSources.completion,
						proposedEdits: isSpeculativeRequest ? [] : undefined,
						sampleTelemetry: self.getSampleTelemetry(request.activeExperiments)
					};
					const items = languageContextService.getContext(document, position, context, token);
					for await (const item of items) {
						const converted = self.convertItem(item);
						if (converted === undefined) {
							continue;
						}
						yield converted;
					}
				}
			};
			if (typeof languageContextService.getContextOnTimeout === 'function') {
				resolver.resolveOnTimeout = (request) => {
					if (typeof languageContextService.getContextOnTimeout !== 'function') {
						return;
					}
					const [document, position] = self.getDocumentAndPosition(request);
					if (document === undefined || position === undefined) {
						return;
					}
					const context: RequestContext = {
						requestId: request.completionId,
						source: KnownSources.completion,
					};
					const items = languageContextService.getContextOnTimeout(document, position, context);
					if (items === undefined) {
						return;
					}
					const result: Copilot.SupportedContextItem[] = [];
					for (const item of items) {
						const converted = self.convertItem(item);
						if (converted === undefined) {
							continue;
						}
						result.push(converted);
					}
					return result;
				};
			}
			this.registrations.add(copilotAPI.registerContextProvider({
				id: 'typescript-ai-context-provider',
				selector: { scheme: 'file', language: 'typescript' },
				resolver: resolver
			}));
			this.telemetrySender.sendInlineCompletionProviderTelemetry(KnownSources.completion, true);
			logService.logger.info('Registered TypeScript context provider with Copilot inline completions.');
		} catch (error) {
			logService.logger.error('Error checking if server plugin is installed:', error);
		}
	}

	private async isTypeScriptRunning(): Promise<boolean> {
		// Check that the TypeScript extension is installed and runs in the same extension host.
		const typeScriptExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
		if (typeScriptExtension === undefined) {
			this.telemetrySender.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.TypescriptPlugin, 'TypeScript extension not found', undefined);
			this.logService.logger.error('TypeScript extension not found');
			return false;
		}
		try {
			await typeScriptExtension.activate();
			return true;
		} catch (error) {
			if (error instanceof Error) {
				this.telemetrySender.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.TypescriptPlugin, error.message, error.stack);
				this.logService.logger.error('Error checking if TypeScript plugin is installed:', error.message);
			} else {
				this.telemetrySender.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.TypescriptPlugin, 'Unknown error', undefined);
				this.logService.logger.error('Error checking if TypeScript plugin is installed: Unknown error');
			}
			return false;
		}
	}

	private getDocumentAndPosition(request: Copilot.ResolveRequest, token?: vscode.CancellationToken): [vscode.TextDocument | undefined, vscode.Position | undefined] {
		let document: vscode.TextDocument | undefined;
		if (vscode.window.activeTextEditor?.document.uri.toString() === request.documentContext.uri) {
			document = vscode.window.activeTextEditor.document;
		} else {
			document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === request.documentContext.uri);
		}
		if (document === undefined) {
			this.telemetrySender.sendIntegrationTelemetry(request.completionId, request.documentContext.uri);
			return [undefined, undefined];
		}
		const requestPos = request.documentContext.position;
		const position = requestPos !== undefined ? new vscode.Position(requestPos.line, requestPos.character) : document.positionAt(request.documentContext.offset);
		if (document.version > request.documentContext.version) {
			if (!token?.isCancellationRequested) {
				this.telemetrySender.sendIntegrationTelemetry(request.completionId, request.documentContext.uri, `Version mismatch: ${document.version} !== ${request.documentContext.version}`);
			}
			return [undefined, undefined];
		}
		if (document.version < request.documentContext.version) {
			this.telemetrySender.sendIntegrationTelemetry(request.completionId, request.documentContext.uri, `Version mismatch: ${document.version} !== ${request.documentContext.version}`);
			return [undefined, undefined];
		}
		return [document, position];
	}

	private convertItem(item: ContextItem): Copilot.SupportedContextItem | undefined {
		if (item.kind === ContextKind.Snippet) {
			const converted: Copilot.CodeSnippet = {
				importance: item.priority * 100,
				uri: item.uri.toString(),
				value: item.value
			};
			if (item.additionalUris !== undefined) {
				converted.additionalUris = item.additionalUris.map((uri) => uri.toString());
			}
			return converted;
		} else if (item.kind === ContextKind.Trait) {
			const converted: Copilot.Trait = {
				importance: item.priority * 100,
				name: item.name,
				value: item.value
			};
			return converted;
		}
		return undefined;
	}

	private async getCopilotApi(): Promise<Copilot.ContextProviderApiV1 | undefined> {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		if (copilotExtension === undefined) {
			this.telemetrySender.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.CopilotExtension, 'Copilot extension not found', undefined);
			this.logService.logger.error('Copilot extension not found');
			return undefined;
		}
		try {
			const api = await copilotExtension.activate();
			return api.getContextProviderAPI('v1');
		} catch (error) {
			if (error instanceof Error) {
				this.telemetrySender.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.CopilotExtension, error.message, error.stack);
				this.logService.logger.error('Error activating Copilot extension:', error.message);
			} else {
				this.telemetrySender.sendActivationFailedTelemetry(ErrorLocation.Client, ErrorPart.CopilotExtension, 'Unknown error', undefined);
				this.logService.logger.error('Error activating Copilot extension: Unknown error.');
			}
			return undefined;
		}
	}

	private unregister(): void {
		if (this.registrations !== undefined) {
			this.registrations.dispose();
			this.registrations = undefined;
		}
		this.telemetrySender.sendInlineCompletionProviderTelemetry(KnownSources.completion, false);
	}

	private getConfig(): 'off' | 'on' {
		const expFlag = this.configurationService.getExperimentBasedConfig(ConfigKey.TypeScriptLanguageContext, this.experimentationService);
		return expFlag === true ? 'on' : 'off';
	}

	private getTokenBudget(document: vscode.TextDocument): number {
		return Math.trunc((8 * 1024) - (document.getText().length / 4) - 256);
	}

	private getSampleTelemetry(activeExperiments: Map<string, string | number | boolean | string[]>): number {
		const value = activeExperiments.get('sampleTelemetry');
		if (value === undefined || value === null || value === false) {
			return 1;
		}
		if (value === true) {
			return 10;
		}
		if (typeof value === 'number') {
			return Math.max(1, Math.min(100, value));
		}
		return 1;
	}
}