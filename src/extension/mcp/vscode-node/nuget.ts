/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { randomPath } from '../../../util/vs/base/common/extpath';
import { localize } from '../../../util/vs/nls';
import { ValidatePackageErrorType, ValidatePackageResult } from './commands';
import { CommandExecutor, ICommandExecutor } from './util';

interface NuGetServiceIndexResponse {
	resources?: Array<{ "@id": string; "@type": string }>;
}

interface DotnetPackageSearchOutput {
	searchResult?: Array<SourceResult>;
}

interface SourceResult {
	sourceName: string;
	packages?: Array<LatestPackageResult>;
}

interface LatestPackageResult {
	id: string;
	latestVersion: string;
	owners?: string;
}

interface DotnetCli {
	command: string;
	args: Array<string>;
}

const MCP_SERVER_SCHEMA_2025_07_09_GH = "https://modelcontextprotocol.io/schemas/draft/2025-07-09/server.json";
const MCP_SERVER_SCHEMA_2025_07_09 = "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json";
const MCP_SERVER_SCHEMA_2025_09_29 = "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json";

export class NuGetMcpSetup {
	constructor(
		public readonly logService: ILogService,
		public readonly fetcherService: IFetcherService,

		public readonly commandExecutor: ICommandExecutor = new CommandExecutor(),

		public readonly dotnet: DotnetCli = { command: 'dotnet', args: [] },

		// use NuGet.org central registry
		// see https://github.com/microsoft/vscode/issues/259901 for future options
		public readonly source: string = 'https://api.nuget.org/v3/index.json'
	) { }

	async getNuGetPackageMetadata(id: string): Promise<ValidatePackageResult> {
		// use the home directory, which is the default for MCP servers
		// see https://github.com/microsoft/vscode/issues/259901 for future options
		const cwd = os.homedir();

		// check for .NET CLI version for a quick "is dotnet installed?" check
		let dotnetVersion;
		try {
			dotnetVersion = await this.getDotnetVersion(cwd);
		} catch (error) {
			const errorCode = error.hasOwnProperty('code') ? String((error as any).code) : undefined;
			if (errorCode === 'ENOENT') {
				return {
					state: 'error',
					error: localize("mcp.setup.dotnetNotFound", "The '{0}' command was not found. .NET SDK 10 or newer must be installed and available in PATH.", this.dotnet.command),
					errorType: ValidatePackageErrorType.MissingCommand,
					helpUri: 'https://aka.ms/vscode-mcp-install/dotnet',
					helpUriLabel: localize("mcp.setup.installDotNetSdk", "Install .NET SDK"),
				};
			} else {
				throw error;
			}
		}

		// dnx is used for running .NET MCP servers and it was shipped with .NET 10
		const dotnetMajorVersion = parseInt(dotnetVersion.split('.')[0]);
		if (dotnetMajorVersion < 10) {
			return {
				state: 'error',
				error: localize("mcp.setup.badDotnetSdkVersion", "The installed .NET SDK must be version 10 or newer. Found {0}.", dotnetVersion),
				errorType: ValidatePackageErrorType.BadCommandVersion,
				helpUri: 'https://aka.ms/vscode-mcp-install/dotnet',
				helpUriLabel: localize("mcp.setup.installDotNetSdk", "Update .NET SDK"),
			};
		}

		// check if the package exists, using .NET CLI
		const latest = await this.getLatestPackageVersion(cwd, id);
		if (!latest) {
			return {
				state: 'error',
				errorType: ValidatePackageErrorType.NotFound,
				error: localize("mcp.setup.nugetPackageNotFound", "Package {0} does not exist on NuGet.org.", id)
			};
		}

		// read the package readme from NuGet.org, using the HTTP API
		const readme = await this.getPackageReadmeFromNuGetOrgAsync(latest.id, latest.version);

		return {
			state: 'ok',
			publisher: latest.owners ?? 'unknown',
			name: latest.id,
			version: latest.version,
			readme,
			getServerManifest: async (installConsent) => {
				// getting the server.json downloads the package, so wait for consent
				await installConsent;
				return await this.getServerManifest(latest.id, latest.version);
			},
		};
	}

	async getServerManifest(id: string, version: string): Promise<string | undefined> {
		this.logService.info(`Reading .mcp/server.json from NuGet package ${id}@${version}.`);
		const installDir = randomPath(os.tmpdir(), "vscode-nuget-mcp");
		try {
			// perform a local tool install using the .NET CLI
			// this warms the cache (user packages folder) so dnx will be fast
			// this also makes the server.json available which will be mapped to VS Code MCP config
			await fs.mkdir(installDir, { recursive: true });

			// the cwd must be the install directory or a child directory for local tool install to work
			const cwd = installDir;

			const packagesDir = await this.getGlobalPackagesPath(id, version, cwd);
			if (!packagesDir) { return undefined; }

			// explicitly create a tool manifest in the off chance one already exists in a parent directory
			const createManifestSuccess = await this.createToolManifest(id, version, cwd);
			if (!createManifestSuccess) { return undefined; }

			const localInstallSuccess = await this.installLocalTool(id, version, cwd);
			if (!localInstallSuccess) { return undefined; }

			return await this.readServerManifest(packagesDir, id, version);
		} catch (e) {
			this.logService.warn(`
Failed to install NuGet package ${id}@${version}. Proceeding without server.json.
Error: ${e}`);
		} finally {
			try {
				await fs.rm(installDir, { recursive: true, force: true });
			} catch (e) {
				this.logService.warn(`Failed to clean up temporary .NET tool install directory ${installDir}.
Error: ${e}`);
			}
		}
	}

