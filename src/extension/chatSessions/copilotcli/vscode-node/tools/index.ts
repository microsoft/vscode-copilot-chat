/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ILogger } from '../../../../../platform/log/common/logService';
import { ICopilotCLISessionTracker } from '../copilotCLISessionTracker';
import { DiffStateManager } from '../diffState';
import { ReadonlyContentProvider } from '../readonlyContentProvider';
import { registerCloseDiffTool } from './closeDiff';
import { registerGetDiagnosticsTool } from './getDiagnostics';
import { registerGetSelectionTool, SelectionState } from './getSelection';
import { registerGetVscodeInfoTool } from './getVscodeInfo';
import { registerOpenDiffTool } from './openDiff';
import { registerRunLspQueryTool } from './runLspQuery';
import { registerUpdateSessionNameTool } from './updateSessionName';

export { getSelectionInfo, SelectionState } from './getSelection';
export type { SelectionInfo } from './getSelection';

export function registerTools(server: McpServer, logger: ILogger, diffState: DiffStateManager, selectionState: SelectionState, contentProvider: ReadonlyContentProvider, sessionTracker: ICopilotCLISessionTracker, sessionId: string): void {
	logger.debug('Registering MCP tools...');
	registerGetVscodeInfoTool(server, logger);
	registerGetSelectionTool(server, logger, selectionState);
	registerOpenDiffTool(server, logger, diffState, contentProvider, sessionId);
	registerCloseDiffTool(server, logger, diffState);
	registerGetDiagnosticsTool(server, logger);
	registerUpdateSessionNameTool(server, logger, sessionTracker, sessionId);
	registerRunLspQueryTool(server, logger);
	logger.debug('All MCP tools registered');
}
