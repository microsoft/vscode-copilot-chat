/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

/**
 * Generate a nonce for Content Security Policy
 */
function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/**
 * Generate the HTML content for the debug panel webview
 */
export function getDebugPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = getNonce();

	// Mermaid CDN for diagram rendering
	const mermaidSrc = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';

	// Marked CDN for Markdown rendering
	const markedSrc = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
	<title>Debug Panel</title>
	<style>
		:root {
			--vscode-font-family: var(--vscode-editor-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif);
			--vscode-font-size: var(--vscode-editor-font-size, 13px);
		}

		* {
			box-sizing: border-box;
		}

		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			padding: 0;
			margin: 0;
			height: 100vh;
			display: flex;
			flex-direction: column;
		}

		.header {
			padding: 8px 16px;
			background-color: var(--vscode-sideBarSectionHeader-background);
			border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.header h1 {
			margin: 0;
			font-size: 14px;
			font-weight: 600;
		}

		.header-spacer {
			flex: 1;
		}

		.mode-toggle {
			display: flex;
			align-items: center;
			gap: 6px;
			font-size: 11px;
		}

		.mode-toggle label {
			cursor: pointer;
			opacity: 0.8;
		}

		.mode-toggle input[type="checkbox"] {
			cursor: pointer;
		}

		.session-badge {
			font-size: 11px;
			padding: 2px 6px;
			border-radius: 3px;
			background-color: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}

		.ai-badge {
			background-color: var(--vscode-testing-iconPassed);
		}

		.content {
			flex: 1;
			overflow-y: auto;
			padding: 16px;
		}

		.output {
			margin-bottom: 16px;
		}

		.output-item {
			margin-bottom: 24px;
			padding-bottom: 16px;
			border-bottom: 1px solid var(--vscode-editorGroup-border);
		}

		.output-item:last-child {
			border-bottom: none;
		}

		.output-item.ai-response {
			background-color: var(--vscode-editor-selectionBackground);
			border-radius: 8px;
			padding: 16px;
			border-left: 3px solid var(--vscode-testing-iconPassed);
			margin-left: -16px;
			margin-right: -16px;
			padding-left: 16px;
			padding-right: 16px;
		}

		.session-separator {
			display: flex;
			align-items: center;
			gap: 12px;
			margin: 24px 0;
			padding: 12px 16px;
			background: linear-gradient(90deg, var(--vscode-badge-background) 0%, transparent 100%);
			border-radius: 4px;
			border-left: 3px solid var(--vscode-textLink-foreground);
		}

		.session-separator-icon {
			font-size: 16px;
		}

		.session-separator-text {
			flex: 1;
		}

		.session-separator-title {
			font-weight: 600;
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			color: var(--vscode-textLink-foreground);
		}

		.session-separator-subtitle {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			margin-top: 2px;
		}

		.ai-indicator {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			font-size: 10px;
			padding: 2px 6px;
			border-radius: 3px;
			background-color: var(--vscode-testing-iconPassed);
			color: var(--vscode-editor-background);
			margin-left: 8px;
			vertical-align: middle;
		}

		.output-title {
			font-size: 12px;
			font-weight: 600;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 8px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}

		.markdown-content {
			line-height: 1.6;
		}

		.markdown-content h2 {
			font-size: 16px;
			margin: 16px 0 8px 0;
			padding-bottom: 4px;
			border-bottom: 1px solid var(--vscode-editorGroup-border);
		}

		.markdown-content h3 {
			font-size: 14px;
			margin: 12px 0 6px 0;
		}

		.markdown-content table {
			width: 100%;
			border-collapse: collapse;
			margin: 8px 0;
			font-size: 12px;
		}

		.markdown-content th,
		.markdown-content td {
			padding: 6px 10px;
			border: 1px solid var(--vscode-editorGroup-border);
			text-align: left;
		}

		.markdown-content th {
			background-color: var(--vscode-sideBarSectionHeader-background);
			font-weight: 600;
		}

		.markdown-content tr:nth-child(even) {
			background-color: var(--vscode-list-hoverBackground);
		}

		.markdown-content code {
			font-family: var(--vscode-editor-font-family);
			background-color: var(--vscode-textCodeBlock-background);
			padding: 1px 4px;
			border-radius: 3px;
			font-size: 12px;
		}

		.markdown-content pre {
			background-color: var(--vscode-textCodeBlock-background);
			padding: 12px;
			border-radius: 4px;
			overflow-x: auto;
		}

		.markdown-content pre code {
			padding: 0;
			background: none;
		}

		.markdown-content details {
			margin: 8px 0;
		}

		.markdown-content summary {
			cursor: pointer;
			padding: 4px;
			background-color: var(--vscode-list-hoverBackground);
			border-radius: 3px;
		}

		.markdown-content details[open] summary {
			margin-bottom: 8px;
		}

		.mermaid-container {
			margin: 16px 0;
			padding: 16px;
			background-color: var(--vscode-editor-background);
			border: 1px solid var(--vscode-editorGroup-border);
			border-radius: 4px;
			overflow-x: auto;
		}

		.mermaid {
			text-align: center;
		}

		.error-message {
			padding: 12px;
			background-color: var(--vscode-inputValidation-errorBackground);
			border: 1px solid var(--vscode-inputValidation-errorBorder);
			border-radius: 4px;
			color: var(--vscode-errorForeground);
		}

		.input-container {
			padding: 12px 16px;
			background-color: var(--vscode-sideBar-background);
			border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
		}

		.input-row {
			display: flex;
			gap: 8px;
		}

		.query-input {
			flex: 1;
			padding: 8px 12px;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-input-foreground);
			background-color: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			outline: none;
		}

		.query-input:focus {
			border-color: var(--vscode-focusBorder);
		}

		.query-input::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}

		.submit-btn {
			padding: 8px 16px;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-button-foreground);
			background-color: var(--vscode-button-background);
			border: none;
			border-radius: 4px;
			cursor: pointer;
		}

		.submit-btn:hover {
			background-color: var(--vscode-button-hoverBackground);
		}

		.quick-actions {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
			margin-top: 8px;
		}

		.quick-btn {
			padding: 4px 8px;
			font-size: 11px;
			color: var(--vscode-textLink-foreground);
			background: none;
			border: 1px solid var(--vscode-textLink-foreground);
			border-radius: 3px;
			cursor: pointer;
			opacity: 0.8;
		}

		.quick-btn:hover {
			opacity: 1;
			background-color: var(--vscode-list-hoverBackground);
		}

		.welcome {
			text-align: center;
			padding: 40px 20px;
			color: var(--vscode-descriptionForeground);
		}

		.welcome h2 {
			margin-bottom: 16px;
		}

		.welcome p {
			margin-bottom: 8px;
		}

		.loading {
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
			color: var(--vscode-descriptionForeground);
		}

		.loading::after {
			content: '';
			width: 16px;
			height: 16px;
			margin-left: 8px;
			border: 2px solid var(--vscode-progressBar-background);
			border-top-color: transparent;
			border-radius: 50%;
			animation: spin 1s linear infinite;
		}

		@keyframes spin {
			to { transform: rotate(360deg); }
		}

		.user-query {
			margin-bottom: 16px;
			padding: 12px 16px;
			background-color: var(--vscode-input-background);
			border-radius: 6px;
			border-left: 3px solid var(--vscode-textLink-foreground);
		}

		.user-query-label {
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 4px;
		}

		.user-query-text {
			color: var(--vscode-foreground);
			line-height: 1.4;
		}
	</style>