	async getDotnetVersion(cwd: string): Promise<string> {
		const args = this.dotnet.args.concat(['--version']);
		const result = await this.commandExecutor.executeWithTimeout(this.dotnet.command, args, cwd);
		const version = result.stdout.trim();
		if (result.exitCode !== 0 || !version) {
			this.logService.warn(`Failed to check for .NET version while checking if a NuGet MCP server exists.
stdout: ${result.stdout}
stderr: ${result.stderr}`);
			throw new Error(`Failed to check for .NET version using '${this.dotnet.command} --version'.`);
		}

		return version;
	}

	async getLatestPackageVersion(cwd: string, id: string): Promise<{ id: string; version: string; owners?: string } | undefined> {
		// we don't use --exact-match here because it does not return owner information on NuGet.org
		const args = this.dotnet.args.concat(['package', 'search', id, '--source', this.source, '--prerelease', '--format', 'json']);
		const searchResult = await this.commandExecutor.executeWithTimeout(this.dotnet.command, args, cwd);
		const searchData: DotnetPackageSearchOutput = JSON.parse(searchResult.stdout.trim());
		for (const result of searchData.searchResult ?? []) {
			for (const pkg of result.packages ?? []) {
				if (pkg.id.toUpperCase() === id.toUpperCase()) {
					return { id: pkg.id, version: pkg.latestVersion, owners: pkg.owners };
				}
			}
		}
	}

	async getPackageReadmeFromNuGetOrgAsync(id: string, version: string): Promise<string | undefined> {
		try {
			const sourceUrl = URL.parse(this.source);
			if (sourceUrl?.protocol !== 'https:' || !sourceUrl.pathname.endsWith('.json')) {
				this.logService.warn(`NuGet package source is not an HTTPS V3 source URL. Cannot fetch a readme for ${id}@${version}.`);
				return;
			}

			// download the service index to locate services
			// https://learn.microsoft.com/en-us/nuget/api/service-index
			const serviceIndexResponse = await this.fetcherService.fetch(this.source, { method: 'GET' });
			if (serviceIndexResponse.status !== 200) {
				this.logService.warn(`Unable to read the service index for NuGet.org while fetching readme for ${id}@${version}.
HTTP status: ${serviceIndexResponse.status}`);
				return;
			}

			const serviceIndex = await serviceIndexResponse.json() as NuGetServiceIndexResponse;

			// try to fetch the package readme using the URL template
			// https://learn.microsoft.com/en-us/nuget/api/readme-template-resource
			const readmeTemplate = serviceIndex.resources?.find(resource => resource['@type'] === 'ReadmeUriTemplate/6.13.0')?.['@id'];
			if (!readmeTemplate) {
				this.logService.warn(`No readme URL template found for ${id}@${version} on NuGet.org.`);
				return;
			}

			const readmeUrl = readmeTemplate
				.replace('{lower_id}', encodeURIComponent(id.toLowerCase()))
				.replace('{lower_version}', encodeURIComponent(version.toLowerCase()));
			const readmeResponse = await this.fetcherService.fetch(readmeUrl, { method: 'GET' });
			if (readmeResponse.status === 200) {
				return readmeResponse.text();
			} else if (readmeResponse.status === 404) {
				this.logService.info(`No package readme exists for ${id}@${version} on NuGet.org.`);
			} else {
				this.logService.warn(`Failed to read package readme for ${id}@${version} from NuGet.org.
HTTP status: ${readmeResponse.status}`);
			}
		} catch (error) {
			this.logService.warn(`Failed to read package readme for ${id}@${version} from NuGet.org.
Error: ${error}`);
		}
	}

	async getGlobalPackagesPath(id: string, version: string, cwd: string): Promise<string | undefined> {
		const args = this.dotnet.args.concat(['nuget', 'locals', 'global-packages', '--list', '--force-english-output']);
		const globalPackagesResult = await this.commandExecutor.executeWithTimeout(this.dotnet.command, args, cwd);

		if (globalPackagesResult.exitCode !== 0) {
			this.logService.warn(`Failed to discover the NuGet global packages folder. Proceeding without server.json for ${id}@${version}.
stdout: ${globalPackagesResult.stdout}
stderr: ${globalPackagesResult.stderr}`);
			return undefined;
		}

		// output looks like:
		// global-packages: C:\Users\username\.nuget\packages\
		return globalPackagesResult.stdout.trim().split(' ', 2).at(-1)?.trim();
	}

