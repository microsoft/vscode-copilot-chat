/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canIngestDocument, canIngestPathAndSize, createCodedSymbols, DocumentContents, GeoFilter, IngestFilter, setupPanicHooks } from '@github/blackbird-external-ingest-utils';
import * as l10n from '@vscode/l10n';
import crypto from 'crypto';
import { CancellationToken } from 'vscode-languageserver-protocol';
import { Result } from '../../../../util/common/result';
import { CallTracker } from '../../../../util/common/telemetryCorrelationId';
import { raceCancellationError } from '../../../../util/vs/base/common/async';
import { encodeBase64, VSBuffer } from '../../../../util/vs/base/common/buffer';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { FileChunkAndScore } from '../../../chunking/common/chunk';
import { EmbeddingType } from '../../../embeddings/common/embeddingsComputer';
import { ILogService } from '../../../log/common/logService';
import { CodeSearchResult } from '../../../remoteCodeSearch/common/remoteCodeSearch';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { ApiClient, githubHeaders } from './externalIngestApi';


export interface ExternalIngestFile {
	readonly uri: URI;
	readonly relativePath: string;
	readonly docSha: Uint8Array;

	read(): Promise<Uint8Array>;
}

/**
 * Interface for the external ingest client that handles indexing and searching files.
 */
export interface IExternalIngestClient {
	updateIndex(
		filesetName: string,
		currentCheckpoint: string | undefined,
		allFiles: AsyncIterable<ExternalIngestFile>,
		callTracker: CallTracker,
		token: CancellationToken,
		onProgress?: (message: string) => void
	): Promise<Result<{ checkpoint: string }, Error>>;

	listFilesets(callTracker: CallTracker, token: CancellationToken): Promise<string[]>;
	deleteFileset(filesetName: string, callTracker: CallTracker, token: CancellationToken): Promise<void>;

	searchFilesets(filesetName: string, rootUri: URI, prompt: string, limit: number, callTracker: CallTracker, token: CancellationToken): Promise<CodeSearchResult>;

	/**
	 * Quickly checks if a file can be ingested based on its path and size.
	 */
	canIngestPathAndSize(filePath: string, size: number): boolean;

	/**
	 * Checks if a file can be ingested based on its path and file contents.
	 */
	canIngestDocument(filePath: string, data: Uint8Array): boolean;
}

// Create a shared API client with throttling (target quota usage of 80)
// You can change this to `null` to ignore the throttle

export class ExternalIngestClient extends Disposable implements IExternalIngestClient {
	private static readonly PROMISE_POOL_SIZE = 64;
	private static baseUrl = 'https://api.github.com';

	private readonly _ingestFilter = new IngestFilter();
	private apiClient: ApiClient;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();

		this.apiClient = this._register(instantiationService.createInstance(ApiClient, 80));

