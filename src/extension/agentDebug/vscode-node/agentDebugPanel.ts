/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IAgentDebugEventService } from '../common/agentDebugEventService';
import { AgentDebugEventCategory, IAgentDebugEvent, IAgentDebugEventFilter } from '../common/agentDebugTypes';
import { buildEventTree, computeSessionSummary, formatCategoryLabel, formatDuration, formatEventDetail, formatEventSummary, formatTimestamp, getEventIcon, getEventStatusClass, IEventTreeNode, sortEventsChronologically } from '../common/agentDebugViewLogic';
import { getAgentDebugPanelHtml } from './panelHtml';

interface FlatRow {
	id: string;
	timestamp: string;
	icon: string;
	categoryLabel: string;
	summary: string;
	statusClass: string;
	detail: Record<string, string>;
	durationMs: number | undefined;
	totalTokens: number | undefined;
	/** Nesting depth: 0 = top-level, 1 = child of subagent, etc. */
	depth: number;
	/** Whether this row is a subagent parent with children. */
	isSubAgent: boolean;
	/** Number of direct children (valid when isSubAgent=true). */
	childCount: number;
	/** When set, this tool call was made from within a subagent. */
	subAgentName: string | undefined;
}

function flattenTree(tree: readonly IEventTreeNode[]): FlatRow[] {
	const out: FlatRow[] = [];
	function walk(nodes: readonly IEventTreeNode[], depth: number): void {
		for (const node of nodes) {
			const e = node.event;
			out.push({
				id: e.id,
				timestamp: formatTimestamp(e.timestamp),
				icon: getEventIcon(e),
				categoryLabel: formatCategoryLabel(e.category as AgentDebugEventCategory),
				summary: formatEventSummary(e),
				statusClass: getEventStatusClass(e),
				detail: formatEventDetail(e),
				durationMs: (e as { durationMs?: number }).durationMs,
				totalTokens: (e as { totalTokens?: number }).totalTokens,
				depth,
				isSubAgent: node.children.length > 0,
				childCount: node.children.length,
				subAgentName: (e as { subAgentName?: string }).subAgentName,
			});
			walk(node.children, depth + 1);
		}
	}
	walk(tree, 0);
	return out;
}

interface WebviewMessage {
	type: string;
	[key: string]: unknown;
}

const WEBVIEW_UPDATE_THROTTLE_MS = 250;
const MAX_WEBVIEW_ROWS = 500;

export class AgentDebugPanel extends Disposable {
	private static _instance: AgentDebugPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables = this._register(new DisposableStore());
	private _currentSessionId: string | undefined;
	private _activeFilter: IAgentDebugEventFilter = {};
	private _updateTimer: ReturnType<typeof setTimeout> | undefined;
	private _lastPostedSignature: string | undefined;

