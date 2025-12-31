/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentContents, GeoFilter, IngestFilter, canIngestDocument, createCodedSymbols, setupPanicHooks } from '@github/blackbird-external-ingest-utils';
import crypto from 'crypto';
import fs from 'fs';
import { posix } from 'node:path';
import { CancellationToken } from 'vscode-languageserver-protocol';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { timeout } from '../../../../util/vs/base/common/async';
import { URI } from '../../../../util/vs/base/common/uri';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { FileChunkAndScore } from '../../../chunking/common/chunk';
import { EmbeddingType } from '../../../embeddings/common/embeddingsComputer';
import { ILogService } from '../../../log/common/logService';
import { CodeSearchResult } from '../../../remoteCodeSearch/common/remoteCodeSearch';
import { ApiClient } from './externalIngestApi';


// Create a shared API client with throttling (target quota usage of 80)
// You can change this to `null` to ignore the throttle

export class ExternalIngestClient {
	private static apiClient = new ApiClient(80);

	private static readonly PROMISE_POOL_SIZE = 32;
	private static baseUrl = 'https://api.github.com';

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	private getHeaders(authToken: string): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'X-GitHub-Staff-Request': '1',
		};
		// if (staffRequest) {
		// 	headers["X-GitHub-Staff-Request"] = '1';
		// }

		headers['Authorization'] = `Bearer ${authToken}`;

		return headers;
	}

	private post(authToken: string, path: string, body: unknown, token: CancellationToken) {
		const url = `${ExternalIngestClient.baseUrl}${path}`;
		return ExternalIngestClient.apiClient.makeRequest(url, this.getHeaders(authToken), 'POST', body, token);
	}

	async doInitialIndex(authToken: string, filesetName: string, root: URI, allFiles: AsyncIterable<{ readonly uri: URI; readonly docSha: Uint8Array }>, token: CancellationToken): Promise<void> {
		setupPanicHooks();

		// Initial setup
		const ingestFilter = new IngestFilter();
		const mappings = new Map<string, { full: string; relative: string }>();
		const geoFilter = new GeoFilter();


		this.logService.info(`ExternalIngestClient::doInitialIndex(). Creating ingest for fileset: ${filesetName}`);
		const allDocShas: Uint8Array[] = [];

		this.logService.trace(`ExternalIngestClient::doInitialIndex(). Checking for ingestable files...`);
		const ingestableCheckStart = performance.now();
		// Figure out which documents are uploadable and insert them into the geoFilter
		// and DocSha to path map and DocSha array.
		const checking = new Set<Promise<void>>();
		for await (const file of allFiles) {
			const relativePath = posix.relative(root.path, file.uri.path);
			const full = file.uri.fsPath;

			const p = (async () => {
				this.logService.debug(`ExternalIngestClient::doInitialIndex(). Checking if file can be ingested: ${relativePath}`);
				const fileBytes = await fs.promises.readFile(full);
				const content = new DocumentContents(fileBytes);
				if (canIngestDocument(ingestFilter, relativePath, content)) { // Can we do this lazily?
					try {
						const docSha = file.docSha; //getDocSha(relativePath, content);
						geoFilter.push(docSha);
						allDocShas.push(docSha);
						// Clients of the external ingest process are required to store a mapping of docSha to
						// document path. In this example ingestion code it is handled in memory but you might want
						// to persist somewhere. Note that our example converts the Uin8Arrays to base64 strings
						// since Uint8Array doesn't work as a Map key because equality is checked by reference.
						const docShaBase64 = Buffer.from(docSha).toString('base64');
						mappings.set(docShaBase64, { full, relative: relativePath });
					} catch (err) {
						throw new Error('Exception during ingest file', err);
					}
				}
			})();
			p.finally(() => {
				checking.delete(p);
			});
			checking.add(p);
			if (checking.size >= ExternalIngestClient.PROMISE_POOL_SIZE) {
				await Promise.race(checking);
			}
		}
		await Promise.all(checking);

		this.logService.debug(`ExternalIngestClient::doInitialIndex(). Found ${mappings.size} ingestable files in ${Math.round(performance.now() - ingestableCheckStart)}ms`,);

		// Coded symbols used during finalization of the fileset.
		// TODO: this range should be the entire fileset, right?
		const codedSymbols = createCodedSymbols(allDocShas, 0, 1).map((cs) => Buffer.from(cs).toString('base64'));

		// A hash of all docsha hashes. This emulates a differing git commit.
		const checkpointHash = crypto.createHash('sha1');
		for (const docSha of allDocShas) {
			checkpointHash.update(docSha);

		}
		const newCheckpoint = checkpointHash.digest().toString('base64');

		// Create snapshot - this endpoint could return 429 if you already have too many filesets
		let createIngestResponse: Response;
		try {
			createIngestResponse = await this.post(authToken, '/external/code/ingest', {
				fileset_name: filesetName,
				new_checkpoint: newCheckpoint,
				geo_filter: Buffer.from(geoFilter.toBytes()).toString('base64'),
				coded_symbols: codedSymbols,
			}, token);
		} catch (err) {
			throw new Error('Exception during create ingest', err);
		}

		interface CodedSymbolRange {
			readonly start: number;
			readonly end: number;
		}

		const res = await createIngestResponse.json() as { ingest_id: string; coded_symbol_range: CodedSymbolRange };
		const ingestId = res.ingest_id;
		let codedSymbolRange: CodedSymbolRange | undefined = res.coded_symbol_range;

		if (
			ingestId === '' &&
			codedSymbolRange.start === 0 &&
			codedSymbolRange.end === 0
		) {
			this.logService.info('Ingest has already run successfully');
			return;
		}

		this.logService.debug(`Got ingest ID: ${ingestId}`);

		this.logService.debug('Starting set reconciliation...');

		// Create snapshot
		while (codedSymbolRange) {
			this.logService.debug(
				`Creating coded symbols for ${codedSymbolRange.start} to ${codedSymbolRange.end}`,
			);
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
					token
				);
				const body = await pushCodedSymbolsResponse.json() as { next_coded_symbol_range?: CodedSymbolRange };
				codedSymbolRange = body.next_coded_symbol_range;
			} catch (e) {
				this.logService.error(`ExternalIngestClient::doInitialIndex(): Failed to push coded symbols: ${pushCodedSymbolsResponse?.statusText} - ${await pushCodedSymbolsResponse?.text()}`);
				throw new Error('Exception during push coded symbols');
			}
		}

		// Document upload
		this.logService.debug('Starting document upload...');
		let pageToken = undefined;
		// Set of seen doc shas.
		const seen = new Set<string>();
		// Set of currently uploading promises.
		const uploading = new Set<Promise<void>>();
		// Tracking for performance reporting.
		let uploaded = 0;
		const uploadStart = performance.now();
		do {
			try {
				await Promise.all(uploading);
			} catch (e) {
				this.logService.error('ExternalIngestClient::doInitialIndex(): Error uploading document:', e);
			}

			this.logService.debug(`ExternalIngestClient::doInitialIndex(): calling batch API with pageToken: ${pageToken}`);
			await timeout(5000); // slight delay to avoid hammering the API
			const getBatchResponse = await this.post(authToken, '/external/code/ingest/batch', {
				ingest_id: ingestId,
				page_token: pageToken,
			}, token);

			const { doc_ids: docIds, next_page_token: nextPageToken } =
				await getBatchResponse.json() as { doc_ids: string[]; next_page_token: string | undefined };

			// Need to check that there are some docIds to process. It can be the case where you get a page
			// token to continue pulling batches, but the batch is empty. Just keep pulling until we have
			// no next_page_token.
			if (docIds) {
				const newSet = new Set(docIds);
				const toUpload = new Set([...newSet].filter(x => !seen.has(x)));

				for (const requestedDocSha of toUpload) {
					seen.add(requestedDocSha);
					const p = (async () => {
						const paths = mappings.get(requestedDocSha);
						if (!paths) {
							throw new Error(`No mapping for docSha: ${requestedDocSha}`);
						}
						this.logService.debug(`ExternalIngestClient::doInitialIndex(): Uploading file: ${paths.relative}`);
						const bytes = await fs.promises.readFile(paths.full);
						const content = bytes.toString('base64');
						const res = await this.post(authToken, '/external/code/ingest/document', {
							ingest_id: ingestId,
							content,
							file_path: paths.relative,
						}, token);
						this.logService.debug(`ExternalIngestClient::doInitialIndex(): Document upload response status: ${res.status}`);
					})();
					p.catch(e => {
						this.logService.error('ExternalIngestClient::doInitialIndex(): Error uploading document:', e);
						// throw e;
					});
					p.finally(() => {
						uploading.delete(p);
						uploaded += 1;
						if (uploaded % 10 === 0) {
							const elapsed = Math.round(performance.now() - uploadStart);
							const docsPerSecond = Math.round(uploaded / (elapsed / 1000));
							this.logService.info(
								`Uploaded ${uploaded} documents in ${elapsed}ms (${docsPerSecond}Hz)`,
							);
						}
					});
					uploading.add(p);

					// Have a max of $PROMISE_POOL_SIZE in-flight uploads. For me, at 32 we seem to be limited
					// by vLLM/Metis so a larger batch size might not yield improvements. YMMV.
					if (uploading.size >= ExternalIngestClient.PROMISE_POOL_SIZE) {
						await Promise.race(uploading);
					}
				}
			}

			if (pageToken === nextPageToken) {
				break;
			}

			pageToken = nextPageToken;
		} while (pageToken);

		await Promise.all(uploading);
		// Print the number of uploaded documents - may not match the number in your directory if some
		// have been uploaded already!
		this.logService.info(
			`ExternalIngestClient::doInitialIndex(): Uploaded ${uploaded} ingestable files in ${Math.round(performance.now() - uploadStart)}ms`,
		);
		const resp = await this.post(authToken, '/external/code/ingest/finalize', {
			ingest_id: ingestId,
		}, token);

		this.logService.info('ExternalIngestClient::doInitialIndex(): SUCCESS!!');
		const requestId = resp.headers.get('x-github-request-id');
		const body = await resp.text();
		this.logService.debug(`requestId: '${requestId}', body: ${body}`);
	}

	async listFilesets(authToken: string, token: CancellationToken): Promise<string[]> {
		const resp = await ExternalIngestClient.apiClient.makeRequest(
			`${ExternalIngestClient.baseUrl}/external/code/ingest`,
			this.getHeaders(authToken),
			'GET',
			undefined,
			token
		);

		const body = await resp.json() as { filesets?: Array<{ name: string; checkpoint: string; status: string }>; max_filesets: number };
		return coalesce((body.filesets ?? []).map(x => x.name));
	}

	async deleteFileset(authToken: string, filesetName: string, token: CancellationToken): Promise<void> {
		return this.deleteFilesetByName(authToken, filesetName, token);
	}

	async deleteFilesetByName(authToken: string, fileSetName: string, token: CancellationToken): Promise<void> {
		const resp = await ExternalIngestClient.apiClient.makeRequest(
			`${ExternalIngestClient.baseUrl}/external/code/ingest`,
			this.getHeaders(authToken),
			'DELETE',
			{
				fileset_name: fileSetName,
			},
			token
		);
		const requestId = resp.headers.get('x-github-request-id');
		const respBody = await resp.text();
		this.logService.debug(`ExternalIngestClient::deleteFilesetByName(): Delete response - requestId: '${requestId}', body: ${respBody}`);
		this.logService.info(`ExternalIngestClient::deleteFilesetByName(): Deleted: ${fileSetName}`);
	}

	async searchFilesets(authToken: string, filesetName: string, rootUri: URI, prompt: string, limit: number, token: CancellationToken): Promise<CodeSearchResult> {
		this.logService.debug(`ExternalIngestClient::searchFilesets(): Searching fileset '${filesetName}' for prompt: '${prompt}'`);
		const embeddingType = EmbeddingType.metis_1024_I16_Binary;
		const resp = await this.post(authToken, '/external/embeddings/code/search', {
			prompt,
			scoping_query: `fileset:${filesetName}`,
			embedding_model: embeddingType.id,
			limit,
		}, token);

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