		setupPanicHooks();
	}

	public async getAuthToken(): Promise<string | undefined> {
		return (await this.authenticationService.getGitHubSession('permissive', { silent: true }))?.accessToken
			?? (await this.authenticationService.getGitHubSession('any', { silent: true }))?.accessToken;
	}

	public canIngestPathAndSize(filePath: string, size: number): boolean {
		return canIngestPathAndSize(this._ingestFilter, filePath, size);
	}

	public canIngestDocument(filePath: string, data: Uint8Array): boolean {
		return canIngestDocument(this._ingestFilter, filePath, new DocumentContents(data));
	}

	private getHeaders(authToken: string): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		headers['Authorization'] = `Bearer ${authToken}`;

		return headers;
	}

	private async post(authToken: string, path: string, body: unknown, options: { retries?: number }, callTracker: CallTracker, token: CancellationToken): Promise<Response> {
		const retries = options.retries ?? 0;
		const url = `${ExternalIngestClient.baseUrl}${path}`;
		const response = await this.apiClient.makeRequest(url, this.getHeaders(authToken), 'POST', body, callTracker, token);

		// Retry on 500 errors as these are often transient
		const shouldRetry = response.status.toString().startsWith('5') && retries > 0;

		/* __GDPR__
			"externalIngestClient.post.error" : {
				"owner": "copilot-core",
				"comment": "Logging when a external ingest POST request fails",
				"path": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The API path that was called" },
				"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The response status code" },
				"willRetry": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the request will be retried" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('externalIngestClient.post.error', { path }, { statusCode: response.status, willRetry: shouldRetry ? 1 : 0 });

		if (shouldRetry) {
			this.logService.warn(`ExternalIngestClient::post(${path}): Got ${response.status}, retrying... (${retries} retries remaining)`);
			return this.post(authToken, path, body, { retries: retries - 1 }, callTracker, token);
		}

		if (!response.ok) {
			this.logService.warn(`ExternalIngestClient::post(${path}): Got ${response.status}, request failed`);
			throw new Error(`POST to ${url} failed with status ${response.status}`);
		}

		return response;
	}

	async updateIndex(filesetName: string, currentCheckpoint: string | undefined, allFiles: AsyncIterable<ExternalIngestFile>, inCallTracker: CallTracker, token: CancellationToken, onProgress?: (message: string) => void): Promise<Result<{ checkpoint: string }, Error>> {
		const callTracker = inCallTracker.add('ExternalIngestClient::updateIndex'); callTracker.add('ExternalIngestClient::updateIndex');
		const authToken = await raceCancellationError(this.getAuthToken(), token);
		if (!authToken) {
			this.logService.warn('ExternalIngestClient::updateIndex(): No auth token available');
			return Result.error(new Error('No auth token available'));
		}

		// Initial setup
		const mappings = new Map</* sha */ string, ExternalIngestFile>();
		const geoFilter = new GeoFilter();

		this.logService.info(`ExternalIngestClient::updateIndex(). Creating ingest for fileset: ${filesetName}`);

		onProgress?.(l10n.t('Scanning files...'));
		this.logService.trace(`ExternalIngestClient::updateIndex(). Checking for ingestable files...`);
		const ingestableCheckStart = performance.now();

		const allDocShas: Uint8Array[] = [];
		for await (const file of allFiles) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			geoFilter.push(file.docSha);
			allDocShas.push(file.docSha);

			const docShaBase64 = Buffer.from(file.docSha).toString('base64');
			mappings.set(docShaBase64, file);
		}

		this.logService.debug(`ExternalIngestClient::updateIndex(). Found ${mappings.size} ingestable files in ${Math.round(performance.now() - ingestableCheckStart)}ms`,);

		// Coded symbols used during finalization of the fileset.
		// TODO: this range should be the entire fileset, right?
		const codedSymbols = createCodedSymbols(allDocShas, 0, 1).map((cs) => Buffer.from(cs).toString('base64'));

		// A hash of all docsha hashes. This emulates a differing git commit.
		const checkpointHash = crypto.createHash('sha1');
		for (const docSha of allDocShas) {
			checkpointHash.update(docSha);

		}
		const newCheckpoint = checkpointHash.digest().toString('base64');

		if (newCheckpoint === currentCheckpoint) {
			this.logService.info('ExternalIngestClient::updateIndex(): Checkpoint matches current checkpoint, skipping ingest.');
			return Result.ok({ checkpoint: newCheckpoint });
		}

		onProgress?.(l10n.t('Creating snapshot...'));

		// Create snapshot - this endpoint could return 429 if you already have too many filesets
		const createIngest = async (): Promise<Response> => {
			return this.post(authToken, '/external/code/ingest', {
				fileset_name: filesetName,
				new_checkpoint: newCheckpoint,
				geo_filter: Buffer.from(geoFilter.toBytes()).toString('base64'),
				coded_symbols: codedSymbols,
			}, {}, callTracker, token);
		};

		let createIngestResponse: Response;
		try {
			createIngestResponse = await createIngest();
		} catch (err) {
			throw new Error('Exception during create ingest', err);
		}

		// Handle 429 by cleaning up old filesets and retrying
		if (createIngestResponse.status === 429) {
			this.logService.info('ExternalIngestClient::updateIndex(): Got 429, cleaning up old filesets...');
			onProgress?.(l10n.t("Too many filesets, cleaning up old ones..."));

			await raceCancellationError(this.cleanupOldFilesets(authToken, filesetName, callTracker, token), token);

			// Retry the create ingest
			this.logService.info('ExternalIngestClient::updateIndex(): Retrying create ingest after cleanup...');
			onProgress?.(l10n.t("Retrying snapshot creation..."));
			try {
				createIngestResponse = await createIngest();
			} catch (err) {
				throw new Error('Exception during create ingest retry', err);
			}

			// If we still get 429 after cleanup and retry, fail with a clear error
			if (createIngestResponse.status === 429) {
				throw new Error('Create ingest failed with 429 even after cleanup.');
			}
		}
		// Handle 409 (conflict) by retrying once
		else if (createIngestResponse.status === 409) {
			createIngestResponse = await createIngest();
		}

		// Fail fast on non-OK responses before attempting to parse JSON
		if (!createIngestResponse.ok) {
			throw new Error(`Create ingest failed with status ${createIngestResponse.status}`);
		}
		interface CodedSymbolRange {
			readonly start: number;
			readonly end: number;
		}

		const res = await raceCancellationError(createIngestResponse.json(), token) as { ingest_id: string; coded_symbol_range: CodedSymbolRange };
		const ingestId = res.ingest_id;
		let codedSymbolRange: CodedSymbolRange | undefined = res.coded_symbol_range;

		if (
			ingestId === '' &&
			codedSymbolRange.start === 0 &&
			codedSymbolRange.end === 0
		) {
			this.logService.info('ExternalIngestClient::updateIndex(): Ingest has already run successfully');
			return Result.ok({ checkpoint: newCheckpoint });
		}
		this.logService.debug(`ExternalIngestClient::updateIndex(): Got ingest ID: ${ingestId}`);

		onProgress?.(l10n.t('Reconciling with server...'));
		this.logService.debug('ExternalIngestClient::updateIndex(): Starting set reconciliation...');

		// Create snapshot
		while (codedSymbolRange) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			this.logService.debug(`ExternalIngestClient::updateIndex(): Creating coded symbols for ${codedSymbolRange.start} to ${codedSymbolRange.end}`);
			const codedSymbols = createCodedSymbols(
				allDocShas,
				codedSymbolRange.start,
				codedSymbolRange.end,
			).map((cs) => Buffer.from(cs).toString('base64'));
			let pushCodedSymbolsResponse: Response | undefined;
			try {
				pushCodedSymbolsResponse = await this.post(
					authToken,
					'/external/code/ingest/coded_symbols',
					{
						ingest_id: ingestId,
						coded_symbols: codedSymbols,
						coded_symbol_range: codedSymbolRange,
					},
					{},
					callTracker,
					token
				);
				const body = await raceCancellationError(pushCodedSymbolsResponse.json(), token) as { next_coded_symbol_range?: CodedSymbolRange };
				codedSymbolRange = body.next_coded_symbol_range;
			} catch (e) {
				this.logService.error(`ExternalIngestClient::updateIndex(): Failed to push coded symbols: ${pushCodedSymbolsResponse?.statusText} - ${await pushCodedSymbolsResponse?.text()}`);
				throw new Error('Exception during push coded symbols');
			}
		}

		// Document upload
		onProgress?.(l10n.t('Uploading documents...'));
		this.logService.debug('ExternalIngestClient::updateIndex(): Starting document upload...');

		let pageToken = undefined;
		const seenDocShas = new Set<string>();

		const uploading = new Set<Promise<void>>();

		// Tracking for performance reporting.
		let uploaded = 0;
		const uploadStart = performance.now();

		do {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			try {
				await raceCancellationError(Promise.all(uploading), token);
			} catch (e) {
				this.logService.error('ExternalIngestClient::updateIndex(): Error uploading document:', e);
			}

			this.logService.debug(`ExternalIngestClient::updateIndex(): /batch started with pageToken: ${pageToken}`);

			const getBatchResponse = await this.post(authToken, '/external/code/ingest/batch', {
				ingest_id: ingestId,
				page_token: pageToken,
			}, {}, callTracker, token);

			const { doc_ids: docIds, next_page_token: nextPageToken } =
				await raceCancellationError(getBatchResponse.json(), token) as { doc_ids: string[] | undefined; next_page_token: string | undefined };

			this.logService.debug(`ExternalIngestClient::updateIndex(): /batch returned ${docIds?.length ?? 0} doc IDs for upload. Next page token: ${nextPageToken}`);

			// Need to check that there are some docIds to process. It can be the case where you get a page
			// token to continue pulling batches, but the batch is empty. Just keep pulling until we have
			// no next_page_token.
			if (docIds) {
				const newSet = new Set(docIds);
				const toUpload = new Set([...newSet].filter(x => !seenDocShas.has(x)));
				this.logService.debug(`ExternalIngestClient::updateIndex(): /batch seeing ${toUpload.size} new documents.`);
				if (toUpload.size === 0) {
					break;
				}

				for (const requestedDocSha of toUpload) {
					if (token.isCancellationRequested) {
						throw new CancellationError();
					}

					seenDocShas.add(requestedDocSha);
					const p = (async () => {
						try {
							const fileEntry = mappings.get(requestedDocSha);
							if (!fileEntry) {
								throw new Error(`No mapping for docSha: ${requestedDocSha}`);
							}
							this.logService.debug(`ExternalIngestClient::updateIndex(): Uploading file: ${fileEntry.relativePath}`);
							const bytes = await fileEntry.read();
							const content = encodeBase64(VSBuffer.wrap(bytes));
							const res = await this.post(authToken, '/external/code/ingest/document', {
								ingest_id: ingestId,
								content,
								file_path: fileEntry.relativePath,
								doc_id: requestedDocSha,
							}, { retries: 3 }, callTracker, token);
							if (!res.ok) {
								const requestId = res.headers.get(githubHeaders.requestId);
								const responseBody = await res.text();
								this.logService.error(`ExternalIngestClient::updateIndex(): Document upload for ${fileEntry.relativePath} failed with status: '${res.status}', requestId: '${requestId}', body: ${responseBody}`);
							}
						} catch (e) {
							this.logService.error('ExternalIngestClient::updateIndex(): Error uploading document:', e);
						}
					})();
					p.finally(() => {
						uploading.delete(p);
						uploaded += 1;
						if (uploaded % 10 === 0) {
							const remaining = mappings.size - uploaded;
							onProgress?.(l10n.t('Uploading documents... ({0} remaining)', remaining));
							const elapsed = Math.round(performance.now() - uploadStart);
							const docsPerSecond = Math.round(uploaded / (elapsed / 1000));
							this.logService.info(
								`Uploaded ${uploaded} documents in ${elapsed}ms (${docsPerSecond}Hz)`,
							);
						}
					});
					uploading.add(p);

					// Have a max of $PROMISE_POOL_SIZE in-flight uploads
					if (uploading.size >= ExternalIngestClient.PROMISE_POOL_SIZE) {
						await Promise.race(uploading);
					}
				}
			}

			pageToken = nextPageToken;
		} while (pageToken);

		await raceCancellationError(Promise.all(uploading), token);

		// Print the number of uploaded documents - may not match the number in your directory if some
		// have been uploaded already!
		this.logService.info(
			`ExternalIngestClient::updateIndex(): Uploaded ${uploaded} ingestable files in ${Math.round(performance.now() - uploadStart)}ms`,
		);
		onProgress?.(l10n.t('Finalizing index...'));
		const resp = await this.post(authToken, '/external/code/ingest/finalize', {
			ingest_id: ingestId,
		}, {}, callTracker, token);

		this.logService.info('ExternalIngestClient::updateIndex(): Successfully finalized ingest.');
		const requestId = resp.headers.get('x-github-request-id');
		const body = await resp.text();
		this.logService.debug(`requestId: '${requestId}', body: ${body}`);

		return Result.ok({ checkpoint: newCheckpoint });
	}

	async listFilesets(callTracker: CallTracker, token: CancellationToken): Promise<string[]> {
		const authToken = await this.getAuthToken();
		if (!authToken) {
			this.logService.warn('ExternalIngestClient::listFilesets(): No auth token available');
			return [];
		}

		const filesets = await this.listFilesetsWithDetails(authToken, callTracker.add('ExternalIngestClient::listFilesets'), token);
		return filesets.map(x => x.name);
	}

	private async listFilesetsWithDetails(authToken: string, callTracker: CallTracker, token: CancellationToken): Promise<Array<{ name: string; checkpoint: string; status: string }>> {
		const resp = await this.apiClient.makeRequest(
			`${ExternalIngestClient.baseUrl}/external/code/ingest`,
			this.getHeaders(authToken),
			'GET',
			undefined,
			callTracker.add('ExternalIngestClient::listFilesetsWithDetails'),
			token
		);

		const body = await resp.json() as { filesets?: Array<{ name: string; checkpoint: string; status: string }>; max_filesets: number };
		return body.filesets ?? [];
	}

	/**
	 * Cleans up old filesets to make room for new ones.
	 */
	private async cleanupOldFilesets(authToken: string, currentFilesetName: string, inCallTracker: CallTracker, token: CancellationToken): Promise<void> {
		const callTracker = inCallTracker.add('ExternalIngestClient::cleanupOldFilesets');
		const filesets = await this.listFilesetsWithDetails(authToken, callTracker, token);

		const candidates = filesets.filter(f => f.name !== currentFilesetName);
		const toDelete = candidates.at(-1);
		if (toDelete) {
			await this.deleteFilesetByName(authToken, toDelete.name, callTracker, token);
		}
	}

	async deleteFileset(filesetName: string, callTracker: CallTracker, token: CancellationToken): Promise<void> {
		const authToken = await this.getAuthToken();
		if (!authToken) {
			this.logService.warn('ExternalIngestClient::deleteFileset(): No auth token available');
			return;
		}

		return this.deleteFilesetByName(authToken, filesetName, callTracker.add('ExternalIngestClient::deleteFileset'), token);
	}

	async deleteFilesetByName(authToken: string, fileSetName: string, callTracker: CallTracker, token: CancellationToken): Promise<void> {
		const resp = await this.apiClient.makeRequest(
			`${ExternalIngestClient.baseUrl}/external/code/ingest`,
			this.getHeaders(authToken),
			'DELETE',
			{
				fileset_name: fileSetName,
			},
			callTracker.add('ExternalIngestClient::deleteFilesetByName'),
			token
		);
		const requestId = resp.headers.get('x-github-request-id');
		const respBody = await resp.text();
		this.logService.debug(`ExternalIngestClient::deleteFilesetByName(): Delete response - requestId: '${requestId}', body: ${respBody}`);
		this.logService.info(`ExternalIngestClient::deleteFilesetByName(): Deleted: ${fileSetName}`);
	}

	async searchFilesets(filesetName: string, rootUri: URI, prompt: string, limit: number, callTracker: CallTracker, token: CancellationToken): Promise<CodeSearchResult> {
		const authToken = await this.getAuthToken();
		if (!authToken) {
			this.logService.warn('ExternalIngestClient::searchFilesets(): No auth token available');
			return { outOfSync: false, chunks: [] };
		}

		this.logService.debug(`ExternalIngestClient::searchFilesets(): Searching fileset '${filesetName}' for prompt: '${prompt}'`);
		const embeddingType = EmbeddingType.metis_1024_I16_Binary;
		const resp = await this.post(authToken, '/external/embeddings/code/search', {
			prompt,
			scoping_query: `fileset:${filesetName}`,
			embedding_model: embeddingType.id,
			limit,
		}, {}, callTracker.add('ExternalIngestClient::searchFilesets'), token);

		const body = await resp.json() as SearchFilesetsResponse;
		return {
			outOfSync: false,
			chunks: body.results.map((r): FileChunkAndScore => ({
				distance: {
					embeddingType,
					value: r.distance,
				},
				chunk: {
					text: r.chunk.text,
					rawText: undefined,
					file: URI.joinPath(rootUri, r.location.path),
					range: new Range(r.chunk.line_range.start, 0, r.chunk.line_range.end, 0),
				},
			})),
		};

	}
}

interface SearchFilesetsResponse {
	readonly results: SearchResult[];
	readonly embedding_model: string;
}

interface SearchResult {
	readonly location: SearchLocation;
	readonly distance: number;
	readonly chunk: SearchChunk;
	readonly text: string;
}

interface SearchLocation {
	readonly fileset: string;
	readonly checkpoint: string;
	readonly doc_id: string;
	readonly path: string;
}

interface SearchChunk {
	readonly hash: string;
	readonly text: string;
	readonly line_range: LineRange;
	readonly range: CharacterRange;
}

interface LineRange {
	readonly start: number;
	readonly end: number;
}

interface CharacterRange {
	readonly start: number;
	readonly end: number;
}
