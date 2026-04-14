/*---------------------------------------------------------------------------------------------
 *  Copyright (c) David Khachaturov. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { BridgeServer } from '../../../platform/bridge/bridgeServer';
import { ConversationBridge } from '../../../platform/bridge/conversationBridge';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { IConversationStore } from '../../conversationStore/node/conversationStore';

const showSidecarPanelCommandId = 'github.copilot.sidecar.showPanel';
const pwaUrlStorageKey = 'sidecar.pwaUrl';
const legacyPwaUrlStorageKey = 'mobileMirror.pwaUrl';
const defaultPwaUrl = 'https://davidobot.github.io/vscode-copilot-chat-sidecar/';
const pwaDevUrlEnvVar = 'COPILOT_PWA_DEV_URL';

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

function getUriHostname(uri: vscode.Uri): string | undefined {
	try {
		return new URL(uri.toString(true)).hostname;
	} catch {
		return undefined;
	}
}

export class SidecarContribution extends Disposable implements IExtensionContribution {
	readonly id = 'sidecarContribution';
	readonly activationBlocker: Promise<void>;

	private readonly bridgeServer = this._register(new BridgeServer());
	private readonly conversationBridge: ConversationBridge;
	private tunnelUri: vscode.Uri | undefined;
	private statusBarItem: vscode.StatusBarItem | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private sidecarState: SidecarState = 'disconnected';
	private startPromise: Promise<void> | undefined;
	private hasRegisteredBridgeListeners = false;

	constructor(
		@IConversationStore conversationStore: IConversationStore,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
		@IFileSystemService fileSystemService: IFileSystemService,
	) {
		super();
		this.conversationBridge = this._register(new ConversationBridge(this.bridgeServer, conversationStore, this.logService, fileSystemService, this.extensionContext));
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
			const port = await this.bridgeServer.start();
			const localBridgeUri = vscode.Uri.parse(`http://localhost:${port}`);
			this.tunnelUri = await vscode.env.asExternalUri(localBridgeUri);
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
			if (isLoopbackHost(getUriHostname(this.tunnelUri))) {
				this.logService.warn(`[Sidecar] bridge resolved to loopback endpoint (${this.tunnelUri.toString(true)}). Phone pairing requires a routable endpoint.`);
			} else {
				this.logService.info(`[Sidecar] bridge ready at ${this.tunnelUri.toString(true)}`);
			}
		} catch (error) {
			this.sidecarState = 'disconnected';
			this.updateStatusBar();
			this.logService.error(error, '[Sidecar] failed to initialize bridge');
			throw error;
		}
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
		} catch {
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

		const existing = this.extensionContext.globalState.get<string>(pwaUrlStorageKey)
			?? this.extensionContext.globalState.get<string>(legacyPwaUrlStorageKey);
		if (existing) {
			if (!this.extensionContext.globalState.get<string>(pwaUrlStorageKey)) {
				await this.extensionContext.globalState.update(pwaUrlStorageKey, existing);
			}
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
			padding: 1rem;
			font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
			background: radial-gradient(circle at 20% 10%, #1f2937 0%, var(--bg) 45%, #020617 100%);
			color: var(--text);
		}
		.card {
			max-width: 720px;
			margin: 0 auto;
			padding: 1rem;
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
			display: inline-block;
			padding: 0.7rem;
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
