/*---------------------------------------------------------------------------------------------
 *  Copyright (c) David Khachaturov. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { BridgeConversationProvider, BridgeConversationStatus, BridgeConversationSummary, BridgeServer } from '../../../platform/bridge/bridgeServer';
import { ConversationBridge } from '../../../platform/bridge/conversationBridge';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { IConversationStore } from '../../conversationStore/node/conversationStore';

const showSidecarPanelCommandId = 'github.copilot.sidecar.showPanel';
const pwaUrlStorageKey = 'sidecar.pwaUrl';
const defaultPwaUrl = 'https://davidobot.net/vscode-copilot-chat-sidecar/';
const pwaDevUrlEnvVar = 'COPILOT_PWA_DEV_URL';
const devTunnelDomainSuffix = '.devtunnels.ms';
const devTunnelInstallUrl = 'https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started';
const devTunnelExecutableName = 'devtunnel';
const devTunnelStartupTimeoutMs = 15000;
const devTunnelOutputBufferLimit = 16000;
const bridgeEndpointProbeTimeoutMs = 4000;
const bridgeEndpointProbeMaxBodyBytes = 12000;
const bridgeEndpointProbeSignature = 'Copilot Sidecar Bridge';
const devTunnelUrlPattern = /https?:\/\/[^\s"'<>`]+/g;

type DevTunnelHostAttemptResult = {
	readonly uri: vscode.Uri | undefined;
	readonly failureReason: string | undefined;
};

type SidecarState = 'disconnected' | 'starting' | 'ready';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function createNonce(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function isLoopbackHost(host: string | undefined): boolean {
	if (!host) {
		return false;
	}

	const normalizedHost = host.trim().toLowerCase();
	return normalizedHost === 'localhost' || normalizedHost === '127.0.0.1' || normalizedHost === '::1' || normalizedHost === '[::1]';
}

function isDevTunnelsHost(host: string | undefined): boolean {
	if (!host) {
		return false;
	}

	const normalizedHost = host.trim().toLowerCase();
	return normalizedHost === 'devtunnels.ms' || normalizedHost.endsWith(devTunnelDomainSuffix);
}

function isPublicTunnelUri(uri: vscode.Uri): boolean {
	const host = getUriHostname(uri);
	if (!host || isLoopbackHost(host)) {
		return false;
	}

	return true;
}

function isDevTunnelCliMissingReason(reason: string | undefined): boolean {
	if (!reason) {
		return false;
	}

	const normalizedReason = reason.toLowerCase();
	return normalizedReason.includes('enoent')
		|| normalizedReason.includes('not installed')
		|| normalizedReason.includes('not available on path')
		|| normalizedReason.includes('command not found');
}

function getUriHostname(uri: vscode.Uri): string | undefined {
	try {
		return new URL(uri.toString(true)).hostname;
	} catch {
		return undefined;
	}
}

function getUriPort(uri: vscode.Uri): number | undefined {
	try {
		const parsed = new URL(uri.toString(true));
		const parsedPort = Number.parseInt(parsed.port, 10);
		return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : undefined;
	} catch {
		return undefined;
	}
}

class ChatSessionSourceRegistry extends Disposable {
	private readonly providersByType = new Map<string, vscode.ChatSessionItemProvider>();
	private readonly controllersByType = new Map<string, vscode.ChatSessionItemController>();
	private readonly originalRegisterProvider = vscode.chat.registerChatSessionItemProvider.bind(vscode.chat);
	private readonly originalCreateController = vscode.chat.createChatSessionItemController.bind(vscode.chat);

	constructor(
		private readonly logService: ILogService,
	) {
		super();
		this.patchRegistrationApis();
	}

	private patchRegistrationApis(): void {
		const chatApi = vscode.chat as {
			registerChatSessionItemProvider: typeof vscode.chat.registerChatSessionItemProvider;
			createChatSessionItemController: typeof vscode.chat.createChatSessionItemController;
		};

		try {
			chatApi.registerChatSessionItemProvider = (chatSessionType, provider) => {
				this.providersByType.set(chatSessionType, provider);
				const registration = this.originalRegisterProvider(chatSessionType, provider);
				return toDisposable(() => {
					if (this.providersByType.get(chatSessionType) === provider) {
						this.providersByType.delete(chatSessionType);
					}

					registration.dispose();
				});
			};

			chatApi.createChatSessionItemController = (chatSessionType, refreshHandler) => {
				const controller = this.originalCreateController(chatSessionType, refreshHandler);

				const proxy = new Proxy(controller, {
					get: (target, prop, receiver) => {
						if (prop === 'dispose') {
							return () => {
								if (this.controllersByType.get(chatSessionType) === proxy) {
									this.controllersByType.delete(chatSessionType);
								}
								target.dispose();
							};
						}
						const value = Reflect.get(target, prop, receiver);
						return typeof value === 'function' ? value.bind(target) : value;
					}
				});

				this.controllersByType.set(chatSessionType, proxy);
				return proxy;
			};

			this._register(toDisposable(() => {
				chatApi.registerChatSessionItemProvider = this.originalRegisterProvider;
				chatApi.createChatSessionItemController = this.originalCreateController;
			}));
		} catch (error) {
			this.logService.warn(`[Sidecar] Failed to patch chat session provider registration APIs: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async listSummaries(): Promise<readonly BridgeConversationSummary[]> {
		const summaries = new Map<string, BridgeConversationSummary>();
		const upsert = (summary: BridgeConversationSummary): void => {
			const existing = summaries.get(summary.id);
			if (!existing || summary.lastUpdated > existing.lastUpdated) {
				summaries.set(summary.id, summary);
			}
		};

		for (const [chatSessionType, controller] of this.controllersByType) {
			try {
				await controller.refreshHandler(CancellationToken.None);
			} catch (error) {
				this.logService.trace(`[Sidecar] Failed to refresh controller items for ${chatSessionType}: ${error instanceof Error ? error.message : String(error)}`);
			}

			for (const [, item] of controller.items) {
				const summary = this.toSummary(chatSessionType, item);
				if (summary) {
					upsert(summary);
				}
			}
		}

		for (const [chatSessionType, provider] of this.providersByType) {
			let items: readonly vscode.ChatSessionItem[] = [];
			try {
				const provided = await provider.provideChatSessionItems(CancellationToken.None);
				items = Array.isArray(provided) ? provided : [];
			} catch (error) {
				this.logService.trace(`[Sidecar] Failed to read provider items for ${chatSessionType}: ${error instanceof Error ? error.message : String(error)}`);
			}

			for (const item of items) {
				const summary = this.toSummary(chatSessionType, item);
				if (summary) {
					upsert(summary);
				}
			}
		}

		return Array.from(summaries.values());
	}

	private toSummary(chatSessionType: string, item: vscode.ChatSessionItem): BridgeConversationSummary | undefined {
		const title = item.label.trim();
		if (title.length === 0) {
			return undefined;
		}

		const resourcePath = item.resource.path.replace(/^\/+/, '').trim();
		const id = resourcePath.length > 0 ? resourcePath : item.resource.toString(true);
		return {
			id,
			title,
			lastUpdated: this.lastUpdatedFromItem(item),
			provider: this.providerFromSessionType(chatSessionType, item),
			status: this.statusFromSessionItem(item),
		};
	}

	private lastUpdatedFromItem(item: vscode.ChatSessionItem): number {
		const timing = item.timing;
		if (timing?.lastRequestEnded && timing.lastRequestEnded > 0) {
			return timing.lastRequestEnded;
		}

		if (timing?.lastRequestStarted && timing.lastRequestStarted > 0) {
			return timing.lastRequestStarted;
		}

		if (timing?.endTime && timing.endTime > 0) {
			return timing.endTime;
		}

		if (timing?.startTime && timing.startTime > 0) {
			return timing.startTime;
		}

		if (timing?.created && timing.created > 0) {
			return timing.created;
		}

		return Date.now();
	}

	private providerFromSessionType(chatSessionType: string, item: vscode.ChatSessionItem): BridgeConversationProvider {
		const normalizedType = chatSessionType.toLowerCase();
		if (normalizedType === 'copilotcli') {
			return 'copilot-cli';
		}

		if (normalizedType === 'copilot-cloud-agent' || normalizedType.includes('cloud')) {
			return 'cloud';
		}

		if (normalizedType === 'claude-code' || normalizedType.includes('claude')) {
			return 'claude';
		}

		if (normalizedType.includes('codex')) {
			return 'codex';
		}

		const metadata = isRecord(item.metadata) ? item.metadata : undefined;
		if (typeof metadata?.provider === 'string') {
			const provider = metadata.provider.toLowerCase();
			if (provider === 'copilot-cli' || provider === 'copilotcli') {
				return 'copilot-cli';
			}
			if (provider === 'cloud' || provider === 'copilot-cloud-agent') {
				return 'cloud';
			}
			if (provider === 'claude' || provider === 'claude-code') {
				return 'claude';
			}
			if (provider === 'codex') {
				return 'codex';
			}
		}

		return 'unknown';
	}

	private statusFromSessionItem(item: vscode.ChatSessionItem): BridgeConversationStatus {
		if (item.archived) {
			return 'archived';
		}

		switch (item.status) {
			case vscode.ChatSessionStatus.Completed:
				return 'completed';
			case vscode.ChatSessionStatus.Failed:
				return 'failed';
			case vscode.ChatSessionStatus.InProgress:
				return 'in-progress';
			case vscode.ChatSessionStatus.NeedsInput:
				return 'input-needed';
			default:
				return 'unknown';
		}
	}
}

export class SidecarContribution extends Disposable implements IExtensionContribution {
	readonly id = 'sidecarContribution';
	readonly activationBlocker: Promise<void>;

	private readonly bridgeServer = this._register(new BridgeServer());
	private readonly sessionSourceRegistry: ChatSessionSourceRegistry;
	private readonly conversationBridge: ConversationBridge;
	private tunnelUri: vscode.Uri | undefined;
	private statusBarItem: vscode.StatusBarItem | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private sidecarState: SidecarState = 'disconnected';
	private startPromise: Promise<void> | undefined;
	private hasRegisteredBridgeListeners = false;
	private devTunnelHostProcess: ChildProcessWithoutNullStreams | undefined;

	constructor(
		@IConversationStore conversationStore: IConversationStore,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
		@IFileSystemService fileSystemService: IFileSystemService,
	) {
		super();
		this._register(toDisposable(() => {
			this.stopDevTunnelHost();
		}));
		this.sessionSourceRegistry = this._register(new ChatSessionSourceRegistry(this.logService));
		this.conversationBridge = this._register(new ConversationBridge(
			this.bridgeServer,
			conversationStore,
			this.logService,
			fileSystemService,
			this.extensionContext,
			() => this.sessionSourceRegistry.listSummaries(),
		));
		this.registerUi();
		this.activationBlocker = Promise.resolve();
	}

	private async startSidecar(): Promise<void> {
		if (this.tunnelUri) {
			return;
		}

		if (this.startPromise) {
			return this.startPromise;
		}

		this.sidecarState = 'starting';
		this.updateStatusBar();

		this.startPromise = this.doStartSidecar().finally(() => {
			this.startPromise = undefined;
		});

		return this.startPromise;
	}

	private async doStartSidecar(): Promise<void> {
		try {
			this.stopDevTunnelHost();
			const port = await this.bridgeServer.start();
			const localBridgeUri = vscode.Uri.parse(`http://localhost:${port}`);
			this.tunnelUri = await this.resolveDevTunnelUri(localBridgeUri);
			this.conversationBridge.activate();
			if (!this.hasRegisteredBridgeListeners) {
				this._register(this.bridgeServer.onDidClientCountChange(() => {
					this.updateStatusBar();
					void this.refreshPanel();
				}));
				this.hasRegisteredBridgeListeners = true;
			}

			this.sidecarState = 'ready';
			this.updateStatusBar();
			this.logService.info(`[Sidecar] bridge ready at ${this.tunnelUri.toString(true)}`);
		} catch (error) {
			this.stopDevTunnelHost();
			this.sidecarState = 'disconnected';
			this.updateStatusBar();
			this.logService.error(error, '[Sidecar] failed to initialize bridge');
			throw error;
		}
	}

	private async resolveDevTunnelUri(localBridgeUri: vscode.Uri): Promise<vscode.Uri> {
		const initialResolution = await vscode.env.asExternalUri(localBridgeUri);
		if (await this.isBridgeEndpointUsable(initialResolution, 'vscode.env.asExternalUri')) {
			return initialResolution;
		}

		const autoResolved = await this.tryBootstrapDevTunnel(localBridgeUri);
		if (autoResolved) {
			return autoResolved;
		}

		throw new Error(`Sidecar requires a Dev Tunnel endpoint (*.devtunnels.ms). Resolved bridge URI was ${initialResolution.toString(true)}.`);
	}

	private async tryBootstrapDevTunnel(localBridgeUri: vscode.Uri): Promise<vscode.Uri | undefined> {
		const directHostAttempt = await this.tryStartDirectDevTunnelHost(localBridgeUri);
		if (directHostAttempt.uri) {
			return directHostAttempt.uri;
		}

		if (directHostAttempt.failureReason) {
			if (isDevTunnelCliMissingReason(directHostAttempt.failureReason)) {
				void this.showDevTunnelInstallPrompt(directHostAttempt.failureReason).catch(error => {
					this.logService.warn(`[Sidecar] Failed to show devtunnel install prompt: ${error instanceof Error ? error.message : String(error)}`);
				});
			} else {
				void this.showDevTunnelStartupWarning(directHostAttempt.failureReason).catch(error => {
					this.logService.warn(`[Sidecar] Failed to show devtunnel startup warning: ${error instanceof Error ? error.message : String(error)}`);
				});
			}
		}

		return undefined;
	}

	private async tryStartDirectDevTunnelHost(localBridgeUri: vscode.Uri): Promise<DevTunnelHostAttemptResult> {
		const port = getUriPort(localBridgeUri);
		if (!port) {
			this.logService.warn(`[Sidecar] Unable to determine local bridge port from URI for direct devtunnel bootstrap: ${localBridgeUri.toString(true)}`);
			return {
				uri: undefined,
				failureReason: undefined,
			};
		}

		let devTunnelHostProcess: ChildProcessWithoutNullStreams;
		try {
			devTunnelHostProcess = spawn(devTunnelExecutableName, ['host', '-p', `${port}`, '--allow-anonymous']);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.logService.warn(`[Sidecar] Failed to launch direct devtunnel host process: ${reason}`);
			return {
				uri: undefined,
				failureReason: reason,
			};
		}

		const readyResult = await this.waitForDevTunnelHostUri(devTunnelHostProcess);
		if (!readyResult.uri) {
			this.terminateDevTunnelProcess(devTunnelHostProcess);
			const failureReason = readyResult.failureReason;
			if (failureReason) {
				this.logService.warn(`[Sidecar] Direct devtunnel host did not become ready: ${failureReason}`);
			}
			return {
				uri: undefined,
				failureReason,
			};
		}

		this.devTunnelHostProcess = devTunnelHostProcess;
		this.attachDevTunnelHostLifecycle(devTunnelHostProcess);
		this.logService.info(`[Sidecar] Direct devtunnel host ready at ${readyResult.uri.toString(true)}.`);
		return {
			uri: readyResult.uri,
			failureReason: undefined,
		};
	}

	private waitForDevTunnelHostUri(devTunnelHostProcess: ChildProcessWithoutNullStreams): Promise<DevTunnelHostAttemptResult> {
		return new Promise(resolve => {
			let outputBuffer = '';
			let settled = false;

			const settle = (result: DevTunnelHostAttemptResult): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				devTunnelHostProcess.stdout.off('data', onStdoutData);
				devTunnelHostProcess.stderr.off('data', onStderrData);
				devTunnelHostProcess.off('error', onError);
				devTunnelHostProcess.off('exit', onExit);
				resolve(result);
			};

			const appendOutput = (chunk: Buffer | string): vscode.Uri | undefined => {
				const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
				if (text.trim().length > 0) {
					this.logService.trace(`[Sidecar][devtunnel] ${text.trim()}`);
				}

				outputBuffer = `${outputBuffer}${text}`;
				if (outputBuffer.length > devTunnelOutputBufferLimit) {
					outputBuffer = outputBuffer.slice(-devTunnelOutputBufferLimit);
				}

				return this.extractPublicDevTunnelUri(outputBuffer);
			};

			const onStdoutData = (chunk: Buffer | string) => {
				const uri = appendOutput(chunk);
				if (uri) {
					settle({
						uri,
						failureReason: undefined,
					});
				}
			};

			const onStderrData = (chunk: Buffer | string) => {
				const uri = appendOutput(chunk);
				if (uri) {
					settle({
						uri,
						failureReason: undefined,
					});
				}
			};

			const onError = (error: Error) => {
				let failureReason = error.message;
				if (failureReason.includes('ENOENT')) {
					failureReason = l10n.t('devtunnel CLI is not installed or not available on PATH');
				}

				settle({
					uri: undefined,
					failureReason,
				});
			};

			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				const failureReason = code === 0
					? l10n.t('devtunnel host exited before publishing a public endpoint')
					: l10n.t('devtunnel host exited with code {0}{1}', code ?? 'unknown', signal ? ` (${signal})` : '');
				settle({
					uri: undefined,
					failureReason,
				});
			};

			const timeout = setTimeout(() => {
				settle({
					uri: undefined,
					failureReason: l10n.t('timed out waiting for devtunnel host to publish a public endpoint'),
				});
			}, devTunnelStartupTimeoutMs);

			devTunnelHostProcess.stdout.on('data', onStdoutData);
			devTunnelHostProcess.stderr.on('data', onStderrData);
			devTunnelHostProcess.once('error', onError);
			devTunnelHostProcess.once('exit', onExit);
		});
	}

	private extractPublicDevTunnelUri(output: string): vscode.Uri | undefined {
		const matches = output.match(devTunnelUrlPattern);
		if (!matches) {
			return undefined;
		}

		for (let index = matches.length - 1; index >= 0; index--) {
			const candidate = matches[index].replace(/[),.;]+$/, '');
			let parsed: vscode.Uri;
			try {
				parsed = vscode.Uri.parse(candidate);
			} catch {
				continue;
			}

			const host = getUriHostname(parsed);
			if (!host || !isDevTunnelsHost(host) || !isPublicTunnelUri(parsed)) {
				continue;
			}

			return parsed;
		}

		return undefined;
	}

	private attachDevTunnelHostLifecycle(devTunnelHostProcess: ChildProcessWithoutNullStreams): void {
		devTunnelHostProcess.on('exit', (code, signal) => {
			if (this.devTunnelHostProcess !== devTunnelHostProcess) {
				return;
			}

			this.devTunnelHostProcess = undefined;
			this.logService.warn(`[Sidecar] Direct devtunnel host exited (code=${code ?? 'unknown'}, signal=${signal ?? 'none'}).`);
		});

		devTunnelHostProcess.on('error', error => {
			if (this.devTunnelHostProcess !== devTunnelHostProcess) {
				return;
			}

			this.logService.warn(`[Sidecar] Direct devtunnel host process error: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private terminateDevTunnelProcess(devTunnelHostProcess: ChildProcessWithoutNullStreams): void {
		try {
			devTunnelHostProcess.kill('SIGTERM');
		} catch {
			// Ignore process termination failures.
		}
	}

	private stopDevTunnelHost(): void {
		const devTunnelHostProcess = this.devTunnelHostProcess;
		if (!devTunnelHostProcess) {
			return;
		}

		this.devTunnelHostProcess = undefined;
		this.terminateDevTunnelProcess(devTunnelHostProcess);
	}

	private async showDevTunnelInstallPrompt(reason: string): Promise<void> {
		const normalizedReason = reason.trim();
		const renderedReason = normalizedReason.length > 0
			? normalizedReason
			: l10n.t('unknown reason');
		const selected = await vscode.window.showWarningMessage(
			l10n.t('Sidecar requires the devtunnel CLI, but it was not detected ({0}).', renderedReason),
			l10n.t('Install Dev Tunnels')
		);

		if (selected) {
			void vscode.env.openExternal(vscode.Uri.parse(devTunnelInstallUrl));
		}
	}

	private async showDevTunnelStartupWarning(reason: string): Promise<void> {
		const normalizedReason = reason.trim();
		const renderedReason = normalizedReason.length > 0
			? normalizedReason
			: l10n.t('unknown reason');
		await vscode.window.showWarningMessage(l10n.t('Sidecar could not start a direct dev tunnel ({0}).', renderedReason));
	}

	private async isBridgeEndpointUsable(candidateUri: vscode.Uri, source: string): Promise<boolean> {
		if (!isPublicTunnelUri(candidateUri)) {
			return false;
		}

		if (!isDevTunnelsHost(getUriHostname(candidateUri))) {
			this.logService.warn(`[Sidecar] Ignoring tunnel endpoint from ${source}; Sidecar requires a devtunnels.ms endpoint for WebSocket support (${candidateUri.toString(true)}).`);
			return false;
		}

		if (await this.probeBridgeEndpoint(candidateUri)) {
			return true;
		}

		this.logService.warn(`[Sidecar] Ignoring tunnel endpoint from ${source}; endpoint did not route to the bridge (${candidateUri.toString(true)}).`);
		return false;
	}

	private async probeBridgeEndpoint(candidateUri: vscode.Uri): Promise<boolean> {
		const probeUri = candidateUri.with({ query: '', fragment: '' });
		const probeTarget = probeUri.toString(true);

		for (let attempt = 0; attempt < 3; attempt++) {
			if (await this.tryProbeBridgeEndpointOnce(probeTarget)) {
				return true;
			}

			if (attempt < 2) {
				await new Promise<void>(resolve => setTimeout(resolve, 300));
			}
		}

		return false;
	}

	private tryProbeBridgeEndpointOnce(probeTarget: string): Promise<boolean> {
		return new Promise(resolve => {
			let settled = false;
			const finish = (value: boolean): void => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(value);
			};

			let parsed: URL;
			try {
				parsed = new URL(probeTarget);
			} catch {
				finish(false);
				return;
			}

			const transport = parsed.protocol === 'https:'
				? https
				: parsed.protocol === 'http:'
					? http
					: undefined;
			if (!transport) {
				finish(false);
				return;
			}

			const request = transport.request(parsed, { method: 'GET' }, response => {
				const status = response.statusCode ?? 0;
				// Dev Tunnels may return 3xx/401/403 if the tunnel is private, or 200 if public.
				// A 404 means the tunnel doesn't exist or port isn't forwarded.
				// A 5xx means the devtunnels relay cannot reach the host.
				if (status >= 500 || status === 404) {
					response.resume();
					finish(false);
					return;
				}

				if (status >= 300 && status < 500) {
					response.resume();
					finish(true);
					return;
				}

				let body = '';
				let bodyBytes = 0;
				response.setEncoding('utf8');
				response.on('data', chunk => {
					if (bodyBytes >= bridgeEndpointProbeMaxBodyBytes) {
						return;
					}

					const textChunk = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
					bodyBytes += textChunk.length;
					body += textChunk;
				});
				response.on('end', () => {
					finish(body.includes(bridgeEndpointProbeSignature));
				});
			});

			request.setTimeout(bridgeEndpointProbeTimeoutMs, () => {
				request.destroy();
				finish(false);
			});
			request.on('error', () => {
				finish(false);
			});
			request.end();
		});
	}

	private registerUi(): void {
		this._register(vscode.commands.registerCommand(showSidecarPanelCommandId, () => {
			void this.onStatusBarClicked();
		}));

		this.statusBarItem = this._register(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50));
		this.statusBarItem.command = showSidecarPanelCommandId;
		this.statusBarItem.show();
		this.updateStatusBar();
	}

	private async onStatusBarClicked(): Promise<void> {
		try {
			await this.startSidecar();
		} catch (error) {
			if (error instanceof Error && (error.message.includes(devTunnelDomainSuffix) || error.message.includes('dev tunnel'))) {
				const actionLabel = isDevTunnelCliMissingReason(error.message)
					? l10n.t('Install Dev Tunnels')
					: l10n.t('Open Dev Tunnels Docs');
				const selected = await vscode.window.showErrorMessage(
					l10n.t('Sidecar requires a dev tunnel endpoint to pair. Install or configure dev tunnels and try again.'),
					actionLabel
				);

				if (selected) {
					void vscode.env.openExternal(vscode.Uri.parse(devTunnelInstallUrl));
				}
				return;
			}

			vscode.window.showErrorMessage(l10n.t('Sidecar failed to start. Check extension logs and try again.'));
			return;
		}

		await this.showQrPanel();
	}

	private updateStatusBar(): void {
		if (!this.statusBarItem) {
			return;
		}

		if (this.sidecarState === 'starting') {
			this.statusBarItem.text = '$(sync~spin) Sidecar starting';
			this.statusBarItem.tooltip = l10n.t('Starting Sidecar bridge...');
			this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
			this.statusBarItem.backgroundColor = undefined;
			return;
		}

		if (this.sidecarState === 'disconnected') {
			this.statusBarItem.text = '$(debug-disconnect) Sidecar';
			this.statusBarItem.tooltip = l10n.t('Sidecar is disconnected. Click to start pairing.');
			this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
			this.statusBarItem.backgroundColor = undefined;
			return;
		}

		const connectedCount = this.bridgeServer.connectedClients;
		this.statusBarItem.text = connectedCount > 0
			? `$(device-mobile) Sidecar ${connectedCount}`
			: '$(device-mobile) Sidecar';
		this.statusBarItem.tooltip = l10n.t('Show Sidecar pairing QR code');
		this.statusBarItem.color = undefined;
		this.statusBarItem.backgroundColor = undefined;
	}

	private async showQrPanel(): Promise<void> {
		if (!this.tunnelUri) {
			vscode.window.showWarningMessage(l10n.t('Sidecar is disconnected. Click the Sidecar status item to start it.'));
			return;
		}

		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'copilot.sidecar',
				l10n.t('Copilot Sidecar'),
				vscode.ViewColumn.Active,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
				}
			);

			this._register(this.panel.onDidDispose(() => {
				this.panel = undefined;
			}));

			this._register(this.panel.webview.onDidReceiveMessage(message => {
				void this.handlePanelMessage(message);
			}));
		} else {
			this.panel.reveal(vscode.ViewColumn.Active);
		}

		await this.refreshPanel();
	}

	private async handlePanelMessage(message: unknown): Promise<void> {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}

		switch (message.type) {
			case 'regenerate-token': {
				this.bridgeServer.regenerateToken();
				await this.refreshPanel();
				break;
			}
			case 'configure-pwa-url': {
				await this.configurePwaUrl();
				await this.refreshPanel();
				break;
			}
		}
	}

	private async refreshPanel(): Promise<void> {
		if (!this.panel || !this.tunnelUri) {
			return;
		}

		const bridgeWsUri = this.getBridgeWebSocketUri();
		if (!bridgeWsUri) {
			this.panel.webview.html = this.getErrorHtml(this.panel.webview, l10n.t('Failed to resolve Sidecar bridge endpoint.'));
			return;
		}

		const pwaBaseUrl = await this.getPwaUrl();
		if (!pwaBaseUrl) {
			this.panel.webview.html = this.getErrorHtml(this.panel.webview, l10n.t('A PWA URL is required to pair Sidecar.'));
			return;
		}

		const pairingUrl = this.createPairingUrl(pwaBaseUrl);
		if (!pairingUrl) {
			this.panel.webview.html = this.getErrorHtml(this.panel.webview, l10n.t('Failed to build the pairing URL.'));
			return;
		}

		this.panel.webview.html = this.getPanelHtml(this.panel.webview, {
			pairingUrl,
			pwaBaseUrl,
			bridgeEndpoint: bridgeWsUri.toString(true),
			bridgeIsLoopback: isLoopbackHost(getUriHostname(bridgeWsUri)),
			connectedClients: this.bridgeServer.connectedClients,
		});
	}

	private async configurePwaUrl(): Promise<void> {
		const currentValue = await this.getPwaUrl();
		const input = await vscode.window.showInputBox({
			prompt: l10n.t('Enter the hosted PWA URL for Sidecar'),
			placeHolder: defaultPwaUrl,
			value: currentValue ?? defaultPwaUrl,
			ignoreFocusOut: true,
			validateInput: value => this.normalizePwaUrl(value) ? undefined : l10n.t('Please enter a valid http(s) URL.'),
		});

		if (!input) {
			return;
		}

		const normalized = this.normalizePwaUrl(input);
		if (!normalized) {
			vscode.window.showErrorMessage(l10n.t('Invalid PWA URL.'));
			return;
		}

		await this.extensionContext.globalState.update(pwaUrlStorageKey, normalized);
	}

	private async getPwaUrl(): Promise<string | undefined> {
		const devUrlRaw = process.env[pwaDevUrlEnvVar];
		if (typeof devUrlRaw === 'string' && devUrlRaw.trim().length > 0) {
			const devUrl = this.normalizePwaUrl(devUrlRaw);
			if (devUrl) {
				return devUrl;
			}

			this.logService.warn(`[Sidecar] Ignoring invalid ${pwaDevUrlEnvVar}: ${devUrlRaw}`);
		}

		const existing = this.extensionContext.globalState.get<string>(pwaUrlStorageKey);
		if (existing) {
			return existing;
		}

		const input = await vscode.window.showInputBox({
			prompt: l10n.t('Set the hosted PWA URL for Sidecar'),
			placeHolder: defaultPwaUrl,
			value: defaultPwaUrl,
			ignoreFocusOut: true,
			validateInput: value => this.normalizePwaUrl(value) ? undefined : l10n.t('Please enter a valid http(s) URL.'),
		});

		if (!input) {
			return undefined;
		}

		const normalized = this.normalizePwaUrl(input);
		if (!normalized) {
			return undefined;
		}

		await this.extensionContext.globalState.update(pwaUrlStorageKey, normalized);
		return normalized;
	}

	private normalizePwaUrl(value: string): string | undefined {
		try {
			const parsed = new URL(value.trim());
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return undefined;
			}
			parsed.hash = '';
			parsed.search = '';
			if (!parsed.pathname.endsWith('/')) {
				parsed.pathname = `${parsed.pathname}/`;
			}
			return parsed.toString();
		} catch {
			return undefined;
		}
	}

	private createPairingUrl(pwaBaseUrl: string): string | undefined {
		const bridgeWsUri = this.getBridgeWebSocketUri();
		if (!bridgeWsUri) {
			return undefined;
		}

		try {
			const url = new URL(pwaBaseUrl);
			url.searchParams.set('ws', bridgeWsUri.toString(true));
			url.searchParams.set('token', this.bridgeServer.sessionToken);
			return url.toString();
		} catch {
			return undefined;
		}
	}

	private getBridgeWebSocketUri(): vscode.Uri | undefined {
		if (!this.tunnelUri) {
			return undefined;
		}

		return this.tunnelUri.with({ scheme: this.tunnelUri.scheme === 'https' ? 'wss' : 'ws' });
	}

	private getErrorHtml(webview: vscode.Webview, message: string): string {
		const nonce = createNonce();
		return `<!doctype html>
<html>
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
		button { min-height: 32px; padding: 0.4rem 0.8rem; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	</style>
</head>
<body>
	<p>${escapeHtml(message)}</p>
	<button id="configure">${escapeHtml(l10n.t('Set PWA URL'))}</button>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('configure')?.addEventListener('click', () => {
			vscode.postMessage({ type: 'configure-pwa-url' });
		});
	</script>
</body>
</html>`;
	}

	private getPanelHtml(webview: vscode.Webview, data: { pairingUrl: string; pwaBaseUrl: string; bridgeEndpoint: string; bridgeIsLoopback: boolean; connectedClients: number }): string {
		const nonce = createNonce();
		const escapedPairingUrl = escapeHtml(data.pairingUrl);
		const pairingLiteral = JSON.stringify(data.pairingUrl);
		const loopbackWarning = data.bridgeIsLoopback
			? `<div class="warning">${escapeHtml(l10n.t('Bridge endpoint is loopback-only ({0}). This pairing URL will not work from a phone unless the bridge is routed externally.', data.bridgeEndpoint))}</div>`
			: '';
		return `<!doctype html>
<html>
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https:;" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		:root {
			--bg: #0f172a;
			--panel: #111827;
			--text: #e5e7eb;
			--subtle: #9ca3af;
			--accent: #22d3ee;
		}
		body {
			margin: 0;
			min-height: 100vh;
			padding: 0.6rem;
			box-sizing: border-box;
			display: flex;
			align-items: center;
			justify-content: center;
			font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
			background: radial-gradient(circle at 20% 10%, #1f2937 0%, var(--bg) 45%, #020617 100%);
			color: var(--text);
		}
		.card {
			width: min(100%, 360px);
			max-width: 360px;
			margin: 0 auto;
			padding: 0.8rem;
			border-radius: 14px;
			background: color-mix(in srgb, var(--panel) 84%, transparent);
			border: 1px solid color-mix(in srgb, var(--accent) 25%, #374151);
			box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
		}
		h1 {
			margin: 0 0 0.5rem 0;
			font-size: 1.2rem;
		}
		.meta {
			margin-bottom: 1rem;
			color: var(--subtle);
		}
		#qrcode {
			background: white;
			border-radius: 10px;
			display: block;
			box-sizing: border-box;
			margin: 0 auto;
			padding: 0.45rem;
			width: min(100%, 220px);
		}
		#qrcode svg {
			display: block;
			width: 100%;
			height: auto;
		}
		.url {
			margin-top: 0.8rem;
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
			padding: 0.7rem;
			background: #020617;
			border-radius: 8px;
			word-break: break-all;
			border: 1px solid #374151;
		}
		.actions {
			display: flex;
			gap: 0.5rem;
			margin-top: 0.8rem;
			flex-wrap: wrap;
		}
		button {
			min-height: 34px;
			padding: 0.45rem 0.8rem;
			border-radius: 8px;
			border: 1px solid #4b5563;
			background: #1f2937;
			color: #f9fafb;
			cursor: pointer;
		}
		button.primary {
			background: linear-gradient(135deg, #0891b2, #0369a1);
			border-color: #0e7490;
		}
		.small {
			font-size: 12px;
			color: var(--subtle);
			margin-top: 0.8rem;
		}
		.warning {
			margin-top: 0.8rem;
			padding: 0.6rem;
			font-size: 12px;
			border-radius: 8px;
			border: 1px solid #92400e;
			background: #451a03;
			color: #fde68a;
		}
	</style>
</head>
<body>
	<div class="card">
		<h1>${escapeHtml(l10n.t('Copilot Sidecar'))}</h1>
		<div class="meta">${escapeHtml(l10n.t('Connected phones: {0}', data.connectedClients))}</div>
		<div id="qrcode"></div>
		<div class="url" id="pairing-url">${escapedPairingUrl}</div>
		<div class="actions">
			<button class="primary" id="copy-url">${escapeHtml(l10n.t('Copy Pairing URL'))}</button>
			<button id="regenerate">${escapeHtml(l10n.t('Regenerate Token'))}</button>
			<button id="configure">${escapeHtml(l10n.t('Set PWA URL'))}</button>
		</div>
		<div class="small">${escapeHtml(l10n.t('PWA: {0}', data.pwaBaseUrl))}</div>
		<div class="small">${escapeHtml(l10n.t('Bridge: {0}', data.bridgeEndpoint))}</div>
		${loopbackWarning}
	</div>
	<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const pairingUrl = ${pairingLiteral};
		const qrContainer = document.getElementById('qrcode');
		if (typeof qrcode === 'function' && qrContainer) {
			const qr = qrcode(0, 'M');
			qr.addData(pairingUrl);
			qr.make();
			qrContainer.innerHTML = qr.createSvgTag(6, 2);
		}

		document.getElementById('copy-url')?.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(pairingUrl);
			} catch {
				// Clipboard writes can fail in restricted environments.
			}
		});

		document.getElementById('regenerate')?.addEventListener('click', () => {
			vscode.postMessage({ type: 'regenerate-token' });
		});
		document.getElementById('configure')?.addEventListener('click', () => {
			vscode.postMessage({ type: 'configure-pwa-url' });
		});
	</script>
</body>
</html>`;
	}
}
