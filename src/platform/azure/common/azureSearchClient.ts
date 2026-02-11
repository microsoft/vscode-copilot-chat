/*---------------------------------------------------------------------------------------------
 *  Azure AI Search Client
 *  Manages indexes and performs vector search operations against Azure AI Search.
 *  Supports creating/updating indexes, upserting documents with vector embeddings,
 *  and performing vector-based semantic search.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ILogService } from '../../log/common/logService';

export const IAzureSearchClient = createServiceIdentifier<IAzureSearchClient>('IAzureSearchClient');

export interface SearchDocument {
	id: string;
	content: string;
	filePath: string;
	startLine: number;
	endLine: number;
	contentVector: number[];
}

export interface SearchResult {
	id: string;
	content: string;
	filePath: string;
	startLine: number;
	endLine: number;
	score: number;
}

export interface IAzureSearchClient {
	readonly _serviceBrand: undefined;

	isConfigured(): boolean;

	/**
	 * Creates or updates the search index schema for workspace embeddings.
	 */
	ensureIndex(): Promise<void>;

	/**
	 * Upserts documents (file chunks with embeddings) into the search index.
	 */
	upsertDocuments(documents: SearchDocument[]): Promise<void>;

	/**
	 * Searches the index using a vector query.
	 */
	vectorSearch(queryVector: number[], topK: number): Promise<SearchResult[]>;

	/**
	 * Deletes documents from the index by their IDs.
	 */
	deleteDocuments(ids: string[]): Promise<void>;

	/**
	 * Deletes the entire index.
	 */
	deleteIndex(): Promise<void>;
}

interface SearchIndexResponse {
	value?: SearchResult[];
}

export class AzureSearchClient implements IAzureSearchClient {

	declare readonly _serviceBrand: undefined;

