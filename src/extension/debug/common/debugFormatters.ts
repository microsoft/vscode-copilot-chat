/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DebugItemStatus, DebugSession, DebugSubAgent, DebugToolCall, DebugTurn } from './debugTypes';

/**
 * Format duration in a human-readable way
 */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) {
		return '-';
	}
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	return `${minutes}m ${seconds}s`;
}

/**
 * Format a timestamp
 */
export function formatTimestamp(date: Date | undefined): string {
	if (!date) {
		return '-';
	}
	return date.toLocaleTimeString();
}

/**
 * Format status with emoji
 */
export function formatStatus(status: DebugItemStatus): string {
	switch (status) {
		case DebugItemStatus.Success:
			return '✅ Success';
		case DebugItemStatus.Failure:
			return '❌ Failed';
		case DebugItemStatus.Cancelled:
			return '⚠️ Cancelled';
		case DebugItemStatus.InProgress:
			return '🔄 In Progress';
	}
}

/**
 * Format status as a short badge
 */
export function formatStatusBadge(status: DebugItemStatus): string {
	switch (status) {
		case DebugItemStatus.Success:
			return '✅';
		case DebugItemStatus.Failure:
			return '❌';
		case DebugItemStatus.Cancelled:
			return '⚠️';
		case DebugItemStatus.InProgress:
			return '🔄';
	}
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return text.substring(0, maxLength - 3) + '...';
}

/**
 * Escape text for Markdown table cells
 */
export function escapeTableCell(text: string): string {
	return text
		.replace(/\|/g, '\\|')
		.replace(/\n/g, ' ')
		.replace(/\r/g, '');
}

/**
 * Format a session summary as Markdown
 */
