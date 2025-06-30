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
import * as protocol from '../common/serverProtocol';

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

type ComputeContextRequestArgs = {
	file: vscode.Uri;
	line: number;
	offset: number;
	startTime: number;
	timeBudget?: number;
	tokenBudget?: number;
	neighborFiles?: readonly string[];
	knownContextItems?: readonly protocol.CachedContextItem[];
	computationStates?: readonly protocol.ComputationState[];
	$traceId?: string;
};

type SnippetStats = {
	unknown: number;
	blueprints: number;
	signatures: number;
	superClasses: number;
	generalScopes: number;
	completions: number;
	neighborFiles: number;
	items: {
		blueprints: [number, number][];
		signatures: [number, number][];
		superClasses: [number, number][];
		generalScopes: [number, number][];
		completions: [number, number][];
		neighborFiles: [number, number][];
	};
	totalSize: number;
};
namespace SnippetStats {
	export function create(): SnippetStats {
		return {
			unknown: 0, blueprints: 0, signatures: 0, superClasses: 0, generalScopes: 0, completions: 0, neighborFiles: 0,
			items: {
				blueprints: [],
				signatures: [],
				superClasses: [],
				generalScopes: [],
				completions: [],
				neighborFiles: []
			},
			totalSize: 0
		};
	}
	export function update(stats: SnippetStats, snippet: protocol.CodeSnippet): void {
		let size = 0;
		switch (snippet.snippetKind) {
			case protocol.SnippetKind.Unknown:
				stats.unknown++;
				break;
			case protocol.SnippetKind.Blueprint:
				stats.blueprints++;
				size = protocol.CodeSnippet.sizeInChars(snippet);
				stats.items.blueprints.push([snippet.priority, size]);
				break;
			case protocol.SnippetKind.Signature:
				stats.signatures++;
				size = protocol.CodeSnippet.sizeInChars(snippet);
				stats.items.signatures.push([snippet.priority, size]);
				break;
			case protocol.SnippetKind.SuperClass:
				stats.superClasses++;
				size = protocol.CodeSnippet.sizeInChars(snippet);
				stats.items.superClasses.push([snippet.priority, size]);
				break;
			case protocol.SnippetKind.GeneralScope:
				stats.generalScopes++;
				size = protocol.CodeSnippet.sizeInChars(snippet);
				stats.items.generalScopes.push([snippet.priority, size]);
				break;
			case protocol.SnippetKind.Completion:
				stats.completions++;
				size = protocol.CodeSnippet.sizeInChars(snippet);
				stats.items.completions.push([snippet.priority, size]);
				break;
			case protocol.SnippetKind.NeighborFile:
				stats.neighborFiles++;
				size = protocol.CodeSnippet.sizeInChars(snippet);
				stats.items.neighborFiles.push([snippet.priority, size]);
				break;
		}
		stats.totalSize += size;
	}
}

type TraitsStats = {
	unknown: number;
	module: number;
	moduleResolution: number;
	lib: number;
	target: number;
	version: number;
	items: {
		module: [number, number][];
		moduleResolution: [number, number][];
		lib: [number, number][];
		target: [number, number][];
		version: [number, number][];
	};
	totalSize: number;
};
namespace TraitsStats {
	export function create(): TraitsStats {
		return {
			unknown: 0, module: 0, moduleResolution: 0, lib: 0, target: 0, version: 0,
			items: {
				module: [],
				moduleResolution: [],
				lib: [],
				target: [],
				version: []
			},
			totalSize: 0
		};
	}
	export function update(stats: TraitsStats, trait: protocol.Trait) {
		let size = 0;
		switch (trait.traitKind) {
			case protocol.TraitKind.Unknown:
				stats.unknown++;
				break;
			case protocol.TraitKind.Module:
				stats.module++;
				size = protocol.Trait.sizeInChars(trait);
				stats.items.module.push([trait.priority, size]);
				break;
			case protocol.TraitKind.ModuleResolution:
				stats.moduleResolution++;
				size = protocol.Trait.sizeInChars(trait);
				stats.items.moduleResolution.push([trait.priority, size]);
				break;
			case protocol.TraitKind.Lib:
				stats.lib++;
				size = protocol.Trait.sizeInChars(trait);
				stats.items.lib.push([trait.priority, size]);
				break;
			case protocol.TraitKind.Target:
				stats.target++;
				size = protocol.Trait.sizeInChars(trait);
				stats.items.target.push([trait.priority, size]);
				break;
			case protocol.TraitKind.Version:
				stats.version++;
				size = protocol.Trait.sizeInChars(trait);
				stats.items.version.push([trait.priority, size]);
				break;
		}
		stats.totalSize += size;
	}
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

	constructor(telemetryService: ITelemetryService, logService: ILogService) {
		this.telemetryService = telemetryService;
		this.logService = logService;
	}

