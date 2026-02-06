/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerOpenDiffTool } from './openDiff';
import { registerCloseDiffTool } from './closeDiff';
import { registerGetDiagnosticsTool } from './getDiagnostics';
import { registerGetSelectionTool, SelectionState } from './getSelection';
import { registerGetVscodeInfoTool } from './getVscodeInfo';
import { ILogger } from '../../../../../platform/log/common/logService';
import { DiffStateManager } from '../diffState';
import { ReadonlyContentProvider } from '../readonlyContentProvider';

export { getSelectionInfo, SelectionState } from './getSelection';
export type { SelectionInfo } from './getSelection';

export function registerTools(server: McpServer, logger: ILogger, diffState: DiffStateManager, selectionState: SelectionState, contentProvider: ReadonlyContentProvider): void {
	logger.debug('Registering MCP tools...');
	registerGetVscodeInfoTool(server, logger);
	registerGetSelectionTool(server, logger, selectionState);
	registerOpenDiffTool(server, logger, diffState, contentProvider);
	registerCloseDiffTool(server, logger, diffState);
	registerGetDiagnosticsTool(server, logger);
	logger.debug('All MCP tools registered');
}
