/*---------------------------------------------------------------------------------------------
 *  Azure Available Embedding Types Service
 *  Replaces GithubAvailableEmbeddingTypesService.
 *  Always returns text3large_3072 since that's what our Azure OpenAI deployment provides.
 *--------------------------------------------------------------------------------------------*/

import { EmbeddingType } from '../../embeddings/common/embeddingsComputer';
import { IGithubAvailableEmbeddingTypesService } from '../../workspaceChunkSearch/common/githubAvailableEmbeddingTypes';

export class AzureAvailableEmbeddingTypesService implements IGithubAvailableEmbeddingTypesService {

	declare readonly _serviceBrand: undefined;

	async getPreferredType(_silent: boolean): Promise<EmbeddingType | undefined> {
		return EmbeddingType.text3large_3072;
	}
}
