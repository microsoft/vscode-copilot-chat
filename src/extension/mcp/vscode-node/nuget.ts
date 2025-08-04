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
import { IValidatePackageArgs, ValidatePackageResult } from './commands';

interface NuGetServiceIndexResponse {
	resources?: Array<{ "@id": string; "@type": string }>;
}

interface NuGetSearchPackageItem {
	id: string;
	version: string;
	description?: string;
	owners?: Array<string>;
	packageTypes?: Array<{ "name": string }>;
}

interface NuGetSearchResponse {
	data?: Array<NuGetSearchPackageItem>;
}

async function executeWithTimeout(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number = 60000,
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
				}, 10000);
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
				}, 10000);
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
				resolve({
					stdout: stdout.join(''),
					stderr: stderr.join(''),
					exitCode: code ?? -1
				});
			}
		});
	});
}

async function getServerManifest(id: string, version: string, logService: ILogService): Promise<string | undefined> {
	const installDir = randomPath(os.tmpdir(), "vscode-nuget-mcp");
	try {
		await fs.mkdir(installDir, { recursive: true });

		// use the same cwd as local MCP servers
		// this allow any path-based configuration to be consistent
		const cwd = os.homedir();
		const installResult = await executeWithTimeout('dotnet', [
			"tool",
			"install",
			`${id}@${version}`,
			"--tool-path",
			installDir
		], cwd);

		if (installResult.exitCode === 0) {
			const lowerId = id.toLowerCase();
			const lowerVersion = version.toLowerCase();
			const serverJsonPath = path.join(
				installDir,
				".store",
				lowerId,
				lowerVersion,
				lowerId,
				lowerVersion,
				".mcp",
				"server.json");
			try {
				await fs.access(serverJsonPath, fs.constants.R_OK);
			} catch {
				logService.info(`No server.json found in NuGet package ${id}@${version}.`);
				return undefined;
			}
			const json = await fs.readFile(serverJsonPath, 'utf8');
			const manifest = JSON.parse(json);

			// force the ID and version of matching NuGet package in the server.json to the one we installed
			// this handles cases where the server.json in the package is stale
			if (manifest?.packages) {
				for (const pkg of manifest.packages) {
					if (pkg?.registry_name === "nuget") {
						pkg.name = id;
						pkg.version = version;
					}
				}
			}

			return manifest;
		} else {
			logService.warn(`Install of NuGet package ${id}@${version} failed with exit code ${installResult.exitCode}. Proceeding without server.json.
stdout: ${installResult.stdout}
stderr: ${installResult.stderr}`);
		}
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

export async function getNuGetPackageMetadata(args: IValidatePackageArgs, logService: ILogService): Promise<ValidatePackageResult> {
	// read the service index to find the search URL
	// https://learn.microsoft.com/en-us/nuget/api/service-index
	const serviceIndexUrl = `https://api.nuget.org/v3/index.json`;
	const serviceIndexResponse = await fetch(serviceIndexUrl);
	if (!serviceIndexResponse.ok) {
		return { state: 'error', error: `Unable to load the NuGet.org registry service index (${serviceIndexUrl})` };
	}

	// find the search query URL
	// https://learn.microsoft.com/en-us/nuget/api/search-query-service-resource
	const serviceIndex = await serviceIndexResponse.json() as NuGetServiceIndexResponse;
	const searchBaseUrl = serviceIndex.resources?.find(resource => resource['@type'] === 'SearchQueryService/3.5.0')?.['@id'];
	if (!searchBaseUrl) {
		return { state: 'error', error: `Package search URL not found in the NuGet.org registry service index` };
	}

	// search for the package by ID
	// https://learn.microsoft.com/en-us/nuget/consume-packages/finding-and-choosing-packages#search-syntax
	const searchQueryUrl = `${searchBaseUrl}?q=packageid:${encodeURIComponent(args.name)}&prerelease=true&semVerLevel=2.0.0`;
	const searchResponse = await fetch(searchQueryUrl);
	if (!searchResponse.ok) {
		return { state: 'error', error: `Failed to search for ${args.name} in the NuGet.org registry` };
	}
	const data = await searchResponse.json() as NuGetSearchResponse;
	if (!data.data?.[0]) {
		return { state: 'error', errorType: 'NotFound', error: `Package ${args.name} not found on NuGet.org` };
	}

	const name = data.data[0].id ?? args.name;
	let version = data.data[0].version;
	if (version.indexOf('+') !== -1) {
		// NuGet versions can have a + sign for build metadata, we strip it for MCP config and API calls
		// e.g. 1.0.0+build123 -> 1.0.0
		version = version.split('+')[0];
	}

	const publisher = data.data[0].owners ? data.data[0].owners.join(', ') : 'unknown';

	// Try to fetch the package readme
	// https://learn.microsoft.com/en-us/nuget/api/readme-template-resource
	const readmeTemplate = serviceIndex.resources?.find(resource => resource['@type'] === 'ReadmeUriTemplate/6.13.0')?.['@id'];
	let readme = data.data[0].description || undefined;
	if (readmeTemplate) {
		const readmeUrl = readmeTemplate
			.replace('{lower_id}', encodeURIComponent(name.toLowerCase()))
			.replace('{lower_version}', encodeURIComponent(version.toLowerCase()));
		const readmeResponse = await fetch(readmeUrl);
		if (readmeResponse.ok) {
			readme = await readmeResponse.text();
		}
	}

	return {
		state: 'ok',
		publisher,
		name,
		version,
		readme,
		getServerManifest: async (installConsent) => {
			// getting the server.json downloads the package, so wait for consent
			await installConsent;
			return await getServerManifest(name, version, logService);
		},
	};
}