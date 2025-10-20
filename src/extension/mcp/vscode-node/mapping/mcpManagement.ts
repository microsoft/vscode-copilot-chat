/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMcpServerConfiguration, IMcpServerVariable } from './mcpPlatformTypes';

export interface IMcpServerInput {
	readonly description?: string;
	readonly isRequired?: boolean;
	readonly format?: 'string' | 'number' | 'boolean' | 'filepath';
	readonly value?: string;
	readonly isSecret?: boolean;
	readonly default?: string;
	readonly choices?: readonly string[];
}

export interface IMcpServerVariableInput extends IMcpServerInput {
	readonly variables?: Record<string, IMcpServerInput>;
}

export interface IMcpServerPositionalArgument extends IMcpServerVariableInput {
	readonly type: 'positional';
	readonly valueHint?: string;
	readonly isRepeated?: boolean;
}

export interface IMcpServerNamedArgument extends IMcpServerVariableInput {
	readonly type: 'named';
	readonly name: string;
	readonly isRepeated?: boolean;
}

export interface IMcpServerKeyValueInput extends IMcpServerVariableInput {
	readonly name: string;
	readonly value?: string;
}

export type IMcpServerArgument = IMcpServerPositionalArgument | IMcpServerNamedArgument;

export const enum RegistryType {
	NODE = 'npm',
	PYTHON = 'pypi',
	DOCKER = 'oci',
	NUGET = 'nuget',
	MCPB = 'mcpb',
	REMOTE = 'remote'
}

export const enum TransportType {
	STDIO = 'stdio',
	STREAMABLE_HTTP = 'streamable-http',
	SSE = 'sse'
}

export interface StdioTransport {
	readonly type: TransportType.STDIO;
}

export interface StreamableHttpTransport {
	readonly type: TransportType.STREAMABLE_HTTP;
	readonly url: string;
	readonly headers?: ReadonlyArray<IMcpServerKeyValueInput>;
}

export interface SseTransport {
	readonly type: TransportType.SSE;
	readonly url: string;
	readonly headers?: ReadonlyArray<IMcpServerKeyValueInput>;
}

export type Transport = StdioTransport | StreamableHttpTransport | SseTransport;

export interface IMcpServerPackage {
	readonly registryType: RegistryType;
	readonly identifier: string;
	readonly version: string;
	readonly transport?: Transport;
	readonly registryBaseUrl?: string;
	readonly fileSha256?: string;
	readonly packageArguments?: readonly IMcpServerArgument[];
	readonly runtimeHint?: string;
	readonly runtimeArguments?: readonly IMcpServerArgument[];
	readonly environmentVariables?: ReadonlyArray<IMcpServerKeyValueInput>;
}

export interface IGalleryMcpServerConfiguration {
	readonly packages?: readonly IMcpServerPackage[];
	readonly remotes?: ReadonlyArray<SseTransport | StreamableHttpTransport>;
}

export const enum GalleryMcpServerStatus {
	Active = 'active',
	Deprecated = 'deprecated'
}

export interface IInstallableMcpServer {
	readonly name: string;
	readonly config: IMcpServerConfiguration;
	readonly inputs?: IMcpServerVariable[];
}

export type McpServerConfiguration = Omit<IInstallableMcpServer, 'name'>;
export interface McpServerConfigurationParseResult {
	readonly mcpServerConfiguration: McpServerConfiguration;
	readonly notices: string[];
}