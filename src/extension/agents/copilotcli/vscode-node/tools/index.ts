/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerOpenDiffTool } from './openDiff';
import { registerCloseDiffTool } from './closeDiff';
import { registerGetDiagnosticsTool } from './getDiagnostics';
import { registerGetSelectionTool } from './getSelection';
import { registerGetVscodeInfoTool } from './getVscodeInfo';
import { registerShowNotificationTool } from './showNotification';
import { ILogger } from '../../../../../platform/log/common/logService';

export { getSelectionInfo, updateLatestSelection, getLatestSelection } from './getSelection';

export function registerTools(server: McpServer, logger: ILogger): void {
	logger.debug('Registering MCP tools...');
	registerGetVscodeInfoTool(server, logger);
	registerGetSelectionTool(server, logger);
	registerOpenDiffTool(server, logger);
	registerCloseDiffTool(server, logger);
	registerGetDiagnosticsTool(server, logger);
	registerShowNotificationTool(server, logger);
	logger.debug('All MCP tools registered');
}
