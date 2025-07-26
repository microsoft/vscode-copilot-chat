/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
// import { WorkspaceChunkSearch } from '../../../platform/workspaceChunkSearch/node/workspaceChunkSearch';

export function create(accessor: ServicesAccessor): void {

	const logService = accessor.get(ILogService);
	accessor.get(IWorkspaceService).ensureWorkspaceIsFullyLoaded().catch(error => logService.error(error));
	// TODO @TylerLeonhardt: Bring this back once we have improved the performance of the workspace chunk search indexing
	// see https://github.com/microsoft/vscode-copilot-release/issues/784
	// await accessor.get(WorkspaceChunkSearch).triggerIndexing();
}
