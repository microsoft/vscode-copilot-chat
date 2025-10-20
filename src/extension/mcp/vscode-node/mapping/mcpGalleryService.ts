/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isObject, isString } from '../../../../util/vs/base/common/types';
import { GalleryMcpServerStatus, IMcpServerArgument, IMcpServerInput, IMcpServerKeyValueInput, IMcpServerPackage, RegistryType, SseTransport, StreamableHttpTransport, Transport, TransportType } from './mcpManagement';

interface IRawGalleryMcpServersMetadata {
	readonly count: number;
	readonly total?: number;
	readonly next_cursor?: string;
}

interface IRawGalleryMcpServersResult {
	readonly metadata?: IRawGalleryMcpServersMetadata;
	readonly servers: readonly IRawGalleryMcpServer[];
}

interface IGalleryMcpServerDataSerializer {
	toRawGalleryMcpServer(input: unknown): IRawGalleryMcpServer | undefined;
}

interface IRawGalleryMcpServer {
	readonly packages?: readonly IMcpServerPackage[];
	readonly remotes?: ReadonlyArray<SseTransport | StreamableHttpTransport>;
}

export namespace McpServerSchemaVersion_v2025_07_09 {

	export const VERSION = 'v0-2025-07-09';
	export const SCHEMA = `https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json`;

	interface RawGalleryMcpServerInput {
		readonly description?: string;
		readonly is_required?: boolean;
		readonly format?: 'string' | 'number' | 'boolean' | 'filepath';
		readonly value?: string;
		readonly is_secret?: boolean;
		readonly default?: string;
		readonly choices?: readonly string[];
	}

	interface RawGalleryMcpServerVariableInput extends RawGalleryMcpServerInput {
		readonly variables?: Record<string, RawGalleryMcpServerInput>;
	}

	interface RawGalleryMcpServerPositionalArgument extends RawGalleryMcpServerVariableInput {
		readonly type: 'positional';
		readonly value_hint?: string;
		readonly is_repeated?: boolean;
	}

	interface RawGalleryMcpServerNamedArgument extends RawGalleryMcpServerVariableInput {
		readonly type: 'named';
		readonly name: string;
		readonly is_repeated?: boolean;
	}

	interface RawGalleryMcpServerKeyValueInput extends RawGalleryMcpServerVariableInput {
		readonly name: string;
		readonly value?: string;
	}

	type RawGalleryMcpServerArgument = RawGalleryMcpServerPositionalArgument | RawGalleryMcpServerNamedArgument;

	interface McpServerDeprecatedRemote {
		readonly transport_type?: 'streamable' | 'sse';
		readonly transport?: 'streamable' | 'sse';
		readonly url: string;
		readonly headers?: ReadonlyArray<RawGalleryMcpServerKeyValueInput>;
	}

	type RawGalleryMcpServerRemotes = ReadonlyArray<SseTransport | StreamableHttpTransport | McpServerDeprecatedRemote>;

	type RawGalleryTransport = StdioTransport | StreamableHttpTransport | SseTransport;

	interface StdioTransport {
		readonly type: 'stdio';
	}

	interface StreamableHttpTransport {
		readonly type: 'streamable-http' | 'sse';
		readonly url: string;
		readonly headers?: ReadonlyArray<RawGalleryMcpServerKeyValueInput>;
	}

	interface SseTransport {
		readonly type: 'sse';
		readonly url: string;
		readonly headers?: ReadonlyArray<RawGalleryMcpServerKeyValueInput>;
	}

	interface RawGalleryMcpServerPackage {
		readonly registry_name: string;
		readonly name: string;
		readonly registry_type: 'npm' | 'pypi' | 'docker-hub' | 'nuget' | 'remote' | 'mcpb';
		readonly registry_base_url?: string;
		readonly identifier: string;
		readonly version: string;
		readonly file_sha256?: string;
		readonly transport?: RawGalleryTransport;
		readonly package_arguments?: readonly RawGalleryMcpServerArgument[];
		readonly runtime_hint?: string;
		readonly runtime_arguments?: readonly RawGalleryMcpServerArgument[];
		readonly environment_variables?: ReadonlyArray<RawGalleryMcpServerKeyValueInput>;
	}