</head>
<body>
	<div class="header">
		<h1>Debug Panel</h1>
		<span class="session-badge" id="session-badge">No Session</span>
		<div class="header-spacer"></div>
		<div class="mode-toggle">
			<input type="checkbox" id="ai-mode" />
			<label for="ai-mode">AI Mode</label>
			<span class="session-badge ai-badge" id="ai-badge" style="display: none;">AI</span>
		</div>
	</div>

	<div class="content" id="content">
		<div class="welcome">
			<h2>Welcome to the Debug Panel</h2>
			<p>Analyze and visualize agent sessions, tool calls, and trajectories.</p>
			<p><strong>Local Mode:</strong> Type commands like /summary, /flow, /errors for quick analysis.</p>
			<p><strong>AI Mode:</strong> Enable AI mode to ask natural language questions about your session.</p>
		</div>
	</div>

	<div class="input-container">
		<div class="input-row">
			<input type="text" class="query-input" id="query-input" placeholder="Enter a command (e.g., /summary, /flow, /errors)" />
			<button class="submit-btn" id="submit-btn">Run</button>
		</div>
		<div class="quick-actions" id="quick-actions">
			<button class="quick-btn" data-command="/summary">Summary</button>
			<button class="quick-btn" data-command="/tools">Tools</button>
			<button class="quick-btn" data-command="/errors">Errors</button>
			<button class="quick-btn" data-command="/thinking">Thinking</button>
			<button class="quick-btn" data-command="/tokens">Tokens</button>
			<button class="quick-btn" data-command="/flow">Flow</button>
			<button class="quick-btn" data-command="/sequence">Sequence</button>
			<button class="quick-btn" data-command="/transcript">Transcript</button>
			<button class="quick-btn" data-command="/load">Load Session</button>
			<button class="quick-btn" data-command="/help">Help</button>
		</div>
		<div class="quick-actions" id="ai-quick-actions" style="display: none;">
			<button class="quick-btn" data-ai-query="What went wrong in my last request?">What went wrong?</button>
			<button class="quick-btn" data-ai-query="Show me the agent hierarchy as a diagram">Show hierarchy</button>
			<button class="quick-btn" data-ai-query="Analyze token usage and suggest optimizations">Token analysis</button>
			<button class="quick-btn" data-ai-query="What tools were called and how long did they take?">Tool performance</button>
			<button class="quick-btn" data-ai-query="Summarize the conversation flow">Summarize flow</button>
		</div>
	</div>

	<script nonce="${nonce}" src="${markedSrc}"></script>
	<script nonce="${nonce}" type="module">
		import mermaid from '${mermaidSrc}';

		// Initialize mermaid with VS Code-friendly theme
		mermaid.initialize({
			startOnLoad: false,
			theme: 'base',
			themeVariables: {
				primaryColor: '#4fc3f7',
				primaryTextColor: '#fff',
				primaryBorderColor: '#29b6f6',
				lineColor: '#90a4ae',
				secondaryColor: '#b2dfdb',
				tertiaryColor: '#fff3e0'
			},
			flowchart: {
				curve: 'basis',
				htmlLabels: true
			},
			sequence: {
				diagramMarginX: 10,
				diagramMarginY: 10
			}
		});

		const vscode = acquireVsCodeApi();
		const content = document.getElementById('content');
		const input = document.getElementById('query-input');
		const submitBtn = document.getElementById('submit-btn');
		const sessionBadge = document.getElementById('session-badge');
		const aiModeToggle = document.getElementById('ai-mode');
		const aiBadge = document.getElementById('ai-badge');
		const quickActions = document.getElementById('quick-actions');
		const aiQuickActions = document.getElementById('ai-quick-actions');

		let isAiMode = false;

		// Handle AI mode toggle
		aiModeToggle.addEventListener('change', () => {
			isAiMode = aiModeToggle.checked;
			aiBadge.style.display = isAiMode ? 'inline' : 'none';
			quickActions.style.display = isAiMode ? 'none' : 'flex';
			aiQuickActions.style.display = isAiMode ? 'flex' : 'none';
			input.placeholder = isAiMode
				? 'Ask a question about your session (e.g., What went wrong?)'
				: 'Enter a command (e.g., /summary, /flow, /errors)';
		});

		// Handle form submission
		function submitQuery() {
			const command = input.value.trim();
			if (!command) return;

			// Determine if this is an AI query (AI mode enabled OR natural language without slash)
			const isAiQuery = isAiMode || !command.startsWith('/');

			// Show user's query
			if (isAiQuery) {
				addUserQuery(command);
			}

			// Add loading indicator
			const loadingDiv = document.createElement('div');
			loadingDiv.className = 'loading';
			loadingDiv.textContent = isAiQuery ? 'Analyzing with AI, please wait...' : 'Processing...';
			content.appendChild(loadingDiv);
			content.scrollTop = content.scrollHeight;

			// Send to extension
			if (command.toLowerCase() === '/load') {
				vscode.postMessage({ type: 'load' });
			} else if (isAiQuery) {
				// AI mode or natural language query
				vscode.postMessage({ type: 'aiQuery', query: command });
			} else {
				vscode.postMessage({ type: 'query', command });
			}

			input.value = '';
		}

		submitBtn.addEventListener('click', submitQuery);
		input.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') submitQuery();
		});

		// Handle quick action buttons (local commands)
		document.querySelectorAll('.quick-btn[data-command]').forEach(btn => {
			btn.addEventListener('click', () => {
				const cmd = btn.getAttribute('data-command');
				if (cmd === '/load') {
					vscode.postMessage({ type: 'load' });
				} else {
					vscode.postMessage({ type: 'query', command: cmd });
				}
			});
		});

		// Handle AI quick action buttons
		document.querySelectorAll('.quick-btn[data-ai-query]').forEach(btn => {
			btn.addEventListener('click', () => {
				const query = btn.getAttribute('data-ai-query');
				// Show user's query
				addUserQuery(query);
				// Add loading indicator
				const loadingDiv = document.createElement('div');
				loadingDiv.className = 'loading';
				loadingDiv.textContent = 'Analyzing with AI, please wait...';
				content.appendChild(loadingDiv);
				content.scrollTop = content.scrollHeight;
				// Remove welcome
				const welcome = content.querySelector('.welcome');
				if (welcome) welcome.remove();

				vscode.postMessage({ type: 'aiQuery', query });
			});
		});

		// Handle messages from extension
		window.addEventListener('message', async (event) => {
			const message = event.data;

			// Remove loading indicator
			const loading = content.querySelector('.loading');
			if (loading) loading.remove();

			// Remove welcome message on first result
			const welcome = content.querySelector('.welcome');
			if (welcome) welcome.remove();

			if (message.type === 'sessionInfo') {
				updateSessionBadge(message.sessionSource, message.sessionFile);
				return;
			}

			if (message.type === 'error') {
				addErrorOutput(message.error);
				return;
			}

			if (message.type === 'separator') {
				addSessionSeparator(message.title, message.subtitle);
				return;
			}

			if (message.type === 'result') {
				await addResultOutput(message);
			}
		});

		function updateSessionBadge(source, file) {
			if (source === 'live') {
				sessionBadge.textContent = 'Live Session';
				sessionBadge.style.backgroundColor = 'var(--vscode-testing-iconPassed)';
			} else if (source === 'chatreplay' || source === 'trajectory' || source === 'transcript') {
				sessionBadge.textContent = file || 'Loaded File';
				sessionBadge.style.backgroundColor = 'var(--vscode-badge-background)';
			} else {
				sessionBadge.textContent = 'No Session';
				sessionBadge.style.backgroundColor = 'var(--vscode-badge-background)';
			}
		}

		function addUserQuery(query) {
			// Remove welcome message
			const welcome = content.querySelector('.welcome');
			if (welcome) welcome.remove();

			const div = document.createElement('div');
			div.className = 'user-query';
			div.innerHTML = '<div class="user-query-label">Your Question</div>' +
				'<div class="user-query-text">' + escapeHtml(query) + '</div>';
			content.appendChild(div);
			content.scrollTop = content.scrollHeight;
		}

		function addSessionSeparator(title, subtitle) {
			const div = document.createElement('div');
			div.className = 'session-separator';
			div.innerHTML = '<span class="session-separator-icon">📁</span>' +
				'<div class="session-separator-text">' +
				'<div class="session-separator-title">' + escapeHtml(title || 'New Session') + '</div>' +
				(subtitle ? '<div class="session-separator-subtitle">' + escapeHtml(subtitle) + '</div>' : '') +
				'</div>';
			content.appendChild(div);
			content.scrollTop = content.scrollHeight;
		}

		function addErrorOutput(error) {
			const div = document.createElement('div');
			div.className = 'output-item';
			div.innerHTML = '<div class="error-message">' + escapeHtml(error) + '</div>';
			content.appendChild(div);
			content.scrollTop = content.scrollHeight;
		}

		async function addResultOutput(message) {
			const div = document.createElement('div');
			div.className = message.isAiResponse ? 'output-item ai-response' : 'output-item';

			let html = '';

			if (message.title) {
				html += '<div class="output-title">' + escapeHtml(message.title);
				if (message.isAiResponse) {
					html += '<span class="ai-indicator">✨ AI</span>';
				}
				html += '</div>';
			}

			if (message.markdown) {
				// Render markdown using marked
				const rendered = marked.parse(message.markdown);
				html += '<div class="markdown-content">' + rendered + '</div>';
			}

			if (message.mermaid) {
				html += '<div class="mermaid-container"><pre class="mermaid">' + escapeHtml(message.mermaid) + '</pre></div>';
			}

			div.innerHTML = html;
			content.appendChild(div);

			// Convert mermaid code blocks from markdown to mermaid-renderable format
			// marked converts \`\`\`mermaid to <pre><code class="language-mermaid">
			const mermaidCodeBlocks = div.querySelectorAll('code.language-mermaid');
			mermaidCodeBlocks.forEach(codeBlock => {
				const pre = codeBlock.parentElement;
				if (pre && pre.tagName === 'PRE') {
					// Create a new mermaid container
					const container = document.createElement('div');
					container.className = 'mermaid-container';
					const mermaidPre = document.createElement('pre');
					mermaidPre.className = 'mermaid';
					mermaidPre.textContent = codeBlock.textContent;
					container.appendChild(mermaidPre);
					pre.replaceWith(container);
				}
			});

			// Render all mermaid diagrams (both from message.mermaid and markdown code blocks)
			const mermaidElements = div.querySelectorAll('.mermaid');
			if (mermaidElements.length > 0) {
				try {
					await mermaid.run({
						nodes: mermaidElements
					});
				} catch (err) {
					console.error('Mermaid rendering error:', err);
				}
			}

			content.scrollTop = content.scrollHeight;
		}

		function escapeHtml(text) {
			const div = document.createElement('div');
			div.textContent = text;
			return div.innerHTML;
		}

		// Notify extension that webview is ready
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
}
