/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lm } from 'vscode';
import { AbstractMcpService } from '../common/mcpService';

export class McpService extends AbstractMcpService {
	declare readonly _serviceBrand: undefined;

	get mcpServerDefinitions() {
		return lm.mcpServerDefinitions;
	}

	get onDidChangeMcpServerDefinitions() {
		return lm.onDidChangeMcpServerDefinitions;
	}
}