	interface RawGalleryMcpServer {
		readonly $schema: string;
		readonly name: string;
		readonly description: string;
		readonly status?: 'active' | 'deprecated';
		readonly repository?: {
			readonly source: string;
			readonly url: string;
			readonly id?: string;
			readonly readme?: string;
		};
		readonly version: string;
		readonly website_url?: string;
		readonly created_at: string;
		readonly updated_at: string;
		readonly packages?: readonly RawGalleryMcpServerPackage[];
		readonly remotes?: RawGalleryMcpServerRemotes;
		readonly _meta: {
			readonly 'io.modelcontextprotocol.registry/official': {
				readonly id: string;
				readonly is_latest: boolean;
				readonly published_at: string;
				readonly updated_at: string;
				readonly release_date?: string;
			};
			readonly 'io.modelcontextprotocol.registry/publisher-provided'?: Record<string, unknown>;
		};
	}

	interface RawGalleryMcpServersResult {
		readonly metadata?: {
			readonly count: number;
			readonly total?: number;
			readonly next_cursor?: string;
		};
		readonly servers: readonly RawGalleryMcpServer[];
	}

	class Serializer implements IGalleryMcpServerDataSerializer {

		public toRawGalleryMcpServerResult(input: unknown): IRawGalleryMcpServersResult | undefined {
			if (!input || typeof input !== 'object' || !Array.isArray((input as RawGalleryMcpServersResult).servers)) {
				return undefined;
			}

			const from = <RawGalleryMcpServersResult>input;

			const servers: IRawGalleryMcpServer[] = [];
			for (const server of from.servers) {
				const rawServer = this.toRawGalleryMcpServer(server);
				if (!rawServer) {
					return undefined;
				}
				servers.push(rawServer);
			}

			return {
				metadata: from.metadata,
				servers
			};
		}

		public toRawGalleryMcpServer(input: unknown): IRawGalleryMcpServer | undefined {
			if (!input || typeof input !== 'object') {
				return undefined;
			}

			const from = <RawGalleryMcpServer>input;

			if (
				(!from.name || !isString(from.name))
				|| (!from.description || !isString(from.description))
				|| (!from.version || !isString(from.version))
			) {
				return undefined;
			}

			if (from.$schema && from.$schema !== McpServerSchemaVersion_v2025_07_09.SCHEMA) {
				return undefined;
			}

			function convertServerInput(input: RawGalleryMcpServerInput): IMcpServerInput {
				return {
					...input,
					isRequired: input.is_required,
					isSecret: input.is_secret,
				};
			}

			function convertVariables(variables: Record<string, RawGalleryMcpServerInput>): Record<string, IMcpServerInput> {
				const result: Record<string, IMcpServerInput> = {};
				for (const [key, value] of Object.entries(variables)) {
					result[key] = convertServerInput(value);
				}
				return result;
			}

			function convertServerArgument(arg: RawGalleryMcpServerArgument): IMcpServerArgument {
				if (arg.type === 'positional') {
					return {
						...arg,
						valueHint: arg.value_hint,
						isRepeated: arg.is_repeated,
						isRequired: arg.is_required,
						isSecret: arg.is_secret,
						variables: arg.variables ? convertVariables(arg.variables) : undefined,
					};
				}
				return {
					...arg,
					isRepeated: arg.is_repeated,
					isRequired: arg.is_required,
					isSecret: arg.is_secret,
					variables: arg.variables ? convertVariables(arg.variables) : undefined,
				};
			}

			function convertKeyValueInput(input: RawGalleryMcpServerKeyValueInput): IMcpServerKeyValueInput {
				return {
					...input,
					isRequired: input.is_required,
					isSecret: input.is_secret,
					variables: input.variables ? convertVariables(input.variables) : undefined,
				};
			}

			function convertTransport(input: RawGalleryTransport): Transport | undefined {
				switch (input.type) {
					case 'stdio':
						return {
							type: TransportType.STDIO,
						};
					case 'streamable-http':
						return {
							type: TransportType.STREAMABLE_HTTP,
							url: input.url,
							headers: input.headers?.map(convertKeyValueInput),
						};
					case 'sse':
						return {
							type: TransportType.SSE,
							url: input.url,
							headers: input.headers?.map(convertKeyValueInput),
						};
					default:
						return undefined;
				}
			}

			function convertRegistryType(input: string): RegistryType {
				switch (input) {
					case 'npm':
						return RegistryType.NODE;
					case 'docker':
					case 'docker-hub':
					case 'oci':
						return RegistryType.DOCKER;
					case 'pypi':
						return RegistryType.PYTHON;
					case 'nuget':
						return RegistryType.NUGET;
					case 'mcpb':
						return RegistryType.MCPB;
					default:
						return RegistryType.NODE;
				}
			}

			return {
				packages: from.packages?.map<IMcpServerPackage>(p => ({
					identifier: p.identifier ?? p.name,
					registryType: convertRegistryType(p.registry_type ?? p.registry_name),
					version: p.version,
					fileSha256: p.file_sha256,
					registryBaseUrl: p.registry_base_url,
					transport: p.transport ? convertTransport(p.transport) : undefined,
					packageArguments: p.package_arguments?.map(convertServerArgument),
					runtimeHint: p.runtime_hint,
					runtimeArguments: p.runtime_arguments?.map(convertServerArgument),
					environmentVariables: p.environment_variables?.map(convertKeyValueInput),
				})),
				remotes: from.remotes?.map(remote => {
					const type = (<RawGalleryTransport>remote).type ?? (<McpServerDeprecatedRemote>remote).transport_type ?? (<McpServerDeprecatedRemote>remote).transport;
					return {
						type: type === TransportType.SSE ? TransportType.SSE : TransportType.STREAMABLE_HTTP,
						url: remote.url,
						headers: remote.headers?.map(convertKeyValueInput)
					};
				}),
			};
		}
	}

