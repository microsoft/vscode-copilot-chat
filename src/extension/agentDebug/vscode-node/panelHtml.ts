/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates the HTML content for the Agent Debug Panel webview.
 *
 * Separated from agentDebugPanel.ts following the same pattern as the
 * alternate prototype in `src/extension/debug/vscode-node/panelHtml.ts`.
 */

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export function getAgentDebugPanelHtml(): string {
	const nonce = getNonce();

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Agent Debug</title>
<style>
* { box-sizing: border-box; }

:root {
	font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
	font-size: var(--vscode-font-size, 13px);
	color: var(--vscode-foreground, #cccccc);
	background: var(--vscode-editor-background, #1e1e1e);
}

body {
	margin: 0;
	padding: 0;
	height: 100vh;
	display: flex;
	flex-direction: column;
}

/* ── Header ─────────────────────────────────────────────────── */
.header {
	padding: 8px 16px;
	background: var(--vscode-sideBarSectionHeader-background);
	border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, #333));
	display: flex;
	align-items: center;
	gap: 10px;
	flex-shrink: 0;
}
.header h1 {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
}
.session-badge {
	font-size: 11px;
	padding: 2px 8px;
	border-radius: 3px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
}
.session-badge.live {
	background: var(--vscode-testing-iconPassed);
	color: var(--vscode-editor-background);
}
.header-spacer { flex: 1; }

/* ── Content area ───────────────────────────────────────────── */
.content {
	flex: 1;
	overflow-y: auto;
	padding: 16px;
}

/* ── Home View ──────────────────────────────────────────────── */
#home { text-align: center; padding-top: 60px; }
#home h2 { margin-bottom: 8px; }
#home p { margin-bottom: 24px; opacity: 0.7; font-size: 12px; }
#home button {
	display: block;
	margin: 8px auto;
	padding: 8px 20px;
	border: none;
	border-radius: 4px;
	background: var(--vscode-button-background, #0e639c);
	color: var(--vscode-button-foreground, #ffffff);
	cursor: pointer;
	font-size: 14px;
	min-width: 240px;
}
#home button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

/* ── Session view ───────────────────────────────────────────── */
#session { display: none; }

/* ── Summary cards ──────────────────────────────────────────── */
.summary-row {
	display: flex;
	gap: 12px;
	margin-bottom: 16px;
	flex-wrap: wrap;
}
.summary-card {
	flex: 1;
	min-width: 100px;
	padding: 10px 14px;
	border-radius: 6px;
	background: var(--vscode-editorWidget-background);
	border: 1px solid var(--vscode-widget-border, transparent);
}
.summary-card .label {
	font-size: 11px;
	text-transform: uppercase;
	opacity: 0.7;
	margin-bottom: 4px;
}
.summary-card .value { font-size: 20px; font-weight: 600; }

/* ── Filter bar ─────────────────────────────────────────────── */
.filter-bar {
	display: flex;
	gap: 6px;
	margin-bottom: 12px;
	flex-wrap: wrap;
	align-items: center;
}
.filter-bar label {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 3px 8px;
	border-radius: 4px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	cursor: pointer;
	font-size: 12px;
	user-select: none;
	transition: opacity 0.15s;
}
.filter-bar label input { display: none; }
.filter-bar label.unchecked { opacity: 0.4; }
.toolbar {
	margin-left: auto;
	display: flex;
	gap: 6px;
}
.toolbar button {
	padding: 3px 10px;
	border: none;
	border-radius: 3px;
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	cursor: pointer;
	font-size: 12px;
}
.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* ── Event table ────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; }
th {
	text-align: left;
	padding: 6px 8px;
	font-size: 11px;
	text-transform: uppercase;
	opacity: 0.7;
	border-bottom: 1px solid var(--vscode-widget-border, #333);
	position: sticky;
	top: 0;
	background: var(--vscode-editor-background);
	z-index: 1;
}
td {
	padding: 6px 8px;
	border-bottom: 1px solid var(--vscode-widget-border, #222);
	font-size: 13px;
}
tr.event-row { cursor: pointer; }
tr.event-row:hover { background: var(--vscode-list-hoverBackground); }

/* ── Status colors ──────────────────────────────────────────── */
tr.status-error td { color: var(--vscode-errorForeground); }
tr.status-warning td { color: var(--vscode-editorWarning-foreground); }
tr.status-success td:nth-child(5) { color: var(--vscode-testing-iconPassed); }

/* ── Detail row ─────────────────────────────────────────────── */
tr.detail-row { display: none; }
tr.detail-row.expanded { display: table-row; }
tr.detail-row td {
	padding: 8px 16px;
	background: var(--vscode-editorWidget-background);
}
.detail-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
.detail-key { font-weight: 600; opacity: 0.8; }

/* ── SubAgent tree indentation ──────────────────────────────── */
.indent { display: inline-block; }
.toggle {
	display: inline-block;
	width: 16px;
	text-align: center;
	cursor: pointer;
	user-select: none;
	opacity: 0.7;
}
.toggle:hover { opacity: 1; }
tr.child-row { display: none; }
tr.child-row.visible { display: table-row; }
tr.child-row td:first-child { padding-left: 28px; }
.child-badge {
	display: inline-block;
	margin-left: 6px;
	padding: 0 5px;
	border-radius: 8px;
	font-size: 11px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
}

/* ── SubAgent child tool call rows ──────────────────────────── */
tr.subagent-child-row {
	border-left: 3px solid var(--vscode-charts-purple, #b180d7);
}
tr.subagent-child-row td:first-child { padding-left: 20px; }
.subagent-badge {
	display: inline-block;
	margin-right: 6px;
	padding: 1px 6px;
	border-radius: 4px;
	font-size: 10px;
	font-weight: 600;
	background: var(--vscode-charts-purple, #b180d7);
	color: var(--vscode-editor-background, #1e1e1e);
	vertical-align: middle;
}

#no-events { text-align: center; padding: 40px; opacity: 0.6; }
</style>
</head>
<body>

<div class="header">
	<h1>Agent Debug</h1>
	<span class="session-badge" id="session-badge">No Session</span>
	<div class="header-spacer"></div>
</div>

<div class="content">
	<div id="home">
		<h2>Agent Debug</h2>
		<p>Inspect tool calls, LLM requests, and sub-agent activity in real time.</p>
		<button id="btn-attach">Attach to Current Session</button>
	</div>

	<div id="session">
		<div class="summary-row">
			<div class="summary-card"><div class="label">Tool Calls</div><div class="value" id="s-tools">0</div></div>
			<div class="summary-card"><div class="label">Total Tokens</div><div class="value" id="s-tokens">0</div></div>
			<div class="summary-card"><div class="label">Duration</div><div class="value" id="s-duration">-</div></div>
			<div class="summary-card"><div class="label">Errors</div><div class="value" id="s-errors">0</div></div>
			<div class="summary-card"><div class="label">Cached Ratio</div><div class="value" id="s-cached">0%</div></div>
		</div>

		<div class="filter-bar">
			<label><input type="checkbox" data-cat="discovery" checked><span>Discovery</span></label>
			<label><input type="checkbox" data-cat="toolCall" checked><span>Tools</span></label>
			<label><input type="checkbox" data-cat="llmRequest" checked><span>LLM Requests</span></label>
			<label><input type="checkbox" data-cat="error" checked><span>Errors</span></label>
			<label><input type="checkbox" data-cat="loopControl" checked><span>Loop</span></label>
			<div class="toolbar">
				<button id="btn-clear">Clear</button>
				<button id="btn-export">Export</button>
			</div>
		</div>

		<div id="no-events">No events yet. Run an agent session to see debug events.</div>
		<table id="event-table" style="display:none">
			<thead>
				<tr><th>Time</th><th>Type</th><th>Details</th><th>Duration</th><th>Tokens</th><th>Status</th></tr>
			</thead>
			<tbody id="event-body"></tbody>
		</table>
	</div>
</div>

<script nonce="${nonce}">
(function() {
	const vscode = acquireVsCodeApi();

	// Cache DOM elements with null checks
	let homeEl, sessionEl, tbody, tableEl, noEventsEl, sessionBadge;

	function initDOMElements() {
		homeEl = document.getElementById('home');
		sessionEl = document.getElementById('session');
		tbody = document.getElementById('event-body');
		tableEl = document.getElementById('event-table');
		noEventsEl = document.getElementById('no-events');
		sessionBadge = document.getElementById('session-badge');

		if (!homeEl || !sessionEl || !tbody || !tableEl || !noEventsEl) {
			console.error('[AgentDebug] Missing DOM elements');
			return false;
		}
		return true;
	}

	function initEventListeners() {
		const btnAttach = document.getElementById('btn-attach');
		const btnClear = document.getElementById('btn-clear');
		const btnExport = document.getElementById('btn-export');

		if (btnAttach) {
			btnAttach.addEventListener('click', () => {
				vscode.postMessage({ type: 'attachLatest' });
			});
		}
		if (btnClear) {
			btnClear.addEventListener('click', () => {
				vscode.postMessage({ type: 'clearLog' });
			});
		}
		if (btnExport) {
			btnExport.addEventListener('click', () => {
				vscode.postMessage({ type: 'exportLog' });
			});
		}

		document.querySelectorAll('.filter-bar input[type=checkbox]').forEach(cb => {
			cb.addEventListener('change', () => {
				updateFilterLabels();
				sendFilter();
			});
		});
	}

	function updateFilterLabels() {
		document.querySelectorAll('.filter-bar label').forEach(label => {
			const cb = label.querySelector('input');
			if (cb) {
				label.classList.toggle('unchecked', !cb.checked);
			}
		});
	}

	function sendFilter() {
		const checked = [];
		document.querySelectorAll('.filter-bar input[type=checkbox]:checked').forEach(cb => {
			checked.push(cb.dataset.cat);
		});
		const allChecked = document.querySelectorAll('.filter-bar input[type=checkbox]').length === checked.length;
		vscode.postMessage({ type: 'setFilter', categories: allChecked ? undefined : checked });
	}

	function handleMessage(e) {
		const msg = e.data;
		if (!msg || typeof msg.type !== 'string') {
			return;
		}
		try {
			switch (msg.type) {
				case 'eventsUpdated':
					showSession(msg);
					break;
				case 'noSession':
					if (homeEl && sessionEl) {
						homeEl.style.display = 'block';
						sessionEl.style.display = 'none';
					}
					updateSessionBadge(null);
					break;
			}
		} catch (err) {
			console.error('[AgentDebug] Error handling message:', err);
		}
	}

	function updateSessionBadge(sessionId) {
		if (!sessionBadge) return;
		if (sessionId) {
			const shortId = String(sessionId).substring(0, 8);
			sessionBadge.textContent = 'Live \u2022 ' + shortId;
			sessionBadge.classList.add('live');
		} else {
			sessionBadge.textContent = 'No Session';
			sessionBadge.classList.remove('live');
		}
	}

	function showSession(msg) {
		if (!homeEl || !sessionEl || !tableEl || !noEventsEl || !tbody) {
			console.error('[AgentDebug] showSession: missing DOM elements');
			return;
		}

		homeEl.style.display = 'none';
		sessionEl.style.display = 'block';
		updateSessionBadge(msg.sessionId);

		// Summary
		const tools = document.getElementById('s-tools');
		const tokens = document.getElementById('s-tokens');
		const duration = document.getElementById('s-duration');
		const errors = document.getElementById('s-errors');
		const cached = document.getElementById('s-cached');

		if (msg.summary) {
			if (tools) tools.textContent = msg.summary.toolCount;
			if (tokens) tokens.textContent = msg.summary.totalTokens;
			if (duration) duration.textContent = msg.summary.duration;
			if (errors) errors.textContent = msg.summary.errorCount;
			if (cached) cached.textContent = msg.summary.cachedTokenRatio;
		}

		// Table
		const rows = msg.rows || [];
		if (rows.length === 0) {
			tableEl.style.display = 'none';
			noEventsEl.style.display = '';
			return;
		}
		tableEl.style.display = '';
		noEventsEl.style.display = 'none';

		tbody.innerHTML = '';
		for (const row of rows) {
			const isChild = row.depth > 0;
			const isParent = row.isSubAgent && row.childCount > 0;
			const isSubAgentChild = !!row.subAgentName;

			const tr = document.createElement('tr');
			tr.className = 'event-row ' + (row.statusClass || '')
				+ (isChild ? ' child-row' : '')
				+ (isSubAgentChild ? ' subagent-child-row' : '');
			if (isChild) {
				tr.dataset.parent = row.id;
			}
			tr.dataset.eventId = row.id;

			// Build the Details cell content
			let detailsCellHtml = '';
			if (row.depth > 0) {
				detailsCellHtml += '<span class="indent" style="width:' + (row.depth * 16) + 'px"></span>';
			}
			if (isParent) {
				detailsCellHtml += '<span class="toggle" data-target="' + esc(row.id) + '">&#9654;</span>';
			}
			if (isSubAgentChild) {
				detailsCellHtml += '<span class="subagent-badge">&#x2937; ' + esc(row.subAgentName) + '</span>';
			}
			detailsCellHtml += esc(row.summary);
			if (isParent) {
				detailsCellHtml += '<span class="child-badge">' + esc(String(row.childCount)) + '</span>';
			}

			tr.innerHTML =
				'<td>' + esc(row.timestamp) + '</td>' +
				'<td>' + esc(row.categoryLabel) + '</td>' +
				'<td>' + detailsCellHtml + '</td>' +
				'<td>' + (row.durationMs != null ? esc(row.durationMs + 'ms') : '') + '</td>' +
				'<td>' + (row.totalTokens != null ? esc(String(row.totalTokens)) : '') + '</td>' +
				'<td>' + esc(row.statusClass ? row.statusClass.replace('status-', '') : '') + '</td>';

			const detailTr = document.createElement('tr');
			detailTr.className = 'detail-row';
			const detailTd = document.createElement('td');
			detailTd.colSpan = 6;
			let detailHtml = '<div class="detail-grid">';
			for (const [k, v] of Object.entries(row.detail || {})) {
				detailHtml += '<div class="detail-key">' + esc(k) + '</div><div>' + esc(String(v)) + '</div>';
			}
			detailHtml += '</div>';
			detailTd.innerHTML = detailHtml;
			detailTr.appendChild(detailTd);

			tr.addEventListener('click', e => {
				const toggle = e.target.closest && e.target.closest('.toggle');
				if (toggle) {
					e.stopPropagation();
					toggleChildren(toggle.dataset.target, toggle);
					return;
				}
				// For parent rows (loop start, subagent), clicking anywhere toggles children
				if (isParent) {
					const toggleEl = tr.querySelector('.toggle');
					if (toggleEl) {
						toggleChildren(toggleEl.dataset.target, toggleEl);
						return;
					}
				}
				detailTr.classList.toggle('expanded');
			});

			tbody.appendChild(tr);
			tbody.appendChild(detailTr);
		}

		// Second pass: annotate child rows with parent ids for toggle logic
		annotateParentIds(rows, tbody);

		// Auto-expand only top-level parents (depth 0) so their direct children are visible
		tbody.querySelectorAll('tr.event-row').forEach(tr => {
			const toggleEl = tr.querySelector('.toggle');
			if (toggleEl && !tr.classList.contains('child-row')) {
				toggleEl._expanded = true;
				toggleEl.innerHTML = '&#9660;';
				var pid = toggleEl.dataset.target;
				tbody.querySelectorAll('tr.event-row[data-parent="' + pid + '"]').forEach(ch => {
					ch.classList.add('visible');
				});
			}
		});
	}

	function annotateParentIds(rows, tbody) {
		const allEventRows = tbody.querySelectorAll('tr[data-event-id]');
		let parentStack = [];
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			while (parentStack.length > 0 && parentStack[parentStack.length - 1].depth >= row.depth) {
				parentStack.pop();
			}
			if (row.depth > 0 && parentStack.length > 0) {
				const pid = parentStack[parentStack.length - 1].id;
				if (allEventRows[i]) allEventRows[i].dataset.parent = pid;
			}
			if (row.isSubAgent && row.childCount > 0) {
				parentStack.push({ id: row.id, depth: row.depth });
			}
		}
	}

	function toggleChildren(parentId, toggleEl) {
		if (!parentId || !tbody) return;
		const expanding = !toggleEl._expanded;
		toggleEl._expanded = expanding;
		toggleEl.innerHTML = expanding ? '&#9660;' : '&#9654;';

		// Only toggle direct children event rows (not detail rows)
		const directChildren = tbody.querySelectorAll('tr[data-parent="' + parentId + '"]:not(.detail-row)');
		directChildren.forEach(tr => {
			if (expanding) {
				tr.classList.add('visible');
			} else {
				tr.classList.remove('visible');
				tr.classList.remove('expanded');
				// Also hide its detail row
				if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('detail-row')) {
					tr.nextElementSibling.classList.remove('visible');
					tr.nextElementSibling.classList.remove('expanded');
				}
				// If this child is itself a parent, collapse its children recursively
				const nestedToggle = tr.querySelector('.toggle');
				if (nestedToggle && nestedToggle._expanded) {
					toggleChildren(nestedToggle.dataset.target, nestedToggle);
				}
			}
		});
	}

	function esc(s) {
		if (!s) return '';
		return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
	}

	function init() {
		if (!initDOMElements()) {
			return;
		}
		initEventListeners();
		window.addEventListener('message', handleMessage);

		vscode.postMessage({ type: 'webviewReady' });
		setTimeout(() => vscode.postMessage({ type: 'webviewReady' }), 500);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
</script>
</body>
</html>`;
}
