/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IRequestLogger } from '../../../../platform/requestLogger/node/requestLogger';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import { IDebugContextService } from '../../common/debugContextService';
import { getSubagentName, isSubagentTurn } from '../../common/debugFormatters';
import { DebugSession } from '../../common/debugTypes';
import { buildSessionFromRequestLogger } from '../../node/debugSessionService';

interface IGetCurrentSessionParams {
	/** Output format: 'summary' (default), 'detailed', 'metrics' */
	format?: 'summary' | 'detailed' | 'metrics';
	/** Include individual tool call details */
	includeToolCalls?: boolean;
	/** Include request/response details */
	includeRequests?: boolean;
	/** Maximum number of turns to return (default: 20) */
	maxTurns?: number;
	/** Exclude debug subagent's own calls from the analysis (default: true when called from debug subagent) */
	excludeDebugSubagent?: boolean;
}

/**
 * Tool to get the current live session data from IRequestLogger
 * or loaded session from IDebugContextService
 */
class GetCurrentSessionTool implements ICopilotTool<IGetCurrentSessionParams> {
	public static readonly toolName = ToolName.DebugGetCurrentSession;

	constructor(
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IDebugContextService private readonly debugContext: IDebugContextService,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetCurrentSessionParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const {
			format = 'summary',
			includeToolCalls = true,
			includeRequests = false,
			maxTurns = 20,
			excludeDebugSubagent = true  // Default to excluding debug subagent's own calls
		} = options.input;

		// Check for loaded session first, then fall back to live session
		let session: DebugSession;
		let isLoadedSession = false;

		const loadedSession = this.debugContext.getLoadedSession();
		if (loadedSession) {
			session = loadedSession;
			isLoadedSession = true;
		} else {
			// Build the debug session from live data
			session = buildSessionFromRequestLogger(this.requestLogger, 'live', { excludeDebugSubagent });
		}

		if (session.turns.length === 0) {
			const source = isLoadedSession ? 'loaded session' : 'current chat session';
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`No session data found. The ${source} has no recorded requests yet.`)
			]);
		}

		let output: string;
		switch (format) {
			case 'detailed':
				output = this.renderDetailed(session, maxTurns, includeToolCalls, includeRequests, isLoadedSession);
				break;
			case 'metrics':
				output = this.renderMetrics(session, isLoadedSession);
				break;
			default:
				output = this.renderSummary(session, maxTurns, includeToolCalls, isLoadedSession);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	private renderSummary(session: DebugSession, maxTurns: number, includeToolCalls: boolean, isLoadedSession: boolean): string {
		const lines: string[] = [];
		const m = session.metrics;

		// Count subagent turns from prompts
		const subagentTurnsCount = session.turns.filter(t => isSubagentTurn(t.prompt)).length;

		const title = isLoadedSession
			? `# Loaded Session${session.sourceFile ? ` (${session.sourceFile})` : ''}`
			: '# Current Live Session';
		lines.push(`${title}\n`);
		lines.push('## Overview');
		lines.push(`- **Session ID:** ${session.sessionId}`);
		if (isLoadedSession && session.source) {
			lines.push(`- **Source:** ${session.source}`);
		}
		const turnsBreakdown = subagentTurnsCount > 0 ? ` (${m.totalTurns - subagentTurnsCount} main, ${subagentTurnsCount} subagent)` : '';
		lines.push(`- **Total Turns:** ${m.totalTurns}${turnsBreakdown}`);
		lines.push(`- **Total Tool Calls:** ${m.totalToolCalls}${m.failedToolCalls > 0 ? ` (${m.failedToolCalls} failed)` : ''}`);
		lines.push(`- **Total Requests:** ${m.totalRequests}${m.failedRequests > 0 ? ` (${m.failedRequests} failed)` : ''}`);
		if (m.totalPromptTokens || m.totalCompletionTokens) {
			lines.push(`- **Tokens Used:** ${m.totalPromptTokens || 0} prompt / ${m.totalCompletionTokens || 0} completion`);
		}
		if (m.totalDurationMs) {
			lines.push(`- **Total Duration:** ${(m.totalDurationMs / 1000).toFixed(1)}s`);
		}
		lines.push('');

		// Show recent turns
		const turnsToShow = session.turns.slice(-maxTurns);
		lines.push(`## Recent Turns (${turnsToShow.length} of ${session.turns.length})\n`);

		for (const turn of turnsToShow) {
			const statusIcon = turn.status === 'failure' ? '❌' : turn.status === 'cancelled' ? '⚠️' : '✅';
			const toolCount = turn.toolCalls.length;
			const prompt = turn.prompt.length > 80 ? turn.prompt.substring(0, 80) + '...' : turn.prompt;
			const subagentIndicator = isSubagentTurn(turn.prompt) ? ` 🤖 ${getSubagentName(turn.prompt)}` : '';

			lines.push(`### Turn ${turn.index + 1} ${statusIcon}${subagentIndicator}`);
			lines.push(`**Prompt:** ${prompt}`);

			if (turn.durationMs) {
				lines.push(`**Duration:** ${turn.durationMs}ms`);
			}

			if (includeToolCalls && toolCount > 0) {
				lines.push(`**Tool Calls:** ${toolCount}`);
				for (const tc of turn.toolCalls.slice(0, 5)) {
					const tcStatus = tc.status === 'failure' ? '❌' : '✅';
					const duration = tc.durationMs ? ` (${tc.durationMs}ms)` : '';
					lines.push(`  - ${tcStatus} \`${tc.name}\`${duration}`);
				}
				if (toolCount > 5) {
					lines.push(`  - ... and ${toolCount - 5} more`);
				}
			}

			if (turn.response) {
				const resp = turn.response.length > 100 ? turn.response.substring(0, 100) + '...' : turn.response;
				lines.push(`**Response preview:** ${resp}`);
			}

			lines.push('');
		}

		return lines.join('\n');
	}

	private renderDetailed(session: DebugSession, maxTurns: number, includeToolCalls: boolean, includeRequests: boolean, isLoadedSession: boolean): string {
		const lines: string[] = [];

		const title = isLoadedSession
			? `# Loaded Session (Detailed)${session.sourceFile ? `\n*Source: ${session.sourceFile}*` : ''}`
			: '# Current Live Session (Detailed)';
		lines.push(`${title}\n`);
		lines.push(`**Session ID:** \`${session.sessionId}\`\n`);

		const turnsToShow = session.turns.slice(-maxTurns);

		for (const turn of turnsToShow) {
			const statusIcon = turn.status === 'failure' ? '❌' : turn.status === 'cancelled' ? '⚠️' : '✅';

			lines.push(`---\n## Turn ${turn.index + 1} ${statusIcon}\n`);
			lines.push('### User Prompt');
			lines.push('```');
			lines.push(turn.prompt);
			lines.push('```\n');

			if (turn.timestamp) {
				lines.push(`**Timestamp:** ${turn.timestamp.toISOString()}`);
			}
			if (turn.durationMs) {
				lines.push(`**Duration:** ${turn.durationMs}ms`);
			}
			lines.push('');

			if (includeToolCalls && turn.toolCalls.length > 0) {
				lines.push('### Tool Calls\n');
				for (const tc of turn.toolCalls) {
					const tcStatus = tc.status === 'failure' ? '❌ FAILED' : '✅ OK';
					lines.push(`#### \`${tc.name}\` - ${tcStatus}`);
					lines.push(`- **ID:** \`${tc.id}\``);
					if (tc.durationMs) {
						lines.push(`- **Duration:** ${tc.durationMs}ms`);
					}

					lines.push('\n**Arguments:**');
					lines.push('```json');
					const argsStr = JSON.stringify(tc.args, null, 2);
					lines.push(argsStr.length > 300 ? argsStr.substring(0, 300) + '...' : argsStr);
					lines.push('```');

					if (tc.result) {
						lines.push('\n**Result:**');
						lines.push('```');
						lines.push(tc.result.length > 200 ? tc.result.substring(0, 200) + '...' : tc.result);
						lines.push('```');
					}

					if (tc.error) {
						lines.push('\n**Error:**');
						lines.push('```');
						lines.push(tc.error);
						lines.push('```');
					}

					if (tc.thinking) {
						lines.push('\n**Thinking:**');
						lines.push('> ' + tc.thinking.substring(0, 200).replace(/\n/g, '\n> '));
					}

					lines.push('');
				}
			}

			if (includeRequests && turn.requests.length > 0) {
				lines.push('### LLM Requests\n');
				for (const req of turn.requests) {
					const reqStatus = req.status === 'failure' ? '❌' : '✅';
					lines.push(`- ${reqStatus} **${req.name}** (${req.responseType})`);
					if (req.model) {
						lines.push(`  - Model: \`${req.model}\``);
					}
					if (req.promptTokens || req.completionTokens) {
						lines.push(`  - Tokens: ${req.promptTokens || 0} prompt / ${req.completionTokens || 0} completion`);
					}
					if (req.durationMs) {
						lines.push(`  - Duration: ${req.durationMs}ms`);
					}
					if (req.error) {
						lines.push(`  - Error: ${req.error}`);
					}
				}
				lines.push('');
			}

			if (turn.response) {
				lines.push('### Assistant Response');
				lines.push('```');
				lines.push(turn.response.length > 500 ? turn.response.substring(0, 500) + '...' : turn.response);
				lines.push('```\n');
			}
		}

		return lines.join('\n');
	}

	private renderMetrics(session: DebugSession, isLoadedSession: boolean): string {
		const lines: string[] = [];
		const m = session.metrics;

		// Count subagent turns from prompts (for chatreplay where metadata isn't available)
		const subagentTurnsCount = session.turns.filter(t => isSubagentTurn(t.prompt)).length;
		const mainAgentTurnsCount = m.totalTurns - subagentTurnsCount;

		const title = isLoadedSession
			? `# Session Metrics${session.sourceFile ? ` (${session.sourceFile})` : ''}`
			: '# Session Metrics';
		lines.push(`${title}\n`);

		lines.push('## Summary Statistics\n');
		lines.push('| Metric | Value |');
		lines.push('|--------|-------|');
		lines.push(`| Total Turns | ${m.totalTurns} |`);
		if (subagentTurnsCount > 0) {
			lines.push(`| → Main Agent Turns | ${mainAgentTurnsCount} |`);
			lines.push(`| → SubAgent Turns | ${subagentTurnsCount} |`);
		}
		lines.push(`| Total Tool Calls | ${m.totalToolCalls} |`);
		lines.push(`| Failed Tool Calls | ${m.failedToolCalls} |`);
		lines.push(`| Total Requests | ${m.totalRequests} |`);
		lines.push(`| Failed Requests | ${m.failedRequests} |`);
		lines.push(`| Total Sub-agents | ${m.totalSubAgents} |`);
		lines.push(`| Max Sub-agent Depth | ${m.maxSubAgentDepth} |`);
		if (m.totalDurationMs) {
			lines.push(`| Total Duration | ${(m.totalDurationMs / 1000).toFixed(2)}s |`);
		}
		if (m.totalPromptTokens) {
			lines.push(`| Prompt Tokens | ${m.totalPromptTokens} |`);
		}
		if (m.totalCompletionTokens) {
			lines.push(`| Completion Tokens | ${m.totalCompletionTokens} |`);
		}
		lines.push('');

		// Tool call breakdown
		if (m.toolCallsByName.size > 0) {
			lines.push('## Tool Call Breakdown\n');
			lines.push('| Tool Name | Count |');
			lines.push('|-----------|-------|');

			const sorted = Array.from(m.toolCallsByName.entries()).sort((a, b) => b[1] - a[1]);
			for (const [name, count] of sorted) {
				lines.push(`| \`${name}\` | ${count} |`);
			}
			lines.push('');
		}

		// Error breakdown
		if (m.errorTypes.size > 0) {
			lines.push('## Error Types\n');
			lines.push('| Error Type | Count |');
			lines.push('|-----------|-------|');

			for (const [type, count] of m.errorTypes) {
				lines.push(`| ${type} | ${count} |`);
			}
			lines.push('');
		}

		// Token efficiency
		if (m.totalPromptTokens && m.totalCompletionTokens && m.totalTurns > 0) {
			lines.push('## Token Efficiency\n');
			const avgPrompt = Math.round(m.totalPromptTokens / m.totalTurns);
			const avgCompletion = Math.round(m.totalCompletionTokens / m.totalTurns);
			const ratio = (m.totalCompletionTokens / m.totalPromptTokens).toFixed(2);
			lines.push(`- **Avg Prompt Tokens per Turn:** ${avgPrompt}`);
			lines.push(`- **Avg Completion Tokens per Turn:** ${avgCompletion}`);
			lines.push(`- **Output/Input Ratio:** ${ratio}`);
			lines.push('');

			// Most expensive turns by token usage
			const turnTokens = session.turns.map((turn, idx) => {
				const promptTokens = turn.requests.reduce((sum, r) => sum + (r.promptTokens || 0), 0);
				const completionTokens = turn.requests.reduce((sum, r) => sum + (r.completionTokens || 0), 0);
				const total = promptTokens + completionTokens;
				return { turnIndex: idx + 1, promptTokens, completionTokens, total, isSubagent: isSubagentTurn(turn.prompt) };
			}).filter(t => t.total > 0);

			if (turnTokens.length > 0) {
				turnTokens.sort((a, b) => b.total - a.total);
				const top5 = turnTokens.slice(0, 5);
				const totalSessionTokens = m.totalPromptTokens + m.totalCompletionTokens;

				lines.push('## Most Expensive Turns (by tokens)\n');
				lines.push('| Rank | Turn | Type | Total Tokens | % of Session |');
				lines.push('|------|------|------|--------------|--------------|');
				top5.forEach((t, i) => {
					const pct = ((t.total / totalSessionTokens) * 100).toFixed(1);
					const type = t.isSubagent ? '🤖 Sub' : 'Main';
					lines.push(`| ${i + 1} | ${t.turnIndex} | ${type} | ${t.total.toLocaleString()} | ${pct}% |`);
				});
				lines.push('');
			}
		}

		// Sub-agent details (only if we have internal metrics)
		if (session.subAgents.length > 0) {
			const subagentsWithMetrics = session.subAgents.filter(sa => sa.internalTurns || sa.promptTokens);
			if (subagentsWithMetrics.length > 0) {
				lines.push('## Sub-Agent Details\n');
				lines.push('| Name | Internal Turns | Tool Calls | Prompt Tokens | Completion Tokens | Duration |');
				lines.push('|------|----------------|------------|---------------|-------------------|----------|');

				for (const sa of session.subAgents) {
					const turns = sa.internalTurns || 'N/A';
					const tools = sa.toolCalls.length;
					const promptTokens = sa.promptTokens ? sa.promptTokens.toLocaleString() : 'N/A';
					const completionTokens = sa.completionTokens ? sa.completionTokens.toLocaleString() : 'N/A';
					const duration = sa.durationMs ? `${(sa.durationMs / 1000).toFixed(1)}s` : 'N/A';
					const name = sa.name.length > 30 ? sa.name.substring(0, 30) + '...' : sa.name;
					lines.push(`| ${name} | ${turns} | ${tools} | ${promptTokens} | ${completionTokens} | ${duration} |`);
				}
				lines.push('');
			}
		}

		return lines.join('\n');
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IGetCurrentSessionParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const format = options.input.format || 'summary';
		return {
			invocationMessage: new MarkdownString(l10n.t`Getting current session data (${format})...`),
			pastTenseMessage: new MarkdownString(l10n.t`Retrieved current session data`),
		};
	}
}

ToolRegistry.registerTool(GetCurrentSessionTool);