	export const SERIALIZER = new Serializer();
}

namespace McpServerSchemaVersion_v0_1 {

	export const VERSION = 'v0.1';
	export const SCHEMA = `https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json`;

	interface RawGalleryMcpServerInput {
		readonly description?: string;
		readonly isRequired?: boolean;
		readonly format?: 'string' | 'number' | 'boolean' | 'filepath';
		readonly value?: string;
		readonly isSecret?: boolean;
		readonly default?: string;
		readonly placeholder?: string;
		readonly choices?: readonly string[];
	}

	interface RawGalleryMcpServerVariableInput extends RawGalleryMcpServerInput {
		readonly variables?: Record<string, RawGalleryMcpServerInput>;
	}

	interface RawGalleryMcpServerPositionalArgument extends RawGalleryMcpServerVariableInput {
		readonly type: 'positional';
		readonly valueHint?: string;
		readonly isRepeated?: boolean;
	}

	interface RawGalleryMcpServerNamedArgument extends RawGalleryMcpServerVariableInput {
		readonly type: 'named';
		readonly name: string;
		readonly isRepeated?: boolean;
	}

	interface RawGalleryMcpServerKeyValueInput extends RawGalleryMcpServerVariableInput {
		readonly name: string;
		readonly value?: string;
	}

	type RawGalleryMcpServerArgument = RawGalleryMcpServerPositionalArgument | RawGalleryMcpServerNamedArgument;

	type RawGalleryMcpServerRemotes = ReadonlyArray<SseTransport | StreamableHttpTransport>;

	type RawGalleryTransport = StdioTransport | StreamableHttpTransport | SseTransport;

	interface StdioTransport {
		readonly type: TransportType.STDIO;
	}

	interface StreamableHttpTransport {
		readonly type: TransportType.STREAMABLE_HTTP;
		readonly url: string;
		readonly headers?: ReadonlyArray<RawGalleryMcpServerKeyValueInput>;
	}

	interface SseTransport {
		readonly type: TransportType.SSE;
		readonly url: string;
		readonly headers?: ReadonlyArray<RawGalleryMcpServerKeyValueInput>;
	}