	private static readonly API_VERSION = '2024-07-01';
	private static readonly VECTOR_DIMENSIONS = 3072;
	private static readonly UPSERT_BATCH_SIZE = 100;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
	) { }

	private getSearchEndpoint(): string {
		return (this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.searchEndpoint') || '').replace(/\/$/, '');
	}

	private getSearchApiKey(): string {
		return this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.searchApiKey') || '';
	}

	private getIndexName(): string {
		return this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.searchIndexName') || 'copilot-workspace';
	}

	isConfigured(): boolean {
		return !!this.getSearchEndpoint() && !!this.getSearchApiKey();
	}

	async ensureIndex(): Promise<void> {
		const endpoint = this.getSearchEndpoint();
		const apiKey = this.getSearchApiKey();
		const indexName = this.getIndexName();

		if (!endpoint || !apiKey) {
			this._logService.warn('Azure AI Search not configured');
			return;
		}

		const url = `${endpoint}/indexes/${indexName}?api-version=${AzureSearchClient.API_VERSION}`;

		const indexDefinition = {
			name: indexName,
			fields: [
				{ name: 'id', type: 'Edm.String', key: true, filterable: true },
				{ name: 'content', type: 'Edm.String', searchable: true },
				{ name: 'filePath', type: 'Edm.String', filterable: true, searchable: true },
				{ name: 'startLine', type: 'Edm.Int32', filterable: true },
				{ name: 'endLine', type: 'Edm.Int32', filterable: true },
				{
					name: 'contentVector',
					type: 'Collection(Edm.Single)',
					searchable: true,
					vectorSearchDimensions: AzureSearchClient.VECTOR_DIMENSIONS,
					vectorSearchProfileName: 'default-vector-profile',
				},
			],
			vectorSearch: {
				algorithms: [
					{
						name: 'default-hnsw',
						kind: 'hnsw',
						hnswParameters: {
							m: 4,
							efConstruction: 400,
							efSearch: 500,
							metric: 'cosine',
						},
					},
				],
				profiles: [
					{
						name: 'default-vector-profile',
						algorithmConfigurationName: 'default-hnsw',
					},
				],
			},
		};

		try {
			const response = await this._fetcherService.fetch(url, {
				method: 'PUT',
				headers: {
					'api-key': apiKey,
				},
				json: indexDefinition,
			});

			if (!response.ok && response.status !== 204) {
				const errorText = await response.text();
				this._logService.error(`Failed to create/update Azure Search index: ${response.status} ${errorText}`);
				throw new Error(`Azure Search index creation failed: ${response.status}`);
			}

			this._logService.info(`Azure Search index '${indexName}' ensured successfully`);
		} catch (err) {
			this._logService.error(`Azure Search ensureIndex failed: ${(err as Error).message}`);
			throw err;
		}
	}

	async upsertDocuments(documents: SearchDocument[]): Promise<void> {
		const endpoint = this.getSearchEndpoint();
		const apiKey = this.getSearchApiKey();
		const indexName = this.getIndexName();

		if (!endpoint || !apiKey) {
			return;
		}

		const url = `${endpoint}/indexes/${indexName}/docs/index?api-version=${AzureSearchClient.API_VERSION}`;

		// Batch the upserts
		for (let i = 0; i < documents.length; i += AzureSearchClient.UPSERT_BATCH_SIZE) {
			const batch = documents.slice(i, i + AzureSearchClient.UPSERT_BATCH_SIZE);

			const body = {
				value: batch.map(doc => ({
					'@search.action': 'mergeOrUpload',
					id: doc.id,
					content: doc.content,
					filePath: doc.filePath,
					startLine: doc.startLine,
					endLine: doc.endLine,
					contentVector: doc.contentVector,
				})),
			};

			try {
				const response = await this._fetcherService.fetch(url, {
					method: 'POST',
					headers: {
						'api-key': apiKey,
					},
					json: body,
				});

				if (!response.ok) {
					const errorText = await response.text();
					this._logService.error(`Azure Search upsert failed: ${response.status} ${errorText}`);
					throw new Error(`Azure Search upsert failed: ${response.status}`);
				}

				this._logService.debug(`Azure Search: upserted ${batch.length} documents (batch ${Math.floor(i / AzureSearchClient.UPSERT_BATCH_SIZE) + 1})`);
			} catch (err) {
				this._logService.error(`Azure Search upsert batch failed: ${(err as Error).message}`);
				throw err;
			}
		}
	}

	async vectorSearch(queryVector: number[], topK: number): Promise<SearchResult[]> {
		const endpoint = this.getSearchEndpoint();
		const apiKey = this.getSearchApiKey();
		const indexName = this.getIndexName();

		if (!endpoint || !apiKey) {
			return [];
		}

		const url = `${endpoint}/indexes/${indexName}/docs/search?api-version=${AzureSearchClient.API_VERSION}`;

		const body = {
			count: true,
			select: 'id,content,filePath,startLine,endLine',
			vectorQueries: [
				{
					kind: 'vector',
					vector: queryVector,
					fields: 'contentVector',
					k: topK,
					exhaustive: false,
				},
			],
		};

		try {
			const response = await this._fetcherService.fetch(url, {
				method: 'POST',
				headers: {
					'api-key': apiKey,
				},
				json: body,
			});

			if (!response.ok) {
				const errorText = await response.text();
				this._logService.error(`Azure Search vector search failed: ${response.status} ${errorText}`);
				return [];
			}

			const result = await response.json() as SearchIndexResponse;
			return (result.value || []).map(item => ({
				id: item.id,
				content: item.content,
				filePath: item.filePath,
				startLine: item.startLine,
				endLine: item.endLine,
				score: item.score,
			}));
		} catch (err) {
			this._logService.error(`Azure Search vector search failed: ${(err as Error).message}`);
			return [];
		}
	}

	async deleteDocuments(ids: string[]): Promise<void> {
		const endpoint = this.getSearchEndpoint();
		const apiKey = this.getSearchApiKey();
		const indexName = this.getIndexName();

		if (!endpoint || !apiKey || ids.length === 0) {
			return;
		}

		const url = `${endpoint}/indexes/${indexName}/docs/index?api-version=${AzureSearchClient.API_VERSION}`;

		for (let i = 0; i < ids.length; i += AzureSearchClient.UPSERT_BATCH_SIZE) {
			const batch = ids.slice(i, i + AzureSearchClient.UPSERT_BATCH_SIZE);

			const body = {
				value: batch.map(id => ({
					'@search.action': 'delete',
					id,
				})),
			};

			try {
				const response = await this._fetcherService.fetch(url, {
					method: 'POST',
					headers: {
						'api-key': apiKey,
					},
					json: body,
				});

				if (!response.ok) {
					const errorText = await response.text();
					this._logService.error(`Azure Search delete failed: ${response.status} ${errorText}`);
				}
			} catch (err) {
				this._logService.error(`Azure Search delete batch failed: ${(err as Error).message}`);
			}
		}
	}

	async deleteIndex(): Promise<void> {
		const endpoint = this.getSearchEndpoint();
		const apiKey = this.getSearchApiKey();
		const indexName = this.getIndexName();

		if (!endpoint || !apiKey) {
			return;
		}

		const url = `${endpoint}/indexes/${indexName}?api-version=${AzureSearchClient.API_VERSION}`;

		try {
			const response = await this._fetcherService.fetch(url, {
				method: 'PUT',
				headers: {
					'api-key': apiKey,
				},
				json: { name: indexName, fields: [] },
			});

			if (!response.ok && response.status !== 404) {
				const errorText = await response.text();
				this._logService.error(`Azure Search delete index failed: ${response.status} ${errorText}`);
			}
		} catch (err) {
			this._logService.error(`Azure Search deleteIndex failed: ${(err as Error).message}`);
		}
	}
}
