/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { IInstallableMcpServer, RegistryType } from '../../vscode-node/mapping/mcpManagement';
import { McpServerType } from '../../vscode-node/mapping/mcpPlatformTypes';
import { mapServerJsonToMcpServer } from '../../vscode-node/util';

describe('mapServerJsonToMcpServer', () => {
	it('handles 2025-07-09 schema version', async () => {
		const manifest = {
			"$schema": "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json",
			name: "test",
			description: "test",
			version: "1.0.0",
			packages: [{ registry_type: 'nuget', name: 'SomeId', version: '0.1.0' }]
		};
		const expected: Omit<IInstallableMcpServer, "name"> = {
			config: {
				type: McpServerType.LOCAL,
				command: "dnx",
				args: ["SomeId@0.1.0", "--yes"]
			}
		};

		const actual = mapServerJsonToMcpServer(manifest, RegistryType.NUGET);

		expect(actual).toEqual(expected);
	});

	it('handles 2025-09-29 schema version', async () => {
		const manifest = {
			"$schema": "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
			name: "test",
			description: "test",
			version: "1.0.0",
			packages: [{ registryType: 'nuget', identifier: 'SomeId', version: '0.1.0' }]
		};
		const expected: Omit<IInstallableMcpServer, "name"> = {
			config: {
				type: McpServerType.LOCAL,
				command: "dnx",
				args: ["SomeId@0.1.0", "--yes"]
			}
		};

		const actual = mapServerJsonToMcpServer(manifest, RegistryType.NUGET);

		expect(actual).toEqual(expected);
	});

	it('defaults to first package without matching type', async () => {
		const manifest = {
			"$schema": "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
			name: "test",
			description: "test",
			version: "1.0.0",
			packages: [{ registryType: 'npm', identifier: 'SomeId', version: '0.1.0' }]
		};
		const expected: Omit<IInstallableMcpServer, "name"> = {
			config: {
				type: McpServerType.LOCAL,
				command: "npx",
				args: ["SomeId@0.1.0"]
			}
		};

		const actual = mapServerJsonToMcpServer(manifest, RegistryType.NUGET);

		expect(actual).toEqual(expected);
	});
});