	interface RawGalleryMcpServerPackage {
		readonly registryType: RegistryType;
		readonly identifier: string;
		readonly version: string;
		readonly transport: RawGalleryTransport;
		readonly registryBaseUrl?: string;
		readonly fileSha256?: string;
		readonly packageArguments?: readonly RawGalleryMcpServerArgument[];
		readonly runtimeHint?: string;
		readonly runtimeArguments?: readonly RawGalleryMcpServerArgument[];
		readonly environmentVariables?: ReadonlyArray<RawGalleryMcpServerKeyValueInput>;
	}

	interface RawGalleryMcpServer {
		readonly name: string;
		readonly description: string;
		readonly version: string;
		readonly $schema?: string;
		readonly title?: string;
		readonly repository?: {
			readonly source: string;
			readonly url: string;
			readonly id?: string;
			readonly readme?: string;
		};
		readonly websiteUrl?: string;
		readonly packages?: readonly RawGalleryMcpServerPackage[];
		readonly remotes?: RawGalleryMcpServerRemotes;
		readonly _meta?: {
			readonly 'io.modelcontextprotocol.registry/publisher-provided'?: Record<string, unknown>;
		};
	}

	interface RawGalleryMcpServerInfo {
		readonly server: RawGalleryMcpServer;
		readonly _meta?: {
			readonly 'io.modelcontextprotocol.registry/official'?: {
				readonly status: GalleryMcpServerStatus;
				readonly isLatest: boolean;
				readonly publishedAt: string;
				readonly updatedAt: string;
			};
		};
	}

	interface RawGalleryMcpServersResult {
		readonly metadata?: {
			readonly count: number;
			readonly total?: number;
			readonly next_cursor?: string;
		};
		readonly servers: readonly RawGalleryMcpServerInfo[];
	}

	class Serializer implements IGalleryMcpServerDataSerializer {

		public toRawGalleryMcpServerResult(input: unknown): IRawGalleryMcpServersResult | undefined {
			if (!input || typeof input !== 'object' || !Array.isArray((input as RawGalleryMcpServersResult).servers)) {
				return undefined;
			}

			const from = <RawGalleryMcpServersResult>input;

			const servers: IRawGalleryMcpServer[] = [];
			for (const server of from.servers) {
				const rawServer = this.toRawGalleryMcpServer(server);
				if (!rawServer) {
					return undefined;
				}
				servers.push(rawServer);
			}

			return {
				metadata: from.metadata,
				servers
			};
		}

		public toRawGalleryMcpServer(input: unknown): IRawGalleryMcpServer | undefined {
			if (!input || typeof input !== 'object') {
				return undefined;
			}

			const from = <RawGalleryMcpServerInfo>input;

			if (
				(!from.server || !isObject(from.server))
				|| (!from.server.name || !isString(from.server.name))
				|| (!from.server.description || !isString(from.server.description))
				|| (!from.server.version || !isString(from.server.version))
			) {
				return undefined;
			}

			if (from.server.$schema && from.server.$schema !== McpServerSchemaVersion_v0_1.SCHEMA) {
				return undefined;
			}

			return {
				packages: from.server.packages,
				remotes: from.server.remotes,
			};
		}
	}

	export const SERIALIZER = new Serializer();
}

export namespace McpServerSchemaVersion_v0 {

	export const VERSION = 'v0';

	class Serializer implements IGalleryMcpServerDataSerializer {

		private readonly galleryMcpServerDataSerializers: IGalleryMcpServerDataSerializer[] = [];

		constructor() {
			this.galleryMcpServerDataSerializers.push(McpServerSchemaVersion_v0_1.SERIALIZER);
			this.galleryMcpServerDataSerializers.push(McpServerSchemaVersion_v2025_07_09.SERIALIZER);
		}

		public toRawGalleryMcpServer(input: unknown): IRawGalleryMcpServer | undefined {
			for (const serializer of this.galleryMcpServerDataSerializers) {
				const result = serializer.toRawGalleryMcpServer(input);
				if (result) {
					return result;
				}
			}
			return undefined;
		}
	}

	export const SERIALIZER = new Serializer();
}
