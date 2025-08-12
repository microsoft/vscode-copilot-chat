/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { randomPath } from '../../../util/vs/base/common/extpath';
import { localize } from '../../../util/vs/nls';
import { ValidatePackageErrorType, ValidatePackageResult } from './commands';

interface NuGetServiceIndexResponse {
	resources?: Array<{ "@id": string; "@type": string }>;
}

const NUGET_V3_API_URL = 'https://api.nuget.org/v3/index.json';

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

export async function getNuGetPackageMetadata(id: string, logService: ILogService, dotnet: DotnetCli = { command: 'dotnet', args: [] }): Promise<ValidatePackageResult> {
	// use the home directory, which is the default for MCP servers
	// see https://github.com/microsoft/vscode/issues/259901 for future options
	const cwd = os.homedir();

	// check for .NET CLI version for a quick "is dotnet installed?" check
	let dotnetVersion;
	try {
		dotnetVersion = await getDotnetVersion(cwd, logService, dotnet);
	} catch (error) {
		const errorCode = error.hasOwnProperty('code') ? String((error as any).code) : undefined;
		if (errorCode === 'ENOENT') {
			return {
				state: 'error',
				error: localize("mcp.setup.dotnetNotFound", "The '{0}' command was not found. .NET SDK 10 or newer must be installed and available in PATH.", dotnet.command),
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
	const latest = await getLatestPackageVersion(cwd, id, dotnet);
	if (!latest) {
		return {
			state: 'error',
			errorType: ValidatePackageErrorType.NotFound,
			error: localize("mcp.setup.nugetPackageNotFound", "Package {0} does not exist on NuGet.org.", id)
		};
	}

	// read the package readme from NuGet.org, using the HTTP API
	const readme = await getPackageReadmeFromNuGetOrgAsync(latest.id, latest.version, logService);

	return {
		state: 'ok',
		publisher: latest.owners ?? 'unknown',
		name: latest.id,
		version: latest.version,
		readme,
		getServerManifest: async (installConsent) => {
			// getting the server.json downloads the package, so wait for consent
			await installConsent;
			return await getServerManifest(latest.id, latest.version, logService, dotnet);
		},
	};
}

async function getServerManifest(id: string, version: string, logService: ILogService, dotnet: DotnetCli): Promise<string | undefined> {
	logService.info(`Reading .mcp/server.json from NuGet package ${id}@${version}.`);
	const installDir = randomPath(os.tmpdir(), "vscode-nuget-mcp");
	try {
		// perform a local tool install using the .NET CLI
		// this warms the cache (user packages folder) so dnx will be fast
		// this also makes the server.json available which will be mapped to VS Code MCP config
		await fs.mkdir(installDir, { recursive: true });

		// the cwd must be the install directory or a child directory for local tool install to work
		const cwd = installDir;

		const packagesDir = await getGlobalPackagesPath(id, version, cwd, logService, dotnet);
		if (!packagesDir) { return undefined; }

		// explicitly create a tool manifest in the off chance one already exists in a parent directory
		const createManifestSuccess = await createToolManifest(id, version, cwd, logService, dotnet);
		if (!createManifestSuccess) { return undefined; }

		const localInstallSuccess = await installLocalTool(id, version, cwd, logService, dotnet);
		if (!localInstallSuccess) { return undefined; }

		return await readServerManifest(packagesDir, id, version, logService);
	} catch (e) {
		logService.warn(`
Failed to install NuGet package ${id}@${version}. Proceeding without server.json.
Error: ${e}`);
	} finally {
		try {
			await fs.rm(installDir, { recursive: true, force: true });
		} catch (e) {
			logService.warn(`Failed to clean up temporary .NET tool install directory ${installDir}.
Error: ${e}`);
		}
	}
}

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;
async function executeWithTimeout(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number = 60000,
	expectZeroExitCode: boolean = true,
	cancellationToken?: CancellationToken) {

	return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		let settled = false;

		const child: cp.ChildProcessWithoutNullStreams = cp.spawn(command, args, {
			stdio: "pipe",
			env: { ...process.env },
			cwd: cwd,
		});

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');

		child.stdout.on('data', (data) => stdout.push(data));
		child.stderr.on('data', (data) => stderr.push(data));

		const timeoutHandler = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill('SIGTERM');
				setTimeout(() => {
					if (!child.killed) {
						child.kill('SIGKILL');
					}
				}, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
				reject(new Error(`Process timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);

		const cancellationHandler = cancellationToken?.onCancellationRequested(() => {
			if (!settled) {
				settled = true;
				clearTimeout(timeoutHandler);
				child.kill('SIGTERM');
				setTimeout(() => {
					if (!child.killed) {
						child.kill('SIGKILL');
					}
				}, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
				reject(new Error(`Process cancelled`));
			}
		});

		child.on('error', (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeoutHandler);
				cancellationHandler?.dispose();
				reject(error);
			}
		});

		child.on('close', (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeoutHandler);
				cancellationHandler?.dispose();

				if (expectZeroExitCode && code !== 0) {
					reject(new Error(`Process ${child.pid} (${command}) failed with code ${code}.
stdout: ${stdout.join('')}
stderr: ${stderr.join('')}`));
				} else {
					resolve({
						stdout: stdout.join(''),
						stderr: stderr.join(''),
						exitCode: code ?? -1,
					});
				}
			}
		});
	});
}

async function getDotnetVersion(cwd: string, logService: ILogService, dotnet: DotnetCli): Promise<string> {
	const args = dotnet.args.concat(['--version']);
	const result = await executeWithTimeout(dotnet.command, args, cwd);
	const version = result.stdout.trim();
	if (result.exitCode !== 0 || !version) {
		logService.warn(`Failed to check for .NET version while checking if a NuGet MCP server exists.
stdout: ${result.stdout}
stderr: ${result.stderr}`);
		throw new Error(`Failed to check for .NET version using '${dotnet.command} --version'.`);
	}

	return version;
}

async function getLatestPackageVersion(cwd: string, id: string, dotnet: DotnetCli): Promise<{ id: string; version: string; owners?: string } | undefined> {
	// we use the NuGet.org "packageid:" syntax instead of --exact-match because it returns owner information
	const args = dotnet.args.concat(['package', 'search', `packageid:${id}`, '--source', NUGET_V3_API_URL, '--prerelease', '--format', 'json']);
	const searchResult = await executeWithTimeout(dotnet.command, args, cwd);
	const searchData: DotnetPackageSearchOutput = JSON.parse(searchResult.stdout.trim());
	for (const result of searchData.searchResult ?? []) {
		for (const pkg of result.packages ?? []) {
			if (pkg.id.toUpperCase() === id.toUpperCase()) {
				return { id: pkg.id, version: pkg.latestVersion, owners: pkg.owners };
			}
		}
	}
}

async function getPackageReadmeFromNuGetOrgAsync(id: string, version: string, logService: ILogService): Promise<string | undefined> {
	try {
		// download the service index to locate services
		// https://learn.microsoft.com/en-us/nuget/api/service-index
		const serviceIndexResponse = await fetch(NUGET_V3_API_URL);
		if (serviceIndexResponse.status !== 200) {
			logService.warn(`Unable to read the service index for NuGet.org while fetching readme for ${id}@${version}.
HTTP status: ${serviceIndexResponse.status}`);
			return;
		}

		const serviceIndex = await serviceIndexResponse.json() as NuGetServiceIndexResponse;

		// try to fetch the package readme using the URL template
		// https://learn.microsoft.com/en-us/nuget/api/readme-template-resource
		const readmeTemplate = serviceIndex.resources?.find(resource => resource['@type'] === 'ReadmeUriTemplate/6.13.0')?.['@id'];
		if (!readmeTemplate) {
			logService.warn(`No readme URL template found for ${id}@${version} on NuGet.org.`);
			return;
		}

		const readmeUrl = readmeTemplate
			.replace('{lower_id}', encodeURIComponent(id.toLowerCase()))
			.replace('{lower_version}', encodeURIComponent(version.toLowerCase()));
		const readmeResponse = await fetch(readmeUrl);
		if (readmeResponse.status === 200) {
			return readmeResponse.text();
		} else if (readmeResponse.status === 404) {
			logService.info(`No package readme exists for ${id}@${version} on NuGet.org.`);
		} else {
			logService.warn(`Failed to read package readme for ${id}@${version} from NuGet.org.
HTTP status: ${readmeResponse.status}`);
		}
	} catch (error) {
		logService.warn(`Failed to read package readme for ${id}@${version} from NuGet.org.
Error: ${error}`);
	}
}

async function getGlobalPackagesPath(id: string, version: string, cwd: string, logService: ILogService, dotnet: DotnetCli): Promise<string | undefined> {
	const args = dotnet.args.concat(['nuget', 'locals', 'global-packages', '--list', '--force-english-output']);
	const globalPackagesResult = await executeWithTimeout(dotnet.command, args, cwd);

	if (globalPackagesResult.exitCode !== 0) {
		logService.warn(`Failed to discover the NuGet global packages folder. Proceeding without server.json for ${id}@${version}.
stdout: ${globalPackagesResult.stdout}
stderr: ${globalPackagesResult.stderr}`);
		return undefined;
	}

	// output looks like:
	// global-packages: C:\Users\username\.nuget\packages\
	return globalPackagesResult.stdout.trim().split(' ', 2).at(-1)?.trim();
}

async function createToolManifest(id: string, version: string, cwd: string, logService: ILogService, dotnet: DotnetCli): Promise<boolean> {
	const args = dotnet.args.concat(['new', 'tool-manifest']);
	const result = await executeWithTimeout(dotnet.command, args, cwd);

	if (result.exitCode !== 0) {
		logService.warn(`Failed to create tool manifest.Proceeding without server.json for ${id}@${version}.
stdout: ${result.stdout}
stderr: ${result.stderr}`);
		return false;
	}

	return true;
}

async function installLocalTool(id: string, version: string, cwd: string, logService: ILogService, dotnet: DotnetCli): Promise<boolean> {
	const args = dotnet.args.concat(["tool", "install", `${id}@${version}`, "--source", NUGET_V3_API_URL, "--local", "--create-manifest-if-needed"]);
	const installResult = await executeWithTimeout(dotnet.command, args, cwd);

	if (installResult.exitCode !== 0) {
		logService.warn(`Failed to install local tool ${id} @${version}. Proceeding without server.json for ${id}@${version}.
stdout: ${installResult.stdout}
stderr: ${installResult.stderr}`);
		return false;
	}

	return true;
}

async function readServerManifest(packagesDir: string, id: string, version: string, logService: ILogService): Promise<string | undefined> {
	const serverJsonPath = path.join(packagesDir, id.toLowerCase(), version.toLowerCase(), ".mcp", "server.json");
	try {
		await fs.access(serverJsonPath, fs.constants.R_OK);
	} catch {
		logService.info(`No server.json found at ${serverJsonPath}. Proceeding without server.json for ${id}@${version}.`);
		return undefined;
	}

	const json = await fs.readFile(serverJsonPath, 'utf8');
	const manifest = JSON.parse(json);

	// Force the ID and version of matching NuGet package in the server.json to the one we installed.
	// This handles cases where the server.json in the package is stale.
	// The ID should match generally, but we'll protect against unexpected package IDs.
	if (manifest?.packages) {
		for (const pkg of manifest.packages) {
			if (pkg?.registry_name === "nuget") {
				if (pkg.name.toUpperCase() !== id.toUpperCase()) {
					logService.warn(`Package ID mismatch in NuGet.mcp / server.json: expected ${id}, found ${pkg.name}.`);
				}
				if (pkg.version.toUpperCase() !== version.toUpperCase()) {
					logService.warn(`Package version mismatch in NuGet.mcp / server.json: expected ${version}, found ${pkg.version}.`);
				}

				pkg.name = id;
				pkg.version = version;
			}
		}
	}

	return manifest;
}