export function formatSessionSummary(session: DebugSession): string {
	const lines: string[] = [];
	const m = session.metrics;

	lines.push('## 📊 Session Summary\n');

	// Overview section
	lines.push('### Overview\n');
	lines.push(`| Metric | Value |`);
	lines.push(`|--------|-------|`);
	lines.push(`| Session ID | \`${truncate(session.sessionId, 20)}\` |`);
	lines.push(`| Source | ${session.source} |`);
	if (session.model) {
		lines.push(`| Model | ${session.model} |`);
	}
	if (session.startTime) {
		lines.push(`| Started | ${formatTimestamp(session.startTime)} |`);
	}
	if (m.totalDurationMs) {
		lines.push(`| Duration | ${formatDuration(m.totalDurationMs)} |`);
	}
	lines.push('');

	// Activity section
	lines.push('### Activity\n');
	lines.push(`| Metric | Count |`);
	lines.push(`|--------|-------|`);
	lines.push(`| Total Turns | ${m.totalTurns} |`);
	lines.push(`| Tool Calls | ${m.totalToolCalls} |`);
	lines.push(`| Model Requests | ${m.totalRequests} |`);
	lines.push(`| Sub-Agents | ${m.totalSubAgents} |`);
	if (m.maxSubAgentDepth > 0) {
		lines.push(`| Max Nesting Depth | ${m.maxSubAgentDepth} |`);
	}
	lines.push('');

	// Errors section (if any)
	if (m.failedToolCalls > 0 || m.failedRequests > 0) {
		lines.push('### ⚠️ Errors\n');
		lines.push(`| Type | Count |`);
		lines.push(`|------|-------|`);
		if (m.failedToolCalls > 0) {
			lines.push(`| Failed Tool Calls | ${m.failedToolCalls} |`);
		}
		if (m.failedRequests > 0) {
			lines.push(`| Failed Requests | ${m.failedRequests} |`);
		}
		lines.push('');

		// Error types breakdown
		if (m.errorTypes.size > 0) {
			lines.push('<details><summary>Error Types</summary>\n');
			lines.push(`| Error Type | Count |`);
			lines.push(`|------------|-------|`);
			for (const [errorType, count] of m.errorTypes) {
				lines.push(`| ${errorType} | ${count} |`);
			}
			lines.push('\n</details>\n');
		}
	}

	// Token usage (if available)
	if (m.totalPromptTokens || m.totalCompletionTokens) {
		lines.push('### 🎯 Token Usage\n');
		lines.push(`| Type | Tokens |`);
		lines.push(`|------|--------|`);
		if (m.totalPromptTokens) {
			lines.push(`| Prompt Tokens | ${m.totalPromptTokens.toLocaleString()} |`);
		}
		if (m.totalCompletionTokens) {
			lines.push(`| Completion Tokens | ${m.totalCompletionTokens.toLocaleString()} |`);
		}
		if (m.totalPromptTokens && m.totalCompletionTokens) {
			lines.push(`| **Total** | **${(m.totalPromptTokens + m.totalCompletionTokens).toLocaleString()}** |`);
		}
		lines.push('');
	}

	// Tool usage breakdown
	if (m.toolCallsByName.size > 0) {
		lines.push('### 🔧 Tool Usage\n');
		lines.push(`| Tool | Calls |`);
		lines.push(`|------|-------|`);

		// Sort by count descending
		const sortedTools = [...m.toolCallsByName.entries()].sort((a, b) => b[1] - a[1]);
		for (const [tool, count] of sortedTools.slice(0, 15)) {
			lines.push(`| ${tool} | ${count} |`);
		}
		if (sortedTools.length > 15) {
			lines.push(`| *+${sortedTools.length - 15} more tools* | - |`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Format tool calls as a Markdown table
 */
export function formatToolCallsTable(toolCalls: DebugToolCall[], limit: number = 50): string {
	if (toolCalls.length === 0) {
		return '*No tool calls recorded.*';
	}

	const lines: string[] = [];
	lines.push('## 🔧 Tool Calls\n');
	lines.push(`| # | Status | Tool | Duration | Args Preview |`);
	lines.push(`|---|--------|------|----------|--------------|`);

	const displayCalls = toolCalls.slice(0, limit);
	for (let i = 0; i < displayCalls.length; i++) {
		const tool = displayCalls[i];
		const argsPreview = truncate(JSON.stringify(tool.args || {}), 40);
		lines.push(`| ${i + 1} | ${formatStatusBadge(tool.status)} | ${tool.name} | ${formatDuration(tool.durationMs)} | ${escapeTableCell(argsPreview)} |`);
	}

	if (toolCalls.length > limit) {
		lines.push(`\n*Showing ${limit} of ${toolCalls.length} tool calls.*`);
	}

	return lines.join('\n');
}

/**
 * Format errors/failures as Markdown
 */
export function formatErrorsReport(session: DebugSession): string {
	const lines: string[] = [];

	// Collect failed tool calls
	const failedTools = session.toolCalls.filter(t => t.status === DebugItemStatus.Failure);

	// Collect failed requests
	const failedRequests = session.requests.filter(r => r.status === DebugItemStatus.Failure);

	if (failedTools.length === 0 && failedRequests.length === 0) {
		return '## ✅ No Errors\n\nNo failures detected in this session.';
	}

	lines.push('## ❌ Error Report\n');

	// Failed tool calls
	if (failedTools.length > 0) {
		lines.push(`### Failed Tool Calls (${failedTools.length})\n`);
		lines.push(`| Tool | Error | Turn |`);
		lines.push(`|------|-------|------|`);

		for (const tool of failedTools) {
			const errorMsg = truncate(tool.error || 'Unknown error', 50);
			lines.push(`| ${tool.name} | ${escapeTableCell(errorMsg)} | ${tool.turnId} |`);
		}
		lines.push('');
	}

	// Failed requests
	if (failedRequests.length > 0) {
		lines.push(`### Failed Requests (${failedRequests.length})\n`);
		lines.push(`| Request | Type | Error |`);
		lines.push(`|---------|------|-------|`);

		for (const req of failedRequests) {
			const errorMsg = truncate(req.error || 'Unknown', 50);
			lines.push(`| ${req.name} | ${req.responseType || '-'} | ${escapeTableCell(errorMsg)} |`);
		}
		lines.push('');
	}

	// Error details
	lines.push('### Error Details\n');
	for (const tool of failedTools.slice(0, 10)) {
		lines.push(`<details><summary>❌ ${tool.name}</summary>\n`);
		lines.push('```');
		lines.push(tool.error || 'No error message');
		lines.push('```\n');
		if (tool.args) {
			lines.push('**Arguments:**');
			lines.push('```json');
			lines.push(JSON.stringify(tool.args, null, 2).substring(0, 500));
			lines.push('```');
		}
		lines.push('\n</details>\n');
	}

	return lines.join('\n');
}

/**
 * Format timeline as Markdown
 */
export function formatTimeline(session: DebugSession): string {
	const lines: string[] = [];

	lines.push('## 📅 Timeline\n');

	for (let i = 0; i < session.turns.length; i++) {
		const turn = session.turns[i];
		const time = formatTimestamp(turn.timestamp);

		lines.push(`### Turn ${i + 1} ${formatStatusBadge(turn.status)}`);
		lines.push(`*${time}* | Duration: ${formatDuration(turn.durationMs)}\n`);

		// User prompt
		lines.push(`**User:** ${truncate(turn.prompt, 100)}\n`);

		// Tool calls summary
		if (turn.toolCalls.length > 0) {
			lines.push(`<details><summary>🔧 ${turn.toolCalls.length} tool calls</summary>\n`);
			for (const tool of turn.toolCalls.slice(0, 20)) {
				const subAgentNote = tool.subAgentSessionId ? ' 🔀' : '';
				lines.push(`- ${formatStatusBadge(tool.status)} **${tool.name}**${subAgentNote} (${formatDuration(tool.durationMs)})`);
			}
			if (turn.toolCalls.length > 20) {
				lines.push(`\n*+${turn.toolCalls.length - 20} more...*`);
			}
			lines.push('\n</details>\n');
		}

		// Agent response
		if (turn.response) {
			lines.push(`**Agent:** ${truncate(turn.response, 150)}\n`);
		}

		lines.push('---\n');
	}

	return lines.join('\n');
}

/**
 * Format sub-agents as Markdown
 */
export function formatSubAgentsReport(session: DebugSession): string {
	if (session.subAgents.length === 0) {
		return '## 🔀 Sub-Agents\n\n*No sub-agents were invoked in this session.*';
	}

	const lines: string[] = [];
	lines.push('## 🔀 Sub-Agent Report\n');
	lines.push(`Total sub-agent invocations: **${session.metrics.totalSubAgents}**`);
	lines.push(`Maximum nesting depth: **${session.metrics.maxSubAgentDepth}**\n`);

	function formatSubAgent(subAgent: DebugSubAgent, indent: string = ''): void {
		const toolCount = subAgent.toolCalls.length;
		const childCount = subAgent.children.length;

		lines.push(`${indent}- **${subAgent.name}** (${toolCount} tools${childCount > 0 ? `, ${childCount} nested` : ''})`);
		lines.push(`${indent}  - Session: \`${truncate(subAgent.sessionId, 15)}\``);

		if (subAgent.summary) {
			lines.push(`${indent}  - Summary: ${truncate(subAgent.summary, 80)}`);
		}

		// Show some tool calls
		if (toolCount > 0) {
			const previewTools = subAgent.toolCalls.slice(0, 5);
			lines.push(`${indent}  - Tools: ${previewTools.map(t => t.name).join(', ')}${toolCount > 5 ? ` (+${toolCount - 5})` : ''}`);
		}

		// Recurse into children
		for (const child of subAgent.children) {
			formatSubAgent(child, indent + '  ');
		}
	}

	for (const subAgent of session.subAgents) {
		formatSubAgent(subAgent);
	}

	return lines.join('\n');
}

/**
 * Format search results as Markdown
 */
export function formatSearchResults(
	toolCalls: DebugToolCall[],
	turns: DebugTurn[],
	searchTerm: string
): string {
	const lines: string[] = [];

	lines.push(`## 🔍 Search Results for "${searchTerm}"\n`);

	// Search in tool calls
	const matchingTools = toolCalls.filter(t =>
		t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
		JSON.stringify(t.args).toLowerCase().includes(searchTerm.toLowerCase()) ||
		(t.result && t.result.toLowerCase().includes(searchTerm.toLowerCase()))
	);

	if (matchingTools.length > 0) {
		lines.push(`### Tool Calls (${matchingTools.length} matches)\n`);
		lines.push(`| # | Tool | Turn | Args Preview |`);
		lines.push(`|---|------|------|--------------|`);

		for (let i = 0; i < Math.min(matchingTools.length, 20); i++) {
			const tool = matchingTools[i];
			const argsPreview = truncate(JSON.stringify(tool.args || {}), 40);
			lines.push(`| ${i + 1} | ${tool.name} | ${tool.turnId} | ${escapeTableCell(argsPreview)} |`);
		}

		if (matchingTools.length > 20) {
			lines.push(`\n*+${matchingTools.length - 20} more matches...*`);
		}
		lines.push('');
	}

	// Search in turns
	const matchingTurns = turns.filter(t =>
		t.prompt.toLowerCase().includes(searchTerm.toLowerCase()) ||
		(t.response && t.response.toLowerCase().includes(searchTerm.toLowerCase()))
	);

	if (matchingTurns.length > 0) {
		lines.push(`### Turns (${matchingTurns.length} matches)\n`);
		for (const turn of matchingTurns.slice(0, 10)) {
			lines.push(`<details><summary>Turn ${turn.index + 1}</summary>\n`);
			lines.push(`**Prompt:** ${truncate(turn.prompt, 200)}\n`);
			if (turn.response) {
				lines.push(`**Response:** ${truncate(turn.response, 200)}\n`);
			}
			lines.push('</details>\n');
		}
	}

	if (matchingTools.length === 0 && matchingTurns.length === 0) {
		lines.push(`*No matches found for "${searchTerm}".*`);
	}

	return lines.join('\n');
}

/**
 * Format help text
 */
export function formatHelp(): string {
	return `## Debug Panel Commands

### Queries
| Command | Description |
|---------|-------------|
| \`/summary\` | Show session overview and metrics |
| \`/tools\` | List all tool calls |
| \`/errors\` | Show failures and errors |
| \`/timeline\` | Chronological view of turns |
| \`/subagents\` | Show sub-agent hierarchy |
| \`/search <term>\` | Search tool calls and turns |

### Analysis
| Command | Description |
|---------|-------------|
| \`/thinking\` | Show reasoning/chain-of-thought content |
| \`/tokens\` | Token usage breakdown |
| \`/transcript\` | Raw transcript events (for .jsonl files) |

### Diagrams
| Command | Description |
|---------|-------------|
| \`/flow\` | Control flow diagram |
| \`/flow --detailed\` | Detailed control flow |
| \`/dataflow\` | Data flow diagram |
| \`/tree\` | Sub-agent hierarchy tree |
| \`/sequence\` | Sequence diagram |

### Session
| Command | Description |
|---------|-------------|
| \`/load\` | Load a session file (.chatreplay.json, .trajectory.json, .jsonl) |
| \`/refresh\` | Refresh live session data |
| \`/help\` | Show this help |

---
*Tip: Mermaid diagrams render inline when \`mermaid-chat.enabled\` is set.*
`;
}

/**
 * Format thinking/reasoning content
 */
export function formatThinkingReport(session: DebugSession, detailed?: boolean): string {
	const lines: string[] = [];

	lines.push('## Thinking/Reasoning Content\n');

	// Collect thinking from various sources
	const thinkingBlocks: Array<{ turnId: string; toolId?: string; toolName?: string; text: string; tokens?: number }> = [];

	// From session.thinking (transcript source)
	if (session.thinking && session.thinking.length > 0) {
		for (const t of session.thinking) {
			thinkingBlocks.push({
				turnId: t.turnId,
				toolId: t.toolCallId,
				text: t.text,
				tokens: t.tokens
			});
		}
	}

	// From tool calls
	for (const tc of session.toolCalls) {
		if (tc.thinking) {
			thinkingBlocks.push({
				turnId: tc.turnId,
				toolId: tc.id,
				toolName: tc.name,
				text: tc.thinking
			});
		}
	}

	if (thinkingBlocks.length === 0) {
		lines.push('*No thinking/reasoning content available in this session.*\n');
		lines.push('**Note:** Reasoning content is captured when:');
		lines.push('- Using models with extended thinking (Claude, o1, etc.)');
		lines.push('- Loading from transcript (.jsonl) or trajectory files');
		lines.push('- The session includes `reasoningText` in assistant messages');
		return lines.join('\n');
	}

	lines.push(`Found **${thinkingBlocks.length}** thinking blocks.\n`);

	// Group by turn
	const byTurn = new Map<string, typeof thinkingBlocks>();
	for (const block of thinkingBlocks) {
		if (!byTurn.has(block.turnId)) {
			byTurn.set(block.turnId, []);
		}
		byTurn.get(block.turnId)!.push(block);
	}

	for (const [turnId, blocks] of byTurn) {
		lines.push(`### ${turnId}\n`);

		for (const block of blocks) {
			const label = block.toolName ? `Tool: ${block.toolName}` : 'Assistant';
			const tokenInfo = block.tokens ? ` (${block.tokens} tokens)` : '';

			if (detailed) {
				lines.push(`<details open><summary>${label}${tokenInfo}</summary>\n`);
				lines.push('```');
				lines.push(block.text);
				lines.push('```\n');
				lines.push('</details>\n');
			} else {
				lines.push(`<details><summary>${label}${tokenInfo}</summary>\n`);
				lines.push('```');
				lines.push(truncate(block.text, 1000));
				lines.push('```\n');
				lines.push('</details>\n');
			}
		}
	}

	return lines.join('\n');
}

/**
 * Format token usage report
 */
export function formatTokensReport(session: DebugSession): string {
	const lines: string[] = [];

	lines.push('## Token Usage Analysis\n');

	const m = session.metrics;

	// Overall summary
	lines.push('### Overall Usage\n');
	lines.push(`| Metric | Value |`);
	lines.push(`|--------|-------|`);

	if (m.totalPromptTokens) {
		lines.push(`| Total Prompt Tokens | ${m.totalPromptTokens.toLocaleString()} |`);
	}
	if (m.totalCompletionTokens) {
		lines.push(`| Total Completion Tokens | ${m.totalCompletionTokens.toLocaleString()} |`);
	}
	if (m.totalPromptTokens && m.totalCompletionTokens) {
		const total = m.totalPromptTokens + m.totalCompletionTokens;
		lines.push(`| **Total Tokens** | **${total.toLocaleString()}** |`);

		// Estimate cost (rough estimate)
		const promptCost = (m.totalPromptTokens / 1000000) * 3; // $3/M tokens rough estimate
		const completionCost = (m.totalCompletionTokens / 1000000) * 15; // $15/M tokens rough estimate
		lines.push(`| Estimated Cost* | ~$${(promptCost + completionCost).toFixed(4)} |`);
	}
	lines.push('');

	// Per-request breakdown
	if (session.requests.length > 0) {
		lines.push('### Per-Request Breakdown\n');
		lines.push(`| Request | Model | Prompt | Completion | Total |`);
		lines.push(`|---------|-------|--------|------------|-------|`);

		const requestsWithTokens = session.requests.filter(r => r.promptTokens || r.completionTokens);

		for (const req of requestsWithTokens.slice(0, 20)) {
			const prompt = req.promptTokens?.toLocaleString() || '-';
			const completion = req.completionTokens?.toLocaleString() || '-';
			const total = (req.promptTokens && req.completionTokens)
				? (req.promptTokens + req.completionTokens).toLocaleString()
				: '-';
			lines.push(`| ${truncate(req.name, 30)} | ${req.model || '-'} | ${prompt} | ${completion} | ${total} |`);
		}

		if (requestsWithTokens.length > 20) {
			lines.push(`\n*Showing 20 of ${requestsWithTokens.length} requests with token data.*`);
		}
		lines.push('');
	}

	// Token budget (if available)
	if (session.tokenBudget && session.tokenBudget.length > 0) {
		lines.push('### Token Budget Allocation\n');
		lines.push('```');

		function formatBudgetNode(node: { name: string; tokens: number; maxTokens?: number; percentage?: number; children?: typeof session.tokenBudget }, indent: string = ''): void {
			const pct = node.percentage ? ` (${node.percentage.toFixed(1)}%)` : '';
			const max = node.maxTokens ? ` / ${node.maxTokens}` : '';
			lines.push(`${indent}${node.name}: ${node.tokens}${max}${pct}`);

			if (node.children) {
				for (const child of node.children) {
					formatBudgetNode(child, indent + '  ');
				}
			}
		}

		for (const node of session.tokenBudget) {
			formatBudgetNode(node);
		}

		lines.push('```\n');
	}

	if (!m.totalPromptTokens && !m.totalCompletionTokens) {
		lines.push('*No token usage data available for this session.*\n');
		lines.push('**Note:** Token data is captured from:');
		lines.push('- Live sessions with model requests');
		lines.push('- ChatReplay exports with metadata');
		lines.push('- Trajectory files with metrics');
	}

	lines.push('\n*\\* Cost estimates are approximate and vary by model and provider.*');

	return lines.join('\n');
}

/**
 * Format transcript events (JSONL)
 */
export function formatTranscriptEvents(session: DebugSession, limit: number = 100): string {
	const lines: string[] = [];

	lines.push('## Transcript Events\n');

	if (!session.transcriptEvents || session.transcriptEvents.length === 0) {
		lines.push('*No transcript events available.*\n');
		lines.push('**Note:** Transcript events are only available when loading `.jsonl` transcript files.');
		lines.push('Use `/load` to load a transcript file, or try `/timeline` for a general event view.');
		return lines.join('\n');
	}

	// Session context
	if (session.sessionContext) {
		lines.push('### Session Context\n');
		lines.push(`| Property | Value |`);
		lines.push(`|----------|-------|`);
		if (session.sessionContext.copilotVersion) {
			lines.push(`| Copilot Version | ${session.sessionContext.copilotVersion} |`);
		}
		if (session.sessionContext.vscodeVersion) {
			lines.push(`| VS Code Version | ${session.sessionContext.vscodeVersion} |`);
		}
		if (session.sessionContext.cwd) {
			lines.push(`| Working Directory | \`${truncate(session.sessionContext.cwd, 50)}\` |`);
		}
		lines.push('');
	}

	lines.push(`### Events (${Math.min(session.transcriptEvents.length, limit)} of ${session.transcriptEvents.length})\n`);

	const events = session.transcriptEvents.slice(0, limit);

	// Event type icons
	const typeIcons: Record<string, string> = {
		'session.start': '🚀',
		'user.message': '👤',
		'assistant.turn_start': '🤖',
		'assistant.message': '💬',
		'tool.execution_start': '🔧',
		'tool.execution_complete': '✅',
		'assistant.turn_end': '🏁'
	};

	for (const event of events) {
		const icon = typeIcons[event.type] || '📌';
		const time = formatTimestamp(event.timestamp);

		lines.push(`<details><summary>${icon} ${event.type} @ ${time}</summary>\n`);
		lines.push('```json');
		lines.push(JSON.stringify(event.data, null, 2).substring(0, 500));
		lines.push('```\n');
		if (event.parentId) {
			lines.push(`*Parent: ${event.parentId}*`);
		}
		lines.push('</details>\n');
	}

	if (session.transcriptEvents.length > limit) {
		lines.push(`\n*+${session.transcriptEvents.length - limit} more events. Use \`/transcript --limit ${limit * 2}\` to see more.*`);
	}

	return lines.join('\n');
}
