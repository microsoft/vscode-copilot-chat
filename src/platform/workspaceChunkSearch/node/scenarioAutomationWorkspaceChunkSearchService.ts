/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LocalEmbeddingsIndexStatus } from './embeddingsChunkSearch';
import {
	WorkspaceChunkSearchService,
	WorkspaceIndexState,
} from './workspaceChunkSearchService';

/**
 * Scenario automation variant of WorkspaceChunkSearchService.
 *
 * In scenario automation the copilot token may not be available at construction
 * time and remote code-search APIs may be unreachable.  This override ensures
 * {@link getIndexState} never reports both local *and* remote indexes as
 * disabled, which would cause callers (e.g. `WorkspaceChunks.prepare()`) to
 * skip the search entirely.  When both would otherwise be disabled the remote
 * status is reported as `initializing` so that the search pipeline proceeds
 * to the TF-IDF / Blackbird fallback strategies.
 */
export class ScenarioAutomationWorkspaceChunkSearchService extends WorkspaceChunkSearchService {

	override async getIndexState(): Promise<WorkspaceIndexState> {
		const state = await super.getIndexState();

		if (state.localIndexState.status === LocalEmbeddingsIndexStatus.Disabled
			&& state.remoteIndexState.status === 'disabled') {
			return {
				...state,
				remoteIndexState: {
					...state.remoteIndexState,
					status: 'initializing',
				},
			};
		}

		return state;
	}
}
