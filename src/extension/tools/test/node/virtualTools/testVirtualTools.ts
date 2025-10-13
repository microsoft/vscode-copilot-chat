/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { Embedding } from '../../../../../platform/embeddings/common/embeddingsComputer';
import { IToolEmbeddingsComputer } from '../../../common/virtualTools/toolEmbeddingsComputer';

export class TestToolEmbeddingsComputer implements IToolEmbeddingsComputer {
	declare _serviceBrand: undefined;

	retrieveSimilarEmbeddingsForAvailableTools(queryEmbedding: Embedding, availableToolNames: readonly LanguageModelToolInformation[], limit: number): Promise<string[]> {
		return Promise.resolve(availableToolNames.slice(0, limit).map(t => t.name));
	}
}
