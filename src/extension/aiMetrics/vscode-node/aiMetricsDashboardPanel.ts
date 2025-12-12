/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAiMetricsStorageService } from '../common/aiMetricsStorageService';
import { getDateRangeFromTimeRange, IAggregatedMetrics, TimeRange } from '../common/metrics';

/**
 * Message types sent from the webview to the extension
 */
interface RefreshMetricsMessage {
	command: 'refreshMetrics';
	timeRange: TimeRange;
}

/**
 * Message types sent from the extension to the webview
 */
interface MetricsDataMessage {
	command: 'metricsData';
	metrics: IAggregatedMetrics;
}

type WebviewMessage = RefreshMetricsMessage;
type ExtensionMessage = MetricsDataMessage;

/**
 * Manages the AI Metrics Dashboard webview panel
 */
export class AiMetricsDashboardPanel extends Disposable {
	private static currentPanel: AiMetricsDashboardPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	public static readonly viewType = 'github.copilot.aiMetricsDashboard';

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly extensionContext: IVSCodeExtensionContext,
		private readonly storageService: IAiMetricsStorageService,
		private readonly logService: ILogService,
	) {
		super();
		this.panel = panel;

		// Set up the webview HTML
		this.panel.webview.html = this.getWebviewContent();

		// Handle messages from the webview
		this.panel.webview.onDidReceiveMessage(
			async (message: WebviewMessage) => {
				await this.handleWebviewMessage(message);
			},
			undefined,
			this.disposables
		);

		// Handle panel disposal
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		// Load initial metrics
		this.refreshMetrics(TimeRange.Week);
	}

	/**
	 * Create or show the AI Metrics Dashboard
	 */
	public static createOrShow(
		extensionContext: IVSCodeExtensionContext,
		storageService: IAiMetricsStorageService,
		logService: ILogService,
	): void {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		// If we already have a panel, show it
		if (AiMetricsDashboardPanel.currentPanel) {
			AiMetricsDashboardPanel.currentPanel.panel.reveal(column);
			return;
		}

		// Otherwise, create a new panel
		const panel = vscode.window.createWebviewPanel(
			AiMetricsDashboardPanel.viewType,
			'AI Metrics Dashboard',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionContext.extensionUri, 'src', 'extension', 'aiMetrics', 'webview')
				]
			}
		);

		AiMetricsDashboardPanel.currentPanel = new AiMetricsDashboardPanel(
			panel,
			extensionContext,
			storageService,
			logService
		);
	}

	private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
		switch (message.command) {
			case 'refreshMetrics':
				await this.refreshMetrics(message.timeRange);
				break;
		}
	}

	private async refreshMetrics(timeRange: TimeRange): Promise<void> {
		try {
			this.logService.trace('[AiMetrics] Refreshing metrics', { timeRange });

			// Get date range from time range selector
			const { startDate, endDate } = getDateRangeFromTimeRange(timeRange);

			// Retrieve events from storage
			const events = await this.storageService.getEventsInRange(startDate, endDate);

			// Compute metrics
			const metrics = this.storageService.computeMetrics(events, startDate, endDate);

			// Send metrics to webview
			await this.postMessage({
				command: 'metricsData',
				metrics
			});

			this.logService.trace('[AiMetrics] Metrics refreshed', { eventCount: events.length });
		} catch (error) {
			this.logService.error('[AiMetrics] Failed to refresh metrics', error);
			vscode.window.showErrorMessage('Failed to load AI metrics. Please try again.');
		}
	}

	private async postMessage(message: ExtensionMessage): Promise<void> {
		await this.panel.webview.postMessage(message);
	}

	private getWebviewContent(): string {
		// Get VS Code theme
		const themeKind = vscode.window.activeColorTheme.kind;
		const isDark = themeKind === vscode.ColorThemeKind.Dark || themeKind === vscode.ColorThemeKind.HighContrast;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
	<title>AI Metrics Dashboard</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			padding: 20px;
			margin: 0;
		}
		.header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 20px;
			padding-bottom: 15px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.header h1 {
			margin: 0;
			font-size: 24px;
			font-weight: 600;
		}
		.controls {
			display: flex;
			gap: 10px;
			align-items: center;
		}
		.time-range-selector {
			padding: 6px 12px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-family: var(--vscode-font-family);
		}
		.time-range-selector:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.refresh-btn {
			padding: 6px 12px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-family: var(--vscode-font-family);
		}
		.refresh-btn:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.metrics-overview {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
			gap: 15px;
			margin-bottom: 30px;
		}
		.metric-card {
			background: var(--vscode-editor-inactiveSelectionBackground);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			padding: 16px;
		}
		.metric-label {
			font-size: 12px;
			text-transform: uppercase;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 8px;
		}
		.metric-value {
			font-size: 32px;
			font-weight: 600;
			margin-bottom: 4px;
		}
		.metric-subtitle {
			font-size: 13px;
			color: var(--vscode-descriptionForeground);
		}
		.charts-section {
			margin-bottom: 30px;
		}
		.chart-container {
			background: var(--vscode-editor-inactiveSelectionBackground);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			padding: 20px;
			margin-bottom: 20px;
		}
		.chart-title {
			font-size: 16px;
			font-weight: 600;
			margin-bottom: 15px;
		}
		.chart-content {
			min-height: 200px;
			display: flex;
			align-items: center;
			justify-content: center;
			color: var(--vscode-descriptionForeground);
		}
		.breakdown-list {
			list-style: none;
			padding: 0;
			margin: 0;
		}
		.breakdown-item {
			display: flex;
			justify-content: space-between;
			padding: 8px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.breakdown-item:last-child {
			border-bottom: none;
		}
		.loading {
			text-align: center;
			padding: 40px;
			color: var(--vscode-descriptionForeground);
		}
	</style>
</head>
<body>
	<div class="header">
		<h1>AI Metrics Dashboard</h1>
		<div class="controls">
			<select class="time-range-selector" id="timeRange">
				<option value="today">Today</option>
				<option value="week" selected>Last 7 Days</option>
				<option value="month">Last 30 Days</option>
				<option value="all">All Time</option>
			</select>
			<button class="refresh-btn" id="refreshBtn">Refresh</button>
		</div>
	</div>

	<div id="content">
		<div class="loading">Loading metrics...</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		
		// Handle refresh button
		document.getElementById('refreshBtn').addEventListener('click', () => {
			const timeRange = document.getElementById('timeRange').value;
			vscode.postMessage({
				command: 'refreshMetrics',
				timeRange: timeRange
			});
		});

		// Handle time range change
		document.getElementById('timeRange').addEventListener('change', () => {
			const timeRange = document.getElementById('timeRange').value;
			vscode.postMessage({
				command: 'refreshMetrics',
				timeRange: timeRange
			});
		});

		// Handle messages from extension
		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.command) {
				case 'metricsData':
					renderMetrics(message.metrics);
					break;
			}
		});

		function renderMetrics(metrics) {
			const content = document.getElementById('content');
			
			// Format large numbers
			const formatNumber = (num) => {
				if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
				if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
				return num.toString();
			};

			// Format percentage
			const formatPercent = (ratio) => {
				return (ratio * 100).toFixed(1) + '%';
			};

			// Get top model
			const topModel = Object.entries(metrics.modelDistribution.modelUsageCount || {})
				.sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

			content.innerHTML = \`
				<div class="metrics-overview">
					<div class="metric-card">
						<div class="metric-label">Total Tokens</div>
						<div class="metric-value">\${formatNumber(metrics.tokenUsage.totalTokens)}</div>
						<div class="metric-subtitle">Cached: \${formatPercent(metrics.tokenUsage.cachedTokensRatio)}</div>
					</div>
					<div class="metric-card">
						<div class="metric-label">Acceptance Rate</div>
						<div class="metric-value">\${formatPercent(metrics.codeAcceptance.nesAcceptanceRate)}</div>
						<div class="metric-subtitle">NES Suggestions</div>
					</div>
					<div class="metric-card">
						<div class="metric-label">Top Model</div>
						<div class="metric-value" style="font-size: 18px; overflow: hidden; text-overflow: ellipsis;">\${topModel}</div>
						<div class="metric-subtitle">Most used</div>
					</div>
					<div class="metric-card">
						<div class="metric-label">Total Events</div>
						<div class="metric-value">\${formatNumber(metrics.eventCount)}</div>
						<div class="metric-subtitle">Collected</div>
					</div>
				</div>

				<div class="charts-section">
					<div class="chart-container">
						<div class="chart-title">Tokens by Model</div>
						<ul class="breakdown-list">
							\${Object.entries(metrics.tokenUsage.tokensByModel || {})
								.sort((a, b) => b[1] - a[1])
								.map(([model, tokens]) => \`
									<li class="breakdown-item">
										<span>\${model}</span>
										<span>\${formatNumber(tokens)}</span>
									</li>
								\`).join('') || '<li class="breakdown-item"><span>No data</span></li>'}
						</ul>
					</div>

					<div class="chart-container">
						<div class="chart-title">Tokens by Feature</div>
						<ul class="breakdown-list">
							\${Object.entries(metrics.tokenUsage.tokensByFeature || {})
								.sort((a, b) => b[1] - a[1])
								.map(([feature, tokens]) => \`
									<li class="breakdown-item">
										<span>\${feature}</span>
										<span>\${formatNumber(tokens)}</span>
									</li>
								\`).join('') || '<li class="breakdown-item"><span>No data</span></li>'}
						</ul>
					</div>

					<div class="chart-container">
						<div class="chart-title">Feature Usage</div>
						<ul class="breakdown-list">
							<li class="breakdown-item">
								<span>Chat Messages</span>
								<span>\${metrics.featureUsage.chatMessageCount}</span>
							</li>
							<li class="breakdown-item">
								<span>NES Opportunities</span>
								<span>\${metrics.featureUsage.nesOpportunityCount}</span>
							</li>
							<li class="breakdown-item">
								<span>Completions</span>
								<span>\${metrics.featureUsage.completionCount}</span>
							</li>
						</ul>
					</div>

					<div class="chart-container">
						<div class="chart-title">Performance Metrics</div>
						<ul class="breakdown-list">
							<li class="breakdown-item">
								<span>Avg Time to First Token</span>
								<span>\${metrics.performance.avgTTFT.toFixed(0)}ms</span>
							</li>
							<li class="breakdown-item">
								<span>Avg Fetch Time</span>
								<span>\${metrics.performance.avgFetchTime.toFixed(0)}ms</span>
							</li>
							<li class="breakdown-item">
								<span>P95 TTFT</span>
								<span>\${metrics.performance.p95TTFT.toFixed(0)}ms</span>
							</li>
							<li class="breakdown-item">
								<span>P95 Fetch Time</span>
								<span>\${metrics.performance.p95FetchTime.toFixed(0)}ms</span>
							</li>
						</ul>
					</div>
				</div>
			\`;
		}

		// Initial load request
		const initialTimeRange = document.getElementById('timeRange').value;
		vscode.postMessage({
			command: 'refreshMetrics',
			timeRange: initialTimeRange
		});
	</script>
</body>
</html>`;
	}

	public dispose(): void {
		AiMetricsDashboardPanel.currentPanel = undefined;

		// Clean up resources
		this.panel.dispose();

		while (this.disposables.length) {
			const disposable = this.disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}

		super.dispose();
	}
}