	public sendSpeculativeRequestTelemetry(context: RequestContext, originalRequestId: string, numberOfItems: number): void {
		/* __GDPR__
			"typescript-context-plugin.completion-context.speculative" : {
				"owner": "dirkb",
				"comment": "Telemetry for copilot inline completion context",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
				"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" },
				"originalRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The original request id for which this is a speculative request" },
				"numberOfItems": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of items in the speculative request", "isMeasurement": true }
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
				numberOfItems: numberOfItems
			}
		);
		this.logService.logger.info(`TypeScript Copilot context speculative request: [${context.requestId} - ${originalRequestId}, numberOfItems: ${numberOfItems}]`);
	}

	public sendRequestTelemetry(document: vscode.TextDocument, context: RequestContext, data: ContextItemSummary, timeTaken: number, cacheState: { before: CacheState; after: CacheState } | undefined): void {
		const meta = data.meta;
		const snippetStats = data.snippetStats;
		const traitsStats = data.traitsStats;
		const completionContext = meta?.completionContext ?? protocol.CompletionContextKind.Unknown;
		const nodePath = meta?.path ? JSON.stringify(meta.path) : JSON.stringify([0]);
		const items = Object.assign({}, snippetStats.items, traitsStats.items);
		const totalSize = snippetStats.totalSize + traitsStats.totalSize;
		const tokenBudgetExhausted = totalSize > (context.tokenBudget ?? 7 * 1024);
		const fileSize = document.getText().length;
		const cachedItemsForSpeculativeRequest = data.cachedItemsForSpeculativeRequest;
		/* __GDPR__
			"typescript-context-plugin.completion-context.ok" : {
				"owner": "dirkb",
				"comment": "Telemetry for copilot inline completion context",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
				"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the request" },
				"fileSize": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The size of the file", "isMeasurement": true },
				"completionContext": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Kind of completion context" },
				"nodePath": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The syntax kind path to the AST node the position resolved to." },
				"cancelled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request got cancelled on the client side" },
				"timedOut": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request timed out on the server side" },
				"serverTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time taken on the server side", "isMeasurement": true },
				"contextComputeTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time taken on the server side to compute the context", "isMeasurement": true },
				"timeTaken": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time taken to provide the completion", "isMeasurement": true },
				"tokenBudgetExhausted": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the token budget was exhausted" },
				"blueprints": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of blueprints", "isMeasurement": true },
				"signatures": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of signatures", "isMeasurement": true },
				"superClasses": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of super classes", "isMeasurement": true },
				"generalScopes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of general scopes", "isMeasurement": true },
				"completions": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of traditional completion scopes", "isMeasurement": true },
				"neighborFiles": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of neighbor files", "isMeasurement": true },
				"module": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of modules", "isMeasurement": true },
				"moduleResolution": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of moduleResolutions", "isMeasurement": true },
				"lib": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of libs", "isMeasurement": true },
				"target": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of targets", "isMeasurement": true },
				"version": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of versions", "isMeasurement": true },
				"totalSize": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Total size of all context items", "isMeasurement": true },
				"items": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Detailed information about each context item delivered." },
				"cacheHits": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of cache hits", "isMeasurement": true },
				"isSpeculative": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was speculative" },
				"beforeCacheState": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The cache state before the request was sent" },
				"afterCacheState": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The cache state after the request was sent" },
				"cachedItemsForSpeculativeRequest": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was cached for a speculative request", "isMeasurement": true }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'typescript-context-plugin.completion-context.ok',
			{
				requestId: context.requestId,
				source: context.source ?? KnownSources.unknown,
				completionContext: completionContext,
				nodePath: nodePath,
				cancelled: data.cancelled.toString(),
				timedOut: data.timedOut.toString(),
				tokenBudgetExhausted: tokenBudgetExhausted.toString(),
				items: JSON.stringify(items),
				isSpeculative: (context.proposedEdits !== undefined && context.proposedEdits.length > 0 ? true : false).toString(),
				beforeCacheState: cacheState?.before.toString(),
				afterCacheState: cacheState?.after.toString(),
			},
			{
				fileSize: fileSize,
				serverTime: data.serverTime,
				contextComputeTime: data.contextComputeTime,
				timeTaken,
				blueprints: snippetStats.blueprints,
				signatures: snippetStats.signatures,
				superClasses: snippetStats.superClasses,
				generalScopes: snippetStats.generalScopes,
				completions: snippetStats.completions,
				neighborFiles: snippetStats.neighborFiles,
				module: traitsStats.module,
				moduleResolution: traitsStats.moduleResolution,
				lib: traitsStats.lib,
				target: traitsStats.target,
				version: traitsStats.version,
				totalSize: totalSize,
				cacheHits: data.cacheHits,
				cachedItemsForSpeculativeRequest,
			}
		);
		this.logService.logger.info(`TypeScript Copilot context: [${context.requestId}, ${completionContext}, ${meta?.path ? JSON.stringify(meta.path, undefined, 0) : ''}, ${JSON.stringify(snippetStats, undefined, 0)}, ${JSON.stringify(traitsStats, undefined, 0)}, cacheHits:${data.cacheHits} budgetExhausted:${data.tokenBudgetExhausted}, cancelled: ${data.cancelled}, timedOut:${data.timedOut}, fileSize:${fileSize}] in [${timeTaken},${data.serverTime},${data.contextComputeTime}]ms.${data.timedOut ? ' Timed out.' : ''}`);
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

	public sendRequestOnTimeoutTelemetry(context: RequestContext, data: ContextItemSummary): void {
		const snippetStats = data.snippetStats;
		const traitsStats = data.traitsStats;
		const items = Object.assign({}, snippetStats.items, traitsStats.items);
		const totalSize = snippetStats.totalSize + traitsStats.totalSize;
		/* __GDPR__
			"typescript-context-plugin.completion-context.on-timeout" : {
				"owner": "dirkb",
				"comment": "Telemetry for copilot inline completion context on timeout",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request correlation id" },
				"items": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Detailed information about each context item delivered." },
				"blueprints": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of blueprints", "isMeasurement": true },
				"signatures": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of signatures", "isMeasurement": true },
				"superClasses": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of super classes", "isMeasurement": true },
				"generalScopes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of general scopes", "isMeasurement": true },
				"completions": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of traditional completion scopes", "isMeasurement": true },
				"neighborFiles": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of neighbor files", "isMeasurement": true },
				"module": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of modules", "isMeasurement": true },
				"moduleResolution": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of moduleResolutions", "isMeasurement": true },
				"lib": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of libs", "isMeasurement": true },
				"target": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of targets", "isMeasurement": true },
				"version": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of versions", "isMeasurement": true },
				"totalSize": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Total size of all context items", "isMeasurement": true }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'typescript-context-plugin.completion-context.on-timeout',
			{
				requestId: context.requestId,
				items: JSON.stringify(items),
			},
			{
				blueprints: snippetStats.blueprints,
				signatures: snippetStats.signatures,
				superClasses: snippetStats.superClasses,
				generalScopes: snippetStats.generalScopes,
				completions: snippetStats.completions,
				neighborFiles: snippetStats.neighborFiles,
				module: traitsStats.module,
				moduleResolution: traitsStats.moduleResolution,
				lib: traitsStats.lib,
				target: traitsStats.target,
				version: traitsStats.version,
				totalSize: totalSize,
			}
		);
		this.logService.logger.info(`TypeScript Copilot context on timeout: [${context.requestId}, ${JSON.stringify(snippetStats, undefined, 0)}, ${JSON.stringify(traitsStats, undefined, 0)}]`);
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
		this.logService.logger.info(`TypeScript Copilot context request ${context.requestId} got cancelled.`);
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
	readonly uri: string;
	readonly version: number;
	readonly languageId: string;
	readonly position: vscode.Position;
	readonly requestId: string;
};

type CachedContextItems = {
	client: readonly protocol.ContextItem[];
	clientOnTimeout: readonly protocol.ContextItem[];
	server: readonly protocol.CachedContextItem[];
};


enum CacheState {
	NotPopulated = 'NotPopulated',
	PartiallyPopulated = 'PartiallyPopulated',
	FullyPopulated = 'FullyPopulated'
}

type Keys = protocol.ContextItemKey | protocol.ComputationStateKey;
class ContextItemCache implements vscode.Disposable {

	private readonly disposables = new DisposableStore();
	private cachedItems: Map<protocol.ContextItemKey, protocol.ContextItem & protocol.CacheInfo.has>;
	private cacheState: CacheState;
	private computationStates: Map<protocol.ComputationStateKey, protocol.ComputationState>;
	private document: vscode.TextDocument | undefined;
	private version: number | undefined;
	private readonly rangeItems: [range: vscode.Range, key: Keys, Map<Keys, unknown>][];

	// Request key for a subsequent speculative request
	private requestInfo: RequestInfo | undefined;
	private itemsForSpeculativeRequest: protocol.ContextItem[] | undefined;

	constructor() {
		this.disposables.add(this);
		this.cachedItems = new Map<protocol.ContextItemKey, protocol.ContextItem & protocol.CacheInfo.has>();
		this.cacheState = CacheState.NotPopulated;
		this.computationStates = new Map<protocol.ComputationStateKey, protocol.ComputationState>();
		this.rangeItems = [];
		this.requestInfo = undefined;
		this.itemsForSpeculativeRequest = undefined;

		this.disposables.add(vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
			if (this.document === undefined || event.contentChanges.length === 0) {
				return;
			}
			if (event.document !== this.document) {
				if (this.affectsTypeScript(event)) {
					this.clear();
				}
			} else {
				for (const change of event.contentChanges) {
					const changeRange = change.range;
					for (let i = 0; i < this.rangeItems.length;) {
						const entry = this.rangeItems[i];
						if (entry[0].contains(changeRange)) {
							entry[0] = this.applyTextContentChangeEventToRange(change, entry[0]);
							i++;
							continue;
						} else {
							entry[2].delete(entry[1]);
							this.rangeItems.splice(i, 1);
						}
					}
				}
				this.version = event.document.version;
			}
		}));
		this.disposables.add(vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
			if (this.document === document) {
				this.clear();
			}
		}));
	}

	public clear(): void {
		this.document = undefined;
		this.version = undefined;
		this.rangeItems.length = 0;
		this.cachedItems.clear();
		this.cacheState = CacheState.NotPopulated;
		this.computationStates.clear();
		this.requestInfo = undefined;
		this.itemsForSpeculativeRequest = undefined;
	}

	public getCacheState(): CacheState {
		return this.cacheState;
	}

	public update(document: vscode.TextDocument, position: vscode.Position, context: RequestContext, body: protocol.ComputeContextResponse.OK): void {
		const current = this.cachedItems;
		this.document = document;
		this.version = document.version;
		this.rangeItems.length = 0;
		this.cachedItems = new Map<protocol.ContextItemKey, protocol.ContextItem & protocol.CacheInfo.has>();
		this.cacheState = CacheState.NotPopulated;
		this.computationStates.clear();
		const isSpeculativeRequest = context.proposedEdits !== undefined;
		if (isSpeculativeRequest) {
			this.requestInfo = undefined;
			this.itemsForSpeculativeRequest = undefined;
		} else {
			this.requestInfo = {
				uri: document.uri.toString(),
				version: document.version,
				languageId: document.languageId,
				position: position,
				requestId: context.requestId,
			};
			this.itemsForSpeculativeRequest = [];
		}

		const handleItem = (item: protocol.ContextItem & protocol.CacheInfo.has) => {
			const cacheInfo = item.cache;
			this.cachedItems.set(cacheInfo.key, item);
			const scope = cacheInfo.scope;
			if (scope.kind === protocol.CacheScopeKind.Range) {
				const start = scope.range.start;
				const end = scope.range.end;
				this.rangeItems.push([new vscode.Range(start.line, start.character, end.line, end.character), cacheInfo.key, this.cachedItems]);
			}
		};

		const handleComputationState = (item: protocol.ComputationState) => {
			this.computationStates.set(item.key, item);
			const scope = item.scope;
			if (scope.kind === protocol.CacheScopeKind.Range) {
				const start = scope.range.start;
				const end = scope.range.end;
				this.rangeItems.push([new vscode.Range(start.line, start.character, end.line, end.character), item.key, this.computationStates]);
			}
		};

		const handleItemForSpeculativeRequest = (item: protocol.ContextItem) => {
			if (this.itemsForSpeculativeRequest !== undefined && (item.kind === protocol.ContextKind.Snippet || item.kind === protocol.ContextKind.Trait) && item.speculativeKind === protocol.SpeculativeKind.emit) {
				this.itemsForSpeculativeRequest.push(item);
			}
		};

		for (const item of body.items) {
			if (item.kind === protocol.ContextKind.CachedItem) {
				const currentItem = current.get(item.key);
				if (currentItem !== undefined) {
					if (protocol.CacheInfo.has(currentItem)) {
						handleItem(currentItem);
					}
					handleItemForSpeculativeRequest(currentItem);
				}
				current.delete(item.key);
			} else if (item.kind === protocol.ContextKind.ComputationState) {
				handleComputationState(item);
			} else if (protocol.CacheInfo.has(item)) {
				handleItem(item);
				handleItemForSpeculativeRequest(item);
			} else {
				handleItemForSpeculativeRequest(item);
			}
		}
		if (body.timedOut === false) {
			this.cacheState = CacheState.FullyPopulated;
		} else if (body.timedOut === true) {
			this.cacheState = CacheState.PartiallyPopulated;
		} else {
			this.cacheState = CacheState.NotPopulated;
		}
	}

	public cachedItemsForSpeculativeRequest(): number {
		return this.itemsForSpeculativeRequest?.length ?? -1;
	}

	public getItemsForSpeculativeRequest(document: vscode.TextDocument, position: vscode.Position): [protocol.ContextItem[] | undefined, string | undefined] {
		try {
			if (this.requestInfo === undefined || this.itemsForSpeculativeRequest === undefined) {
				return [undefined, undefined];
			}
			if (this.requestInfo.uri !== document.uri.toString() || this.requestInfo.version !== document.version || this.requestInfo.languageId !== document.languageId || !this.requestInfo.position.isEqual(position)) {
				return [undefined, undefined];
			}
			return [this.itemsForSpeculativeRequest, this.requestInfo.requestId];
		} finally {
			// Clear the speculative request state
			this.requestInfo = undefined;
			this.itemsForSpeculativeRequest = undefined;
		}
	}

	public getContextItem(key: protocol.ContextItemKey): (protocol.ContextItem & protocol.CacheInfo.has) | undefined {
		return this.cachedItems.get(key);
	}

	public getCachedContextItems(document: vscode.TextDocument, position: vscode.Position): CachedContextItems | undefined {
		if (this.document !== document) {
			return undefined;
		}
		if (this.version !== document.version) {
			this.clear();
			return undefined;
		}
		const client: protocol.ContextItem[] = [];
		const clientOnTimeout: protocol.ContextItem[] = [];
		const server: protocol.CachedContextItem[] = [];
		const handleItem = (key: string, item: protocol.ContextItem & protocol.CacheInfo.has) => {
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
			const isClientBased = item.cache.emitMode === protocol.EmitMode.ClientBased;
			const isClientBasedOnTimeout = item.cache.emitMode === protocol.EmitMode.ClientBasedOnTimeout;
			if (isClientBased || isClientBasedOnTimeout) {
				const cacheInfo = item.cache;
				if (cacheInfo.scope.kind === protocol.CacheScopeKind.File) {
					isClientBased ? client.push(item) : isClientBasedOnTimeout ? clientOnTimeout.push(item) : undefined;
				} else if (cacheInfo.scope.kind === protocol.CacheScopeKind.Range) {
					const range = new vscode.Range(cacheInfo.scope.range.start.line, cacheInfo.scope.range.start.character, cacheInfo.scope.range.end.line, cacheInfo.scope.range.end.character);
					if (range.contains(position)) {
						isClientBased ? client.push(item) : isClientBasedOnTimeout ? clientOnTimeout.push(item) : undefined;
					}
				}
			}
			server.push(protocol.CachedContextItem.create(key, item.cache.emitMode, size));
		};
		for (const [key, item] of this.cachedItems.entries()) {
			handleItem(key, item);
		}
		return { client, clientOnTimeout, server };
	}

	public getComputationStates(document: vscode.TextDocument): readonly protocol.ComputationState[] {
		if (this.document !== document) {
			return [];
		}
		if (this.version !== document.version) {
			this.clear();
			return [];
		}
		return Array.from(this.computationStates.values());
	}

	public dispose(): void {
		this.clear();
		this.disposables.dispose();
	}

	private affectsTypeScript(event: vscode.TextDocumentChangeEvent): boolean {
		const languageId = event.document.languageId;
		return languageId === 'typescript' || languageId === 'typescriptreact' || languageId === 'javascript' || languageId === 'javascriptreact' || languageId === 'json';
	}

	private applyTextContentChangeEventToRange(event: vscode.TextDocumentContentChangeEvent, range: vscode.Range): vscode.Range {
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
}

interface ContextItemSummary {
	meta: protocol.MetaData | undefined;
	errorData: protocol.ErrorData[] | undefined;
	snippetStats: SnippetStats;
	traitsStats: TraitsStats;
	cancelled: boolean;
	timedOut: boolean;
	tokenBudgetExhausted: boolean;
	cacheHits: number;
	serverTime: number;
	contextComputeTime: number;
	cachedItemsForSpeculativeRequest: number;
}
export namespace ContextItemSummary {
	export const DefaultExhausted: ContextItemSummary = Object.freeze<ContextItemSummary>({
		meta: { kind: protocol.ContextKind.MetaData, path: [0], completionContext: protocol.CompletionContextKind.Unknown },
		errorData: undefined,
		snippetStats: SnippetStats.create(),
		traitsStats: TraitsStats.create(),
		cancelled: false,
		timedOut: false,
		tokenBudgetExhausted: true,
		cacheHits: 0,
		serverTime: -1,
		contextComputeTime: -1,
		cachedItemsForSpeculativeRequest: -1
	});
}

class ContextItems implements ContextItemSummary {

	private readonly itemManager: ContextItemCache;
	private readonly logService: ILogService;

	public meta: protocol.MetaData | undefined;
	public errorData: protocol.ErrorData[] | undefined;
	public snippetStats: SnippetStats;
	public traitsStats: TraitsStats;
	public cancelled: boolean;
	public timedOut: boolean;
	public tokenBudgetExhausted: boolean;
	public cacheHits: number;
	public serverTime: number;
	public contextComputeTime: number;

	constructor(itemManager: ContextItemCache, logService: ILogService) {
		this.itemManager = itemManager;
		this.logService = logService;
		this.meta = { kind: protocol.ContextKind.MetaData, path: [0], completionContext: protocol.CompletionContextKind.Unknown };
		this.errorData = undefined;
		this.snippetStats = SnippetStats.create();
		this.traitsStats = TraitsStats.create();
		this.cancelled = false;
		this.timedOut = false;
		this.tokenBudgetExhausted = false;
		this.cacheHits = 0;
		this.serverTime = -1;
		this.contextComputeTime = -1;
	}

	public get cachedItemsForSpeculativeRequest(): number {
		return this.itemManager.cachedItemsForSpeculativeRequest();
	}

	public update(item: protocol.ContextItem, fromClientCache: boolean): ContextItem | undefined {
		if (fromClientCache) {
			this.cacheHits++;
		} else if (item.kind === protocol.ContextKind.CachedItem) {
			const cached = this.itemManager.getContextItem(item.key);
			if (cached !== undefined) {
				// The item got already emitted via the client.
				if (cached.cache.emitMode === protocol.EmitMode.ClientBased) {
					return undefined;
				}
				this.cacheHits++;
				item = cached;
			} else {
				this.logService.logger.warn(`Cached item not found in cache: ${item.key}`);
				return undefined;
			}
		}
		return this.convert(item);
	}

	public convert(item: protocol.ContextItem): ContextItem | undefined {
		switch (item.kind) {
			case protocol.ContextKind.Snippet:
				SnippetStats.update(this.snippetStats, item);
				return {
					kind: ContextKind.Snippet,
					priority: item.priority,
					uri: vscode.Uri.file(item.uri),
					additionalUris: item.additionalUris?.map(uri => vscode.Uri.file(uri)),
					value: item.value
				};
			case protocol.ContextKind.Trait:
				TraitsStats.update(this.traitsStats, item);
				return {
					kind: ContextKind.Trait,
					priority: item.priority,
					name: item.name,
					value: item.value
				};
			case protocol.ContextKind.MetaData:
				this.meta = item;
				break;
			case protocol.ContextKind.ErrorData:
				if (this.errorData === undefined) {
					this.errorData = [];
				}
				this.errorData.push(item);
				break;
			case protocol.ContextKind.Timings:
				this.serverTime = item.totalTime;
				this.contextComputeTime = item.computeTime;
				break;
		}
		return undefined;
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

export class LanguageContextServiceImpl implements ILanguageContextService, vscode.Disposable {

	readonly _serviceBrand: undefined;

	private static readonly ExecConfig: ExecConfig = { executionTarget: ExecutionTarget.Semantic };

	private readonly isDebugging: boolean;
	private _isActivated: Promise<boolean> | undefined;
	private telemetrySender: TelemetrySender;

	private readonly itemManager: ContextItemCache;
	private readonly neighborFileModel: NeighborFileModel;

	private inflightCancellationToken: DelayedCancellationToken | undefined;
	private onTimeOut: { requestId: string; items: readonly protocol.ContextItem[] | undefined } | undefined;
	private readonly cachePopulationTimeout: number;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ITelemetryService readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService
	) {
		this.isDebugging = process.execArgv.some((arg) => /^--(?:inspect|debug)(?:-brk)?(?:=\d+)?$/i.test(arg));
		this.telemetrySender = new TelemetrySender(telemetryService, logService);
		this.itemManager = new ContextItemCache();
		this.neighborFileModel = new NeighborFileModel();
		this.inflightCancellationToken = undefined;
		this.onTimeOut = undefined;
		this.cachePopulationTimeout = this.getCachePopulationTimeout();
	}

	public dispose(): void {
		this.itemManager.dispose();
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

	async *getContext(document: vscode.TextDocument, position: vscode.Position, context: RequestContext, token: vscode.CancellationToken): AsyncIterable<ContextItem> {
		if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact') {
			return;
		}
		const isDebugging = this.isDebugging;
		const forDebugging: ContextItem[] | undefined = isDebugging ? [] : undefined;
		const startTime = Date.now();
		const isSpeculativeRequest = context.proposedEdits !== undefined;
		const contextItems = new ContextItems(this.itemManager, this.logService);
		if (isSpeculativeRequest) {
			const [items, originalRequestId] = this.itemManager.getItemsForSpeculativeRequest(document, position);
			if (items !== undefined) {
				for (const item of items) {
					const converted = contextItems.convert(item);
					if (converted !== undefined) {
						forDebugging?.push(converted);
						yield converted;
					}
				}
				this.telemetrySender.sendSpeculativeRequestTelemetry(context, originalRequestId ?? 'unknown', items.length);
				return;
			}
		}
		const neighborFiles: string[] = this.neighborFileModel.getNeighborFiles(document);
		const timeBudget = context.timeBudget ?? 150;
		const cachedItems = this.itemManager.getCachedContextItems(document, position);
		if (cachedItems !== undefined) {
			for (const item of cachedItems.client) {
				const converted = contextItems.update(item, true);
				if (converted !== undefined) {
					forDebugging?.push(converted);
					yield converted;
				}
			}
		}
		this.onTimeOut = { requestId: context.requestId, items: cachedItems?.clientOnTimeout };

		const args: ComputeContextRequestArgs = {
			file: document.uri,
			line: position.line + 1,
			offset: position.character + 1,
			startTime: startTime,
			timeBudget: Math.max(0, timeBudget - 5), // Leave some time for returning the result form the server.
			tokenBudget: context.tokenBudget ?? 7 * 1024,
			neighborFiles: neighborFiles.length > 0 ? neighborFiles : undefined,
			knownContextItems: cachedItems?.server,
			computationStates: this.itemManager.getComputationStates(document),
			$traceId: context.requestId
		};
		try {
			if (this.inflightCancellationToken !== undefined) {
				this.inflightCancellationToken.flushOutstandingCancellation();
			}
			const cacheState = this.itemManager.getCacheState();
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
			if (protocol.ComputeContextResponse.isCancelled(response)) {
				this.telemetrySender.sendRequestCancelledTelemetry(context);
				return;
			} else if (protocol.ComputeContextResponse.isOk(response)) {
				const body: protocol.ComputeContextResponse.OK = response.body;
				if (documentVersion === document.version) {
					this.itemManager.update(document, position, context, body);
				}
				for (const item of body.items) {
					const converted = contextItems.update(item, false);
					if (converted !== undefined) {
						forDebugging?.push(converted);
						yield converted;
					}
				}
				contextItems.timedOut = body.timedOut;
				contextItems.tokenBudgetExhausted = body.tokenBudgetExhausted;
				contextItems.cancelled = token.isCancellationRequested;
				this.telemetrySender.sendRequestTelemetry(document, context, contextItems, timeTaken, { before: cacheState, after: this.itemManager.getCacheState() });
				isDebugging && forDebugging?.length;
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
		if (this.onTimeOut === undefined || this.onTimeOut.requestId !== context.requestId || this.onTimeOut.items === undefined) {
			return;
		}
		const result: ContextItem[] = [];
		const contextItems = new ContextItems(this.itemManager, this.logService);
		for (const item of this.onTimeOut.items) {
			const converted = contextItems.update(item, false);
			if (converted !== undefined) {
				result.push(converted);
			}
		}
		this.telemetrySender.sendRequestOnTimeoutTelemetry(context, contextItems);
		return result;
	}

	private getCachePopulationTimeout(): number {
		const result = this.configurationService.getExperimentBasedConfig(ConfigKey.TypeScriptLanguageContextCacheTimeout, this.experimentationService);
		return result ?? 500;
	}
}

export class InlineCompletionContribution implements vscode.Disposable {

	private eventDisposable: vscode.Disposable | undefined;
	private sidecarDisposable: vscode.Disposable | undefined;
	private copilotDisposable: vscode.Disposable | undefined;
	private readonly registrationQueue: Queue<void>;

	private readonly telemetrySender: TelemetrySender;
	private static SideCarContext: RequestContext = { requestId: 'c62f0744-e778-4a92-bc4d-6449bcf2adb9', source: KnownSources.sideCar };

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ILogService readonly logService: ILogService,
		@ITelemetryService readonly telemetryService: ITelemetryService,
		@ILanguageContextService private readonly languageContextService: ILanguageContextService
	) {
		this.eventDisposable = undefined;
		this.sidecarDisposable = undefined;
		this.copilotDisposable = undefined;
		this.telemetrySender = new TelemetrySender(telemetryService, logService);
		this.registrationQueue = new Queue<void>();
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
		this.registrationQueue.dispose();
		if (this.sidecarDisposable !== undefined) {
			this.sidecarDisposable.dispose();
			this.sidecarDisposable = undefined;
		}
		if (this.copilotDisposable !== undefined) {
			this.copilotDisposable.dispose();
			this.copilotDisposable = undefined;
		}
		if (this.eventDisposable !== undefined) {
			this.eventDisposable.dispose();
			this.eventDisposable = undefined;
		}
	}

	private typeScriptFileOpen(): void {
		this.checkRegistration();
		this.eventDisposable = this.configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(ConfigKey.TypeScriptContextProvider.fullyQualifiedId) || e.affectsConfiguration(ConfigKey.TypeScriptLanguageContext.fullyQualifiedId)) {
				this.checkRegistration();
			}
		});
	}

	private checkRegistration(): void {
		this.registrationQueue.queue(async () => {
			const value = this.getConfig();
			if (value === 'sidecar' || value === 'on') {
				await this.register(value);
			} else {
				this.unregister();
			}
		}).catch((error: any) => this.logService.logger.error('Error checking TypeScript context provider registration:', error));
	}

	private async register(value: 'sidecar' | 'on'): Promise<void> {
		if (value === 'sidecar' && this.sidecarDisposable !== undefined) {
			if (this.copilotDisposable !== undefined) {
				this.copilotDisposable.dispose();
				this.copilotDisposable = undefined;
			}
			return;
		}
		if (value === 'on' && this.copilotDisposable !== undefined) {
			if (this.sidecarDisposable !== undefined) {
				this.sidecarDisposable.dispose();
				this.sidecarDisposable = undefined;
			}
			return;
		}

		if (! await this.isTypeScriptRunning()) {
			return;
		}

		const languageContextService = this.languageContextService;
		const logService = this.logService;
		try {
			if (! await languageContextService.isActivated('typescript')) {
				return;
			}
			if (value === 'sidecar') {
				const self = this;
				this.sidecarDisposable = vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file', language: 'typescript' }, {
					provideInlineCompletionItems(document, position, context, token) {
						self.getContextAsArray(document, position, context, token).catch((error) => logService.logger.error('Error computing context:', error));
						return [];
					}
				});
				this.telemetrySender.sendInlineCompletionProviderTelemetry(KnownSources.sideCar, true);
			} else if (value === 'on') {
				// vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file', language: 'typescript' }, {
				// 	debounceDelayMs: 0,
				// 	provideInlineCompletionItems(document, position, context, token) {
				// 		console.log(`Inline completions requested for ${document.uri.toString()} at position ${position.line}:${position.character}. Time: ${Date.now()}`);
				// 		return undefined;
				// 	}
				// }, { debounceDelayMs: 0 });
				// vscode.languages.registerInlayHintsProvider({ scheme: 'file', language: 'typescript' }, {
				// 	provideInlayHints(document, range, token) {
				// 		console.log(`Inlay hints requested for ${document.uri.toString()} in range ${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}. Time: ${Date.now()}`);
				// 		return undefined;
				// 	}
				// });
				// vscode.workspace.onDidChangeTextDocument((event) => {
				// 	console.log(`Text document changed: ${event.document.uri.toString()}. Time: ${Date.now()}`);
				// });
				// vscode.window.onDidChangeTextEditorSelection((event) => {
				// 	const range = event.selections[0];
				// 	console.log(`Text editor selection changed: ${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}. Time: ${Date.now()}`);
				// });
				const copilotAPI = await this.getCopilotApi();
				if (copilotAPI !== undefined) {
					const telemetrySender = this.telemetrySender;
					const resolver: Copilot.ContextResolver<Copilot.SupportedContextItem> = {
						async *resolve(request: Copilot.ResolveRequest, token: vscode.CancellationToken): AsyncIterable<Copilot.SupportedContextItem> {
							const isSpeculativeRequest = request.documentContext.proposedEdits !== undefined;
							let document: vscode.TextDocument | undefined;
							if (vscode.window.activeTextEditor?.document.uri.toString() === request.documentContext.uri) {
								document = vscode.window.activeTextEditor.document;
							} else {
								document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === request.documentContext.uri);
							}
							if (document === undefined) {
								telemetrySender.sendIntegrationTelemetry(request.completionId, request.documentContext.uri);
								return;
							}
							const requestPos = request.documentContext.position;
							const position = requestPos !== undefined ? new vscode.Position(requestPos.line, requestPos.character) : document.positionAt(request.documentContext.offset);
							if (document.version > request.documentContext.version) {
								if (!token.isCancellationRequested) {
									telemetrySender.sendIntegrationTelemetry(request.completionId, request.documentContext.uri, `Version mismatch: ${document.version} !== ${request.documentContext.version}`);
								}
								return;
							}
							if (document.version < request.documentContext.version) {
								telemetrySender.sendIntegrationTelemetry(request.completionId, request.documentContext.uri, `Version mismatch: ${document.version} !== ${request.documentContext.version}`);
								return;
							}
							const tokenBudget = Math.trunc((8 * 1024) - (document.getText().length / 4) - 256);
							if (tokenBudget <= 0) {
								telemetrySender.sendRequestTelemetry(document, { requestId: request.completionId, source: KnownSources.completion }, ContextItemSummary.DefaultExhausted, 0, undefined);
								return [];
							}
							const context: RequestContext = {
								requestId: request.completionId,
								timeBudget: request.timeBudget,
								tokenBudget: tokenBudget,
								source: KnownSources.completion,
								proposedEdits: isSpeculativeRequest ? [] : undefined
							};
							const items = languageContextService.getContext(document, position, context, token);
							for await (const item of items) {
								if (item.kind === ContextKind.Snippet) {
									const converted: Copilot.CodeSnippet = {
										importance: item.priority * 100,
										uri: item.uri.toString(),
										value: item.value
									};
									if (item.additionalUris !== undefined) {
										converted.additionalUris = item.additionalUris.map((uri) => uri.toString());
									}
									yield converted;
								} else if (item.kind === ContextKind.Trait) {
									const converted: Copilot.Trait = {
										importance: item.priority * 100,
										name: item.name,
										value: item.value
									};
									yield converted;
								}
							}
						}
					};
					if (typeof languageContextService.getContextOnTimeout === 'function') {
						resolver.resolveOnTimeout = (request) => {
							if (typeof languageContextService.getContextOnTimeout !== 'function') {
								return;
							}
							let document: vscode.TextDocument | undefined;
							if (vscode.window.activeTextEditor?.document.uri.toString() === request.documentContext.uri) {
								document = vscode.window.activeTextEditor.document;
							} else {
								document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === request.documentContext.uri);
							}
							if (document === undefined) {
								telemetrySender.sendIntegrationTelemetry(request.completionId, request.documentContext.uri);
								return;
							}
							const requestPos = request.documentContext.position;
							const position = requestPos !== undefined ? new vscode.Position(requestPos.line, requestPos.character) : document.positionAt(request.documentContext.offset);
							if (document.version > request.documentContext.version) {
								return;
							}
							if (document.version < request.documentContext.version) {
								telemetrySender.sendIntegrationTelemetry(request.completionId, request.documentContext.uri, `Version mismatch: ${document.version} !== ${request.documentContext.version}`);
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
								if (item.kind === ContextKind.Snippet) {
									const converted: Copilot.CodeSnippet = {
										importance: item.priority * 100,
										uri: item.uri.toString(),
										value: item.value
									};
									if (item.additionalUris !== undefined) {
										converted.additionalUris = item.additionalUris.map((uri) => uri.toString());
									}
									result.push(converted);
								} else if (item.kind === ContextKind.Trait) {
									const converted: Copilot.Trait = {
										importance: item.priority * 100,
										name: item.name,
										value: item.value
									};
									result.push(converted);
								}
							}
							return result;
						};
					}
					this.copilotDisposable = copilotAPI.registerContextProvider({
						id: 'typescript-ai-context-provider',
						selector: { scheme: 'file', language: 'typescript' },
						resolver: resolver
					});
					this.telemetrySender.sendInlineCompletionProviderTelemetry(KnownSources.completion, true);
					logService.logger.info('Registered TypeScript context provider with Copilot inline completions.');
				} else {
					logService.logger.warn('Copilot API is undefined, unable to register context provider.');
				}

			}
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
		if (this.sidecarDisposable !== undefined) {
			this.sidecarDisposable.dispose();
			this.sidecarDisposable = undefined;
			this.telemetrySender.sendInlineCompletionProviderTelemetry(KnownSources.sideCar, false);
		}
		if (this.copilotDisposable !== undefined) {
			this.copilotDisposable.dispose();
			this.copilotDisposable = undefined;
			this.telemetrySender.sendInlineCompletionProviderTelemetry(KnownSources.completion, false);
		}
	}

	private async getContextAsArray(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<ContextItem[]> {
		const result: ContextItem[] = [];
		try {
			for await (const item of this.languageContextService.getContext(document, position, InlineCompletionContribution.SideCarContext, token)) {
				result.push(item);
			}
		} catch (error) {
			this.logService.logger.error('Error computing context:', error);
		}
		return result;
	}

	private getConfig(): 'off' | 'sidecar' | 'on' {
		const expFlag = this.configurationService.getExperimentBasedConfig(ConfigKey.TypeScriptLanguageContext, this.experimentationService);
		if (expFlag === true) {
			return 'on';
		}

		let value = this.configurationService.getConfig(ConfigKey.TypeScriptContextProvider);
		if (value === '') {
			value = this.configurationService.getDefaultValue(ConfigKey.TypeScriptContextProvider);
		}
		if (value === 'off' || value === 'sidecar' || value === 'on') {
			return value;
		}
		return 'off';
	}
}