/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as util from 'util';
import * as vscode from 'vscode';

import { RequestType } from '@vscode/copilot-api';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { CAPIClientImpl } from '../../../platform/endpoint/node/capiClientImpl';
import { IEnvService, isScenarioAutomation } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { collectErrorMessages, ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { getRequest, IFetcher } from '../../../platform/networking/common/networking';
import { NodeFetcher } from '../../../platform/networking/node/nodeFetcher';
import { NodeFetchFetcher } from '../../../platform/networking/node/nodeFetchFetcher';
import { ElectronFetcher } from '../../../platform/networking/vscode-node/electronFetcher';
import { FetcherService } from '../../../platform/networking/vscode-node/fetcherServiceImpl';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { createRequestHMAC } from '../../../util/common/crypto';
import { shuffle } from '../../../util/vs/base/common/arrays';
import { timeout } from '../../../util/vs/base/common/async';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../util/vs/platform/instantiation/common/serviceCollection';
import { EXTENSION_ID } from '../../common/constants';

export interface ProxyAgentLog {
	trace(message: string, ...args: any[]): void;
	debug(message: string, ...args: any[]): void;
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(message: string | Error, ...args: any[]): void;
}

export class LoggingActionsContrib {
	constructor(
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IEnvService private envService: IEnvService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@ICAPIClientService private readonly capiClientService: ICAPIClientService,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@ILogService private logService: ILogService,
	) {
		this._context.subscriptions.push(vscode.commands.registerCommand('github.copilot.debug.collectDiagnostics', async () => {
			const document = await vscode.workspace.openTextDocument({ language: 'markdown' });
			const editor = await vscode.window.showTextDocument(document);
			await appendText(editor, `## GitHub Copilot Chat

- Extension Version: ${this.envService.getVersion()} (${this.envService.getBuildType()})
- VS Code: ${this.envService.getEditorInfo().format()}
- OS: ${this.envService.OS}${vscode.env.remoteName ? `
- Remote Name: ${vscode.env.remoteName}` : ''}

## Network

User Settings:
\`\`\`json${getNonDefaultSettings()}
  "github.copilot.advanced.debug.useElectronFetcher": ${this.configurationService.getConfig<boolean>(ConfigKey.Shared.DebugUseElectronFetcher)},
  "github.copilot.advanced.debug.useNodeFetcher": ${this.configurationService.getConfig<boolean>(ConfigKey.Shared.DebugUseNodeFetcher)},
  "github.copilot.advanced.debug.useNodeFetchFetcher": ${this.configurationService.getConfig<boolean>(ConfigKey.Shared.DebugUseNodeFetchFetcher)}
\`\`\`${getProxyEnvVariables()}
`);
			const urls = [
				this.capiClientService.dotcomAPIURL,
				this.capiClientService.capiPingURL,
			];
			const isGHEnterprise = this.capiClientService.dotcomAPIURL !== 'https://api.github.com';
			const timeoutSeconds = 10;
			const electronFetcher = ElectronFetcher.create(this.envService);
			const electronCurrent = !!electronFetcher && this.configurationService.getConfig<boolean>(ConfigKey.Shared.DebugUseElectronFetcher);
			const nodeCurrent = !electronCurrent && this.configurationService.getConfig<boolean>(ConfigKey.Shared.DebugUseNodeFetcher);
			const nodeFetchCurrent = !electronCurrent && !nodeCurrent && this.configurationService.getConfig<boolean>(ConfigKey.Shared.DebugUseNodeFetchFetcher);
			const nodeCurrentFallback = !electronCurrent && !nodeFetchCurrent;
			const activeFetcher = this.fetcherService.getUserAgentLibrary();
			const fetchers = {
				['Electron fetch']: {
					fetcher: electronFetcher,
					current: electronCurrent,
				},
				['Node.js https']: {
					fetcher: new NodeFetcher(this.envService),
					current: nodeCurrent || nodeCurrentFallback,
				},
				['Node.js fetch']: {
					fetcher: new NodeFetchFetcher(this.envService),
					current: nodeFetchCurrent,
				},
			};
			const dnsLookup = util.promisify(dns.lookup);
			for (const url of urls) {
				const authHeaders: Record<string, string> = {};
				if (isGHEnterprise) {
					let token = '';
					if (url === this.capiClientService.dotcomAPIURL) {
						token = this.authService.anyGitHubSession?.accessToken || '';
					} else {
						try {
							token = (await this.authService.getCopilotToken()).token;
						} catch (_err) {
							// Ignore error
							token = '';
						}
					}
					authHeaders['Authorization'] = `Bearer ${token}`;
				}
				const host = new URL(url).hostname;
				await appendText(editor, `\nConnecting to ${url}:\n`);
				for (const family of [4, 6]) {
					await appendText(editor, `- DNS ipv${family} Lookup: `);
					const start = Date.now();
					try {
						const dnsResult = await Promise.race([dnsLookup(host, { family }), timeout(timeoutSeconds * 1000)]);
						if (dnsResult) {
							await appendText(editor, `${dnsResult.address} (${Date.now() - start} ms)\n`);
						} else {
							await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
						}
					} catch (err) {
						await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
					}
				}
				let probeProxyURL: string | undefined;
				const proxyAgent = loadVSCodeModule<any>('@vscode/proxy-agent');
				if (proxyAgent?.resolveProxyURL) {
					await appendText(editor, `- Proxy URL: `);
					const start = Date.now();
					try {
						const proxyURL = await Promise.race([proxyAgent.resolveProxyURL(url), timeoutAfter(timeoutSeconds * 1000)]);
						if (proxyURL === 'timeout') {
							await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
						} else {
							await appendText(editor, `${proxyURL || 'None'} (${Date.now() - start} ms)\n`);
							probeProxyURL = proxyURL;
						}
					} catch (err) {
						await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
					}
				}
				if (proxyAgent?.loadSystemCertificates && probeProxyURL?.startsWith('https:')) {
					const tlsOrig: typeof tls | undefined = (tls as any).__vscodeOriginal;
					if (tlsOrig) {
						await appendText(editor, `- Proxy TLS: `);
						const osCertificates = await loadSystemCertificates(proxyAgent, this.logService);
						if (!osCertificates) {
							await appendText(editor, `(failed to load system certificates) `);
						}
						const start = Date.now();
						try {
							const result = await Promise.race([tlsConnect(tlsOrig, probeProxyURL, [...tls.rootCertificates, ...(osCertificates || [])]), timeout(timeoutSeconds * 1000)]);
							if (result) {
								await appendText(editor, `${result} (${Date.now() - start} ms)\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
						}
					}
				}
				if (probeProxyURL) {
					const httpx: typeof https | typeof http | undefined = probeProxyURL.startsWith('https:') ? (https as any).__vscodeOriginal : (http as any).__vscodeOriginal;
					if (httpx) {
						await appendText(editor, `- Proxy Connection: `);
						const start = Date.now();
						try {
							const result = await Promise.race([proxyConnect(httpx, probeProxyURL, url), timeout(timeoutSeconds * 1000)]);
							if (result) {
								const headers = Object.keys(result.headers).map(header => `\n	${header}: ${result.headers[header]}`);
								const text = `${result.statusCode} ${result.statusMessage}${headers.join('')}`;
								await appendText(editor, `${text} (${Date.now() - start} ms)\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
						}
					}
				}
				for (const [name, fetcher] of Object.entries(fetchers)) {
					await appendText(editor, `- ${name}${fetcher.current ? ' (configured)' : fetcher.fetcher?.getUserAgentLibrary() === activeFetcher ? ' (active)' : ''}: `);
					if (fetcher.fetcher) {
						const start = Date.now();
						try {
							const response = await Promise.race([fetcher.fetcher.fetch(url, { headers: authHeaders }), timeout(timeoutSeconds * 1000)]);
							if (response) {
								await appendText(editor, `HTTP ${response.status} (${Date.now() - start} ms)\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${collectErrorMessages(err)}\n`);
						}
					} else {
						await appendText(editor, 'Unavailable\n');
					}
				}
			}
			await appendText(editor, `
## Documentation

In corporate networks: [Troubleshooting firewall settings for GitHub Copilot](https://docs.github.com/en/copilot/troubleshooting-github-copilot/troubleshooting-firewall-settings-for-github-copilot).`);
		}));
	}
}

async function appendText(editor: vscode.TextEditor, string: string) {
	await editor.edit(builder => {
		builder.insert(editor.document.lineAt(editor.document.lineCount - 1).range.end, string);
	});
}

function timeoutAfter(ms: number) {
	return new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms));
}

function loadVSCodeModule<T>(moduleName: string): T | undefined {
	const appRoot = vscode.env.appRoot;
	try {
		return require(`${appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}
	try {
		return require(`${appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}

async function loadSystemCertificates(proxyAgent: any, logService: ILogService): Promise<(string | Buffer)[] | undefined> {
	try {
		const certificates = await proxyAgent.loadSystemCertificates({
			log: {
				trace(message: string, ..._args: any[]) {
					logService.trace(message);
				},
				debug(message: string, ..._args: any[]) {
					logService.debug(message);
				},
				info(message: string, ..._args: any[]) {
					logService.info(message);
				},
				warn(message: string, ..._args: any[]) {
					logService.warn(message);
				},
				error(message: string | Error, ..._args: any[]) {
					logService.error(typeof message === 'string' ? message : String(message));
				},
			} satisfies ProxyAgentLog
		});
		return Array.isArray(certificates) ? certificates : undefined;
	} catch (err) {
		logService.error(err);
		return undefined;
	}
}

async function tlsConnect(tlsOrig: typeof tls, proxyURL: string, ca: (string | Buffer)[]) {
	return new Promise<string>((resolve, reject) => {
		const proxyUrlObj = new URL(proxyURL);
		const socket = tlsOrig.connect({
			host: proxyUrlObj.hostname,
			port: parseInt(proxyUrlObj.port, 10),
			servername: proxyUrlObj.hostname,
			ca,
		}, () => {
			socket.end();
			resolve('Succeeded');
		});
		socket.on('error', reject);
	});
}

async function proxyConnect(httpx: typeof https | typeof http, proxyUrl: string, targetUrl: string) {
	return new Promise<{ statusCode: number | undefined; statusMessage: string | undefined; headers: Record<string, string | string[]> }>((resolve, reject) => {
		const proxyUrlObj = new URL(proxyUrl);
		const targetUrlObj = new URL(targetUrl);
		const targetHost = `${targetUrlObj.hostname}:${targetUrlObj.port || (targetUrlObj.protocol === 'https:' ? 443 : 80)}`;
		const options = {
			method: 'CONNECT',
			host: proxyUrlObj.hostname,
			port: proxyUrlObj.port,
			path: targetHost,
			headers: {
				Host: targetHost,
			},
			rejectUnauthorized: false,
		};
		const req = httpx.request(options);
		req.on('connect', (res, socket, head) => {
			const headers = ['proxy-authenticate', 'proxy-agent', 'server', 'via'].reduce((acc, header) => {
				if (res.headers[header]) {
					acc[header] = res.headers[header];
				}
				return acc;
			}, {} as Record<string, string | string[]>);
			socket.end();
			resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, headers });
		});
		req.on('error', reject);
		req.end();
	});
}

function getNonDefaultSettings() {
	const configuration = vscode.workspace.getConfiguration();
	return [
		'http.proxy',
		'http.noProxy',
		'http.proxyAuthorization',
		'http.proxyStrictSSL',
		'http.proxySupport',
		'http.electronFetch',
		'http.fetchAdditionalSupport',
		'http.proxyKerberosServicePrincipal',
		'http.systemCertificates',
		'http.experimental.systemCertificatesV2',
	].map(key => {
		const i = configuration.inspect(key);
		const v = configuration.get(key, i?.defaultValue);
		if (v !== i?.defaultValue && !(Array.isArray(v) && Array.isArray(i?.defaultValue) && v.length === 0 && i?.defaultValue.length === 0)) {
			return `\n  "${key}": ${JSON.stringify(v)},`;
		}
		return '';
	}).join('');
}

function getProxyEnvVariables() {
	const res = [];
	const envVars = ['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy'];
	for (const env in process.env) {
		if (envVars.includes(env.toLowerCase())) {
			res.push(`\n- ${env}=${process.env[env]}`);
		}
	}
	return res.length ? `\n\nEnvironment Variables:${res.join('')}` : '';
}

export function collectFetcherTelemetry(accessor: ServicesAccessor, error: any): void {
	const extensionContext = accessor.get(IVSCodeExtensionContext);
	const fetcherService = accessor.get(IFetcherService);
	const envService = accessor.get(IEnvService);
	const telemetryService = accessor.get(ITelemetryService);
	const domainService = accessor.get(IDomainService);
	const logService = accessor.get(ILogService);
	const authService = accessor.get(IAuthenticationService);
	const configurationService = accessor.get(IConfigurationService);
	const expService = accessor.get(IExperimentationService);
	const capiClientService = accessor.get(ICAPIClientService);
	const instantiationService = accessor.get(IInstantiationService);
	if (extensionContext.extensionMode === vscode.ExtensionMode.Test || isScenarioAutomation) {
		return;
	}

	if (!configurationService.getExperimentBasedConfig(ConfigKey.Internal.DebugCollectFetcherTelemetry, expService)) {
		return;
	}

	const now = Date.now();
	const previous = extensionContext.globalState.get<number>('lastCollectFetcherTelemetryTime', 0);
	const isInsiders = vscode.env.appName.includes('Insiders');
	const hours = isInsiders ? 5 : 26;
	if (now - previous < hours * 60 * 60 * 1000) {
		logService.debug(`Refetch model metadata: Skipped.`);
		return;
	}

	(async () => {
		await extensionContext.globalState.update('lastCollectFetcherTelemetryTime', now);

		logService.debug(`Refetch model metadata: Exclude other windows.`);
		const windowUUID = generateUuid();
		await extensionContext.globalState.update('lastCollectFetcherTelemetryUUID', windowUUID);
		await timeout(5000);
		if (extensionContext.globalState.get<string>('lastCollectFetcherTelemetryUUID') !== windowUUID) {
			logService.debug(`Refetch model metadata: Other window won.`);
			return;
		}
		logService.debug(`Refetch model metadata: This window won.`);

		const proxy = await findProxyInfo(capiClientService);

		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		const extKind = (ext ? ext.extensionKind === vscode.ExtensionKind.UI : !vscode.env.remoteName) ? 'local' : 'remote';
		const remoteName = vscode.env.remoteName || 'none';
		const platform = process.platform;
		const originalLibrary = fetcherService.getUserAgentLibrary();
		const originalError = error ? (error.message || 'unknown') : 'none';
		const userAgentLibraryUpdate = (library: string) => JSON.stringify({ extKind, remoteName, platform, library, originalLibrary, originalError, proxy });
		const fetchers = [
			ElectronFetcher.create(envService, userAgentLibraryUpdate),
			new NodeFetchFetcher(envService, userAgentLibraryUpdate),
			new NodeFetcher(envService, userAgentLibraryUpdate),
		].filter(fetcher => fetcher) as IFetcher[];

		// Randomize to offset any order dependency in telemetry.
		shuffle(fetchers);

		for (const fetcher of fetchers) {
			const requestId = generateUuid();
			const copilotToken = (await authService.getCopilotToken()).token;
			const requestStartTime = Date.now();
			const modifiedInstaService = instantiationService.createChild(new ServiceCollection(
				[IFetcherService, new SyncDescriptor(FetcherService, [fetcher])],
			));
			try {
				const modifiedCapiClientService = modifiedInstaService.createInstance(CAPIClientImpl);
				const response = await getRequest(
					fetcher,
					envService,
					telemetryService,
					domainService,
					modifiedCapiClientService,
					{ type: RequestType.Models },
					copilotToken,
					await createRequestHMAC(process.env.HMAC_SECRET),
					'model-access',
					requestId,
				);

				if (response.status < 200 || response.status >= 300) {
					await response.text();
				} else {
					await response.json();
				}

				logService.info(`Refetch model metadata: Succeeded in ${Date.now() - requestStartTime}ms ${requestId} (${response.headers.get('x-github-request-id')}) using ${fetcher.getUserAgentLibrary()} with status ${response.status}.`);
			} catch (e) {
				logService.info(`Refetch model metadata: Failed in ${Date.now() - requestStartTime}ms ${requestId} using ${fetcher.getUserAgentLibrary()}.`);
			} finally {
				modifiedInstaService.dispose();
			}
		}
	})().catch(err => {
		logService.error(err);
	});
}

async function findProxyInfo(capiClientService: ICAPIClientService) {
	const timeoutSeconds = 5;
	let proxy: { status: string;[key: string]: any };
	try {
		const proxyAgent = loadVSCodeModule<any>('@vscode/proxy-agent');
		if (proxyAgent?.resolveProxyURL) {
			const url = capiClientService.capiPingURL; // Assuming this gets the same proxy as for the models request.
			const proxyURL = await Promise.race([proxyAgent.resolveProxyURL(url), timeoutAfter(timeoutSeconds * 1000)]);
			if (proxyURL === 'timeout') {
				proxy = { status: 'resolveProxyURL timeut' };
			} else if (proxyURL) {
				const httpx: typeof https | typeof http | undefined = proxyURL.startsWith('https:') ? (https as any).__vscodeOriginal : (http as any).__vscodeOriginal;
				if (httpx) {
					const result = await Promise.race([proxyConnect(httpx, proxyURL, url), timeout(timeoutSeconds * 1000)]);
					if (result) {
						proxy = { status: 'success', ...result };
					} else {
						proxy = { status: 'proxyConnect timeout' };
					}
				} else {
					proxy = { status: 'no original http/s module' };
				}
			} else {
				proxy = { status: 'no proxy' };
			}
		} else {
			proxy = { status: 'no resolveProxyURL' };
		}
	} catch (err) {
		proxy = { status: 'error', message: err?.message };
	}
	return proxy;
}