	static createOrShow(debugEventService: IAgentDebugEventService, logService?: ILogService): AgentDebugPanel {
		if (AgentDebugPanel._instance) {
			AgentDebugPanel._instance._refreshWebview();
			AgentDebugPanel._instance._panel.reveal();
			return AgentDebugPanel._instance;
		}

		const panel = vscode.window.createWebviewPanel(
			'agentDebug',
			'Agent Debug',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		AgentDebugPanel._instance = new AgentDebugPanel(panel, debugEventService, logService);
		return AgentDebugPanel._instance;
	}

	private _webviewReady = false;

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly _debugEventService: IAgentDebugEventService,
		private readonly _logService?: ILogService,
	) {
		super();

		this._panel = panel;

		// Register message listener BEFORE setting HTML to avoid losing the
		// webviewReady message that the webview sends immediately on load.
		this._disposables.add(this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
			this._handleMessage(msg);
		}));

		this._panel.webview.html = this._getHtml();
		this.attachLatest();

		this._disposables.add(this._panel.onDidDispose(() => {
			if (this._updateTimer !== undefined) {
				clearTimeout(this._updateTimer);
			}
			AgentDebugPanel._instance = undefined;
			this.dispose();
		}));

		this._disposables.add(this._debugEventService.onDidAddEvent(event => {
			// Skip discovery events with synthetic 'global' sessionId
			if (event.sessionId === 'global') {
				return;
			}
			// Auto-follow: always track the latest real session so
			// subsequent prompts (new sessions) show up automatically.
			if (this._currentSessionId !== event.sessionId) {
				this._currentSessionId = event.sessionId;
				this._lastPostedSignature = undefined;
			}
			this._scheduleUpdate();
		}));

		this._disposables.add(this._debugEventService.onDidClearEvents(() => {
			this._scheduleUpdate();
		}));
	}

	attachSession(sessionId: string): void {
		this._currentSessionId = sessionId;
		this._lastPostedSignature = undefined;
		this._postEventsUpdate();
	}

	attachLatest(): void {
		const events = this._debugEventService.getEvents();
		// Find the latest event from a real session (skip 'global' discovery events)
		let latestSessionId: string | undefined;
		for (let i = events.length - 1; i >= 0; i--) {
			if (events[i].sessionId !== 'global') {
				latestSessionId = events[i].sessionId;
				break;
			}
		}
		if (!latestSessionId) {
			this._currentSessionId = undefined;
			this._lastPostedSignature = undefined;
			this._postMessage({ type: 'noSession' });
			return;
		}
		this._currentSessionId = latestSessionId;
		this._lastPostedSignature = undefined;
		this._postEventsUpdate();
	}

	private _ensureCurrentSessionId(): void {
		if (this._currentSessionId) {
			return;
		}
		const events = this._debugEventService.getEvents();
		if (events.length > 0) {
			this._currentSessionId = events[events.length - 1].sessionId;
		}
	}

	private _handleMessage(msg: WebviewMessage): void {
		switch (msg.type) {
			case 'webviewReady':
				this._webviewReady = true;
				this.attachLatest();
				break;
			case 'attachLatest':
				this.attachLatest();
				break;
			case 'setFilter': {
				const categories = msg['categories'] as string[] | undefined;
				this._activeFilter = {
					...this._activeFilter,
					categories: categories?.map(c => c as AgentDebugEventCategory),
				};
				this._lastPostedSignature = undefined;
				this._postEventsUpdate();
				break;
			}
			case 'clearLog':
				this._debugEventService.clearEvents(this._currentSessionId);
				break;
			case 'exportLog': {
				const events = this._getFilteredEvents();
				const json = JSON.stringify(events, undefined, 2);
				void vscode.workspace.openTextDocument({ content: json, language: 'json' })
					.then(doc => vscode.window.showTextDocument(doc));
				break;
			}
		}
	}

	private _getFilteredEvents(): readonly IAgentDebugEvent[] {
		this._ensureCurrentSessionId();
		const filter: IAgentDebugEventFilter = this._currentSessionId ? {
			...this._activeFilter,
			sessionId: this._currentSessionId,
		} : {
			...this._activeFilter,
		};
		return this._debugEventService.getEvents(filter);
	}

	private _scheduleUpdate(): void {
		if (this._updateTimer !== undefined) {
			return;
		}
		this._updateTimer = setTimeout(() => {
			this._updateTimer = undefined;
			this._postEventsUpdate();
		}, WEBVIEW_UPDATE_THROTTLE_MS);
	}

	private _postEventsUpdate(): void {
		try {
			this._ensureCurrentSessionId();
			if (!this._currentSessionId) {
				// No session yet — show the home screen instead of empty data
				this._postMessage({ type: 'noSession' });
				return;
			}
			const events = sortEventsChronologically(this._getFilteredEvents());
			const summary = computeSessionSummary(events);
			const visibleEvents = events.length > MAX_WEBVIEW_ROWS ? events.slice(-MAX_WEBVIEW_ROWS) : events;
			const signature = `${this._currentSessionId ?? 'none'}:${events.length}:${events[events.length - 1]?.id ?? 'none'}:${(this._activeFilter.categories ?? []).join(',')}`;
			if (signature === this._lastPostedSignature) {
				return;
			}
			this._lastPostedSignature = signature;

			// Build hierarchy tree, then flatten with depth annotations
			const tree = buildEventTree(visibleEvents);
			const rows = flattenTree(tree);

			this._postMessage({
				type: 'eventsUpdated',
				sessionId: this._currentSessionId,
				rows,
				summary: {
					toolCount: summary.toolCount,
					totalTokens: summary.totalTokens,
					duration: formatDuration(summary.durationMs),
					errorCount: summary.errorCount,
					cachedTokenRatio: `${(summary.cachedTokenRatio * 100).toFixed(0)}%`,
				},
			});
		} catch (err) {
			this._logService?.error(`[AgentDebug] _postEventsUpdate failed: ${err}`);
		}
	}

	private _postMessage(msg: unknown): void {
		void this._panel.webview.postMessage(msg).then(delivered => {
			if (!delivered) {
				const type = typeof msg === 'object' && msg !== null && 'type' in msg ? String((msg as { type?: unknown }).type) : 'unknown';
				this._logService?.warn(`[AgentDebug] webview.postMessage not delivered (type=${type}, ready=${this._webviewReady})`);
			}
		});
	}

	private _refreshWebview(): void {
		this._webviewReady = false;
		this._panel.webview.html = this._getHtml();
		this.attachLatest();
	}

	private _getHtml(): string {
		return getAgentDebugPanelHtml();
	}
}