	async createToolManifest(id: string, version: string, cwd: string): Promise<boolean> {
		const args = this.dotnet.args.concat(['new', 'tool-manifest']);
		const result = await this.commandExecutor.executeWithTimeout(this.dotnet.command, args, cwd);

		if (result.exitCode !== 0) {
			this.logService.warn(`Failed to create tool manifest.Proceeding without server.json for ${id}@${version}.
stdout: ${result.stdout}
stderr: ${result.stderr}`);
			return false;
		}

		return true;
	}

	async installLocalTool(id: string, version: string, cwd: string): Promise<boolean> {
		const args = this.dotnet.args.concat(["tool", "install", `${id}@${version}`, "--source", this.source, "--local", "--create-manifest-if-needed"]);
		const installResult = await this.commandExecutor.executeWithTimeout(this.dotnet.command, args, cwd);

		if (installResult.exitCode !== 0) {
			this.logService.warn(`Failed to install local tool ${id} @${version}. Proceeding without server.json for ${id}@${version}.
stdout: ${installResult.stdout}
stderr: ${installResult.stderr}`);
			return false;
		}

		return true;
	}

	prepareServerJson(manifest: any, id: string, version: string): any {
		// Force the ID and version of matching NuGet package in the server.json to the one we installed.
		// This handles cases where the server.json in the package is stale.
		// The ID should match generally, but we'll protect against unexpected package IDs.
		// We handle old and new schema formats:
		// - https://modelcontextprotocol.io/schemas/draft/2025-07-09/server.json (only hosted in GitHub)
		// - https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json (had several breaking changes over time)
		// - https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json
		if (manifest?.packages) {
			for (const pkg of manifest.packages) {
				if (!pkg) { continue; }
				const registryType = pkg.registryType ?? pkg.registry_type ?? pkg.registry_name;
				if (registryType === "nuget") {
					if (pkg.name && pkg.name !== id) {
						this.logService.warn(`Package name mismatch in NuGet.mcp / server.json: expected ${id}, found ${pkg.name}.`);
						pkg.name = id;
					}

					if (pkg.identifier && pkg.identifier !== id) {
						this.logService.warn(`Package identifier mismatch in NuGet.mcp / server.json: expected ${id}, found ${pkg.identifier}.`);
						pkg.identifier = id;
					}

					if (pkg.version !== version) {
						this.logService.warn(`Package version mismatch in NuGet.mcp / server.json: expected ${version}, found ${pkg.version}.`);
						pkg.version = version;
					}
				}
			}
		}

		// the original .NET MCP server project template used a schema URL that is deprecated
		if (manifest["$schema"] === MCP_SERVER_SCHEMA_2025_07_09_GH) {
			manifest["$schema"] = MCP_SERVER_SCHEMA_2025_07_09;
		}

		if (manifest["$schema"] !== MCP_SERVER_SCHEMA_2025_07_09
			&& manifest["$schema"] !== MCP_SERVER_SCHEMA_2025_09_29) {
			this.logService.info(`NuGet package server.json has unrecognized schema version: '${manifest["$schema"]}'.`);
		}

		// provide empty publisher provided metadata to enable VS Code data mapping
		if (!manifest["_meta"]) {
			manifest["_meta"] = {};
		}

		// starting from 2025-09-29, the server.json schema root was changed to have a "server" property
		if (manifest["$schema"] === MCP_SERVER_SCHEMA_2025_09_29) {
			manifest = { server: manifest };
		}

		// provide empty registry metadata to enable VS Code data mapping
		if (!manifest["_meta"]) {
			manifest["_meta"] = {};
		}

		if (!manifest["_meta"]["io.modelcontextprotocol.registry/official"]) {
			manifest["_meta"]["io.modelcontextprotocol.registry/official"] = {};
		}

		return manifest;
	}

	async readServerManifest(packagesDir: string, id: string, version: string): Promise<string | undefined> {
		const serverJsonPath = path.join(packagesDir, id.toLowerCase(), version.toLowerCase(), ".mcp", "server.json");
		try {
			await fs.access(serverJsonPath, fs.constants.R_OK);
		} catch {
			this.logService.info(`No server.json found at ${serverJsonPath}. Proceeding without server.json for ${id}@${version}.`);
			return undefined;
		}

		const json = await fs.readFile(serverJsonPath, 'utf8');
		let manifest;
		try {
			manifest = JSON.parse(json);
		} catch {
			this.logService.warn(`Invalid JSON in NuGet package server.json at ${serverJsonPath}. Proceeding without server.json for ${id}@${version}.`);
			return undefined;
		}
		if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
			this.logService.warn(`Invalid JSON in NuGet package server.json at ${serverJsonPath}. Proceeding without server.json for ${id}@${version}.`);
			return undefined;
		}

		return this.prepareServerJson(manifest, id, version);
	}
}
