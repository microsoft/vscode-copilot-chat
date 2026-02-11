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
import { DebugItemStatus } from '../../common/debugTypes';
import { buildSessionFromRequestLogger } from '../../node/debugSessionService';

interface IAnalyzeLatestRequestParams {
	/** Which turn to analyze: 'last' (default), or a specific turn number */
	turn?: 'last' | number;
	/** Include full tool call arguments and results */
	includeFullToolDetails?: boolean;
	/** Include LLM request/response details */
	includeLLMDetails?: boolean;
	/** Focus area: 'all' (default), 'errors', 'tools', 'performance' */
	focus?: 'all' | 'errors' | 'tools' | 'performance';
	/** Exclude debug subagent's own calls from the analysis (default: true) */
	excludeDebugSubagent?: boolean;
}

/**
 * Tool to analyze a specific request/turn from the session in detail
 */
class AnalyzeLatestRequestTool implements ICopilotTool<IAnalyzeLatestRequestParams> {
	public static readonly toolName = ToolName.DebugAnalyzeLatestRequest;

	constructor(
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IAnalyzeLatestRequestParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const {
			turn = 'last',
			includeFullToolDetails = true,
			includeLLMDetails = false,
			focus = 'all',
			excludeDebugSubagent = true  // Default to excluding debug subagent's own calls
		} = options.input;

		// Build the debug session from live data
		const session = buildSessionFromRequestLogger(this.requestLogger, 'live', { excludeDebugSubagent });

		if (session.turns.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No requests found in the current session.')
			]);
		}

		// Find the target turn
		let targetTurn;
		if (turn === 'last') {
			targetTurn = session.turns[session.turns.length - 1];
		} else {
			const turnIndex = turn - 1; // Convert to 0-based
			if (turnIndex < 0 || turnIndex >= session.turns.length) {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Turn ${turn} not found. Session has ${session.turns.length} turns.`)
				]);
			}
			targetTurn = session.turns[turnIndex];
		}

		let output: string;
		switch (focus) {
			case 'errors':
				output = this.renderErrorAnalysis(targetTurn, session);
				break;
			case 'tools':
				output = this.renderToolAnalysis(targetTurn, includeFullToolDetails);
				break;
			case 'performance':
				output = this.renderPerformanceAnalysis(targetTurn, session);
				break;
			default:
				output = this.renderFullAnalysis(targetTurn, session, includeFullToolDetails, includeLLMDetails);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	private renderFullAnalysis(
		turn: ReturnType<typeof buildSessionFromRequestLogger>['turns'][0],
		session: ReturnType<typeof buildSessionFromRequestLogger>,
		includeFullToolDetails: boolean,
		includeLLMDetails: boolean
	): string {
		const lines: string[] = [];
		const statusIcon = turn.status === 'failure' ? '❌' : turn.status === 'cancelled' ? '⚠️' : '✅';

		lines.push(`# Analysis: Turn ${turn.index + 1} ${statusIcon}\n`);

		// Overview
		lines.push('## Overview\n');
		lines.push(`- **Status:** ${turn.status}`);
		lines.push(`- **Turn ID:** \`${turn.id}\``);
		if (turn.timestamp) {
			lines.push(`- **Timestamp:** ${turn.timestamp.toISOString()}`);
		}
		if (turn.durationMs) {
			lines.push(`- **Duration:** ${turn.durationMs}ms`);
		}
		lines.push(`- **Tool Calls:** ${turn.toolCalls.length}`);
		lines.push(`- **LLM Requests:** ${turn.requests.length}`);
		lines.push('');

		// User prompt
		lines.push('## User Prompt\n');
		lines.push('```');
		lines.push(turn.prompt);
		lines.push('```\n');

		// Tool calls analysis
		if (turn.toolCalls.length > 0) {
			lines.push('## Tool Calls Analysis\n');

			const failedCalls = turn.toolCalls.filter(tc => tc.status === DebugItemStatus.Failure);
			const successCalls = turn.toolCalls.filter(tc => tc.status === DebugItemStatus.Success);

			lines.push(`- **Successful:** ${successCalls.length}`);
			lines.push(`- **Failed:** ${failedCalls.length}`);

			if (turn.toolCalls.some(tc => tc.durationMs)) {
				const totalDuration = turn.toolCalls.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
				const avgDuration = Math.round(totalDuration / turn.toolCalls.length);
				lines.push(`- **Total Tool Time:** ${totalDuration}ms`);
				lines.push(`- **Average Tool Time:** ${avgDuration}ms`);
			}
			lines.push('');

			// List tool calls
			for (let i = 0; i < turn.toolCalls.length; i++) {
				const tc = turn.toolCalls[i];
				const tcStatus = tc.status === DebugItemStatus.Failure ? '❌ FAILED' : '✅ OK';
				const duration = tc.durationMs ? ` (${tc.durationMs}ms)` : '';

				lines.push(`### ${i + 1}. \`${tc.name}\` - ${tcStatus}${duration}\n`);

				if (includeFullToolDetails) {
					lines.push('**Arguments:**');
					lines.push('```json');
					lines.push(JSON.stringify(tc.args, null, 2));
					lines.push('```\n');

					if (tc.fullResult || tc.result) {
						lines.push('**Result:**');
						lines.push('```');
						const result = tc.fullResult || tc.result || 'No result';
						lines.push(result.length > 1000 ? result.substring(0, 1000) + '\n...[truncated]' : result);
						lines.push('```\n');
					}
				} else {
					// Brief summary
					const argKeys = Object.keys(tc.args);
					if (argKeys.length > 0) {
						lines.push(`**Args:** ${argKeys.join(', ')}`);
					}
					if (tc.result) {
						lines.push(`**Result preview:** ${tc.result.substring(0, 100)}...`);
					}
					lines.push('');
				}

				if (tc.error) {
					lines.push('**⚠️ Error:**');
					lines.push('```');
					lines.push(tc.error);
					lines.push('```\n');
				}

				if (tc.thinking) {
					lines.push('**🧠 Thinking:**');
					lines.push('> ' + tc.thinking.replace(/\n/g, '\n> ').substring(0, 300));
					lines.push('');
				}

				if (tc.subAgentSessionId) {
					lines.push(`**Sub-agent spawned:** \`${tc.subAgentSessionId}\`\n`);
				}
			}
		}

		// LLM requests
		if (includeLLMDetails && turn.requests.length > 0) {
			lines.push('## LLM Requests\n');

			for (const req of turn.requests) {
				const reqStatus = req.status === DebugItemStatus.Failure ? '❌' : '✅';
				lines.push(`### ${reqStatus} ${req.name}`);
				lines.push(`- **Type:** ${req.responseType}`);
				if (req.model) {
					lines.push(`- **Model:** \`${req.model}\``);
				}
				if (req.promptTokens || req.completionTokens) {
					lines.push(`- **Tokens:** ${req.promptTokens || 0} prompt / ${req.completionTokens || 0} completion`);
				}
				if (req.durationMs) {
					lines.push(`- **Duration:** ${req.durationMs}ms`);
				}
				if (req.error) {
					lines.push(`- **Error:** ${req.error}`);
				}
				lines.push('');
			}
		}

		// Response
		if (turn.response) {
			lines.push('## Assistant Response\n');
			lines.push(turn.response.length > 2000 ? turn.response.substring(0, 2000) + '\n\n*[Response truncated]*' : turn.response);
			lines.push('');
		}

		// Diagnostic suggestions
		lines.push(this.generateDiagnosticSuggestions(turn, session));

		return lines.join('\n');
	}

	private renderErrorAnalysis(
		turn: ReturnType<typeof buildSessionFromRequestLogger>['turns'][0],
		session: ReturnType<typeof buildSessionFromRequestLogger>
	): string {
		const lines: string[] = [];

		lines.push(`# Error Analysis: Turn ${turn.index + 1}\n`);

		const failedTools = turn.toolCalls.filter(tc => tc.status === DebugItemStatus.Failure);
		const failedRequests = turn.requests.filter(r => r.status === DebugItemStatus.Failure);

		if (failedTools.length === 0 && failedRequests.length === 0 && turn.status !== 'failure') {
			lines.push('✅ **No errors detected in this turn.**\n');
			lines.push('All tool calls and LLM requests completed successfully.');
			return lines.join('\n');
		}

		lines.push('## Summary\n');
		lines.push(`- **Turn Status:** ${turn.status === 'failure' ? '❌ Failed' : turn.status}`);
		lines.push(`- **Failed Tool Calls:** ${failedTools.length}`);
		lines.push(`- **Failed LLM Requests:** ${failedRequests.length}`);
		lines.push('');

		if (failedTools.length > 0) {
			lines.push('## Failed Tool Calls\n');

			for (const tc of failedTools) {
				lines.push(`### ❌ \`${tc.name}\`\n`);
				lines.push(`**Tool Call ID:** \`${tc.id}\`\n`);

				lines.push('**Arguments:**');
				lines.push('```json');
				lines.push(JSON.stringify(tc.args, null, 2));
				lines.push('```\n');

				if (tc.error) {
					lines.push('**Error Message:**');
					lines.push('```');
					lines.push(tc.error);
					lines.push('```\n');

					// Try to categorize the error
					lines.push('**Error Category:** ' + this.categorizeError(tc.error) + '\n');
				}

				// Suggestions
				lines.push('**Possible Causes:**');
				const suggestions = this.suggestErrorFixes(tc.name, tc.error, tc.args);
				for (const s of suggestions) {
					lines.push(`- ${s}`);
				}
				lines.push('');
			}
		}

		if (failedRequests.length > 0) {
			lines.push('## Failed LLM Requests\n');

			for (const req of failedRequests) {
				lines.push(`### ❌ ${req.name}`);
				lines.push(`- **Type:** ${req.responseType}`);
				if (req.model) {
					lines.push(`- **Model:** ${req.model}`);
				}
				if (req.error) {
					lines.push(`- **Error:** ${req.error}`);
				}
				lines.push('');
			}
		}

		return lines.join('\n');
	}

	private renderToolAnalysis(
		turn: ReturnType<typeof buildSessionFromRequestLogger>['turns'][0],
		includeFullDetails: boolean
	): string {
		const lines: string[] = [];

		lines.push(`# Tool Analysis: Turn ${turn.index + 1}\n`);

		if (turn.toolCalls.length === 0) {
			lines.push('No tool calls in this turn.');
			return lines.join('\n');
		}

		lines.push('## Statistics\n');
		lines.push(`- **Total Tool Calls:** ${turn.toolCalls.length}`);

		const byName = new Map<string, number>();
		for (const tc of turn.toolCalls) {
			byName.set(tc.name, (byName.get(tc.name) || 0) + 1);
		}

		if (byName.size > 0) {
			lines.push('\n**Tool Usage:**');
			for (const [name, count] of byName) {
				lines.push(`- \`${name}\`: ${count} call${count > 1 ? 's' : ''}`);
			}
		}

		if (turn.toolCalls.some(tc => tc.durationMs)) {
			lines.push('\n**Performance:**');
			const durations = turn.toolCalls.filter(tc => tc.durationMs).map(tc => tc.durationMs!);
			const totalDuration = durations.reduce((a, b) => a + b, 0);
			const avgDuration = Math.round(totalDuration / durations.length);
			const maxDuration = Math.max(...durations);
			const minDuration = Math.min(...durations);

			lines.push(`- Total: ${totalDuration}ms`);
			lines.push(`- Average: ${avgDuration}ms`);
			lines.push(`- Fastest: ${minDuration}ms`);
			lines.push(`- Slowest: ${maxDuration}ms`);
		}

		lines.push('\n## Tool Call Details\n');

		// Create execution flow
		lines.push('### Execution Sequence\n');
		lines.push('```mermaid');
		lines.push('sequenceDiagram');
		lines.push('    participant U as User');
		lines.push('    participant A as Agent');
		lines.push('    participant T as Tools');

		lines.push('    U->>A: ' + turn.prompt.substring(0, 30).replace(/[^a-zA-Z0-9 ]/g, '') + '...');

		for (const tc of turn.toolCalls) {
			const status = tc.status === DebugItemStatus.Failure ? '❌' : '✅';
			const duration = tc.durationMs ? ` [${tc.durationMs}ms]` : '';
			lines.push(`    A->>T: ${tc.name}${duration}`);
			lines.push(`    T-->>A: ${status} Result`);
		}

		if (turn.response) {
			lines.push('    A-->>U: Response');
		}

		lines.push('```\n');

		// List each tool call
		for (let i = 0; i < turn.toolCalls.length; i++) {
			const tc = turn.toolCalls[i];
			const status = tc.status === DebugItemStatus.Failure ? '❌' : '✅';

			lines.push(`### ${i + 1}. ${status} \`${tc.name}\`\n`);

			if (includeFullDetails) {
				lines.push('```json');
				lines.push(JSON.stringify(tc.args, null, 2));
				lines.push('```\n');

				if (tc.fullResult) {
					lines.push('**Result:**');
					lines.push('```');
					lines.push(tc.fullResult.length > 800 ? tc.fullResult.substring(0, 800) + '...' : tc.fullResult);
					lines.push('```');
				}
			}

			lines.push('');
		}

		return lines.join('\n');
	}

	private renderPerformanceAnalysis(
		turn: ReturnType<typeof buildSessionFromRequestLogger>['turns'][0],
		session: ReturnType<typeof buildSessionFromRequestLogger>
	): string {
		const lines: string[] = [];

		lines.push(`# Performance Analysis: Turn ${turn.index + 1}\n`);

		lines.push('## Turn Timing\n');

		if (turn.durationMs) {
			lines.push(`- **Total Duration:** ${turn.durationMs}ms (${(turn.durationMs / 1000).toFixed(2)}s)`);
		}

		// Tool timing breakdown
		if (turn.toolCalls.length > 0) {
			const toolDurations = turn.toolCalls.filter(tc => tc.durationMs).map(tc => ({ name: tc.name, duration: tc.durationMs! }));

			if (toolDurations.length > 0) {
				lines.push('\n### Tool Call Timing\n');

				const totalToolTime = toolDurations.reduce((sum, t) => sum + t.duration, 0);
				lines.push(`**Total tool execution time:** ${totalToolTime}ms\n`);

				lines.push('| Tool | Duration | % of Total |');
				lines.push('|------|----------|-----------|');

				for (const t of toolDurations.sort((a, b) => b.duration - a.duration)) {
					const pct = turn.durationMs ? ((t.duration / turn.durationMs) * 100).toFixed(1) : 'N/A';
					lines.push(`| \`${t.name}\` | ${t.duration}ms | ${pct}% |`);
				}
				lines.push('');

				// Identify slow tools
				const avgDuration = totalToolTime / toolDurations.length;
				const slowTools = toolDurations.filter(t => t.duration > avgDuration * 2);

				if (slowTools.length > 0) {
					lines.push('### ⚠️ Slow Tool Calls\n');
					lines.push(`The following tools took more than 2x the average (${Math.round(avgDuration)}ms):\n`);
					for (const t of slowTools) {
						lines.push(`- **\`${t.name}\`**: ${t.duration}ms (${(t.duration / avgDuration).toFixed(1)}x average)`);
					}
					lines.push('');
				}
			}
		}

		// Token usage analysis
		if (turn.requests.length > 0) {
			const totalPromptTokens = turn.requests.reduce((sum, r) => sum + (r.promptTokens || 0), 0);
			const totalCompletionTokens = turn.requests.reduce((sum, r) => sum + (r.completionTokens || 0), 0);

			if (totalPromptTokens > 0 || totalCompletionTokens > 0) {
				lines.push('### Token Usage\n');
				lines.push(`- **Prompt Tokens:** ${totalPromptTokens}`);
				lines.push(`- **Completion Tokens:** ${totalCompletionTokens}`);
				lines.push(`- **Total Tokens:** ${totalPromptTokens + totalCompletionTokens}`);
				lines.push(`- **Ratio (completion/prompt):** ${(totalCompletionTokens / Math.max(totalPromptTokens, 1)).toFixed(2)}`);
				lines.push('');

				// Token budget analysis
				const sessionTotal = session.metrics.totalPromptTokens || 0;
				if (sessionTotal > 0) {
					const turnPct = ((totalPromptTokens / sessionTotal) * 100).toFixed(1);
					lines.push(`This turn used **${turnPct}%** of the session's total prompt tokens.`);
				}
			}
		}

		// LLM request timing
		if (turn.requests.some(r => r.durationMs)) {
			lines.push('\n### LLM Request Timing\n');

			for (const req of turn.requests.filter(r => r.durationMs)) {
				lines.push(`- **${req.name}**: ${req.durationMs}ms`);
			}
		}

		return lines.join('\n');
	}

	private generateDiagnosticSuggestions(
		turn: ReturnType<typeof buildSessionFromRequestLogger>['turns'][0],
		_session: ReturnType<typeof buildSessionFromRequestLogger>
	): string {
		const lines: string[] = [];
		const suggestions: string[] = [];

		// Check for issues
		if (turn.status === 'failure') {
			suggestions.push('Turn failed - check the error details above');
		}

		const failedTools = turn.toolCalls.filter(tc => tc.status === DebugItemStatus.Failure);
		if (failedTools.length > 0) {
			suggestions.push(`${failedTools.length} tool call(s) failed - review tool arguments and error messages`);
		}

		// Check for repeated tool calls (possible retry loops)
		const toolCounts = new Map<string, number>();
		for (const tc of turn.toolCalls) {
			toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1);
		}
		for (const [name, count] of toolCounts) {
			if (count >= 3) {
				suggestions.push(`Tool \`${name}\` was called ${count} times - possible retry loop`);
			}
		}

		// Check for slow tool calls
		const slowTools = turn.toolCalls.filter(tc => tc.durationMs && tc.durationMs > 5000);
		if (slowTools.length > 0) {
			suggestions.push(`${slowTools.length} tool call(s) took over 5 seconds`);
		}

		if (suggestions.length > 0) {
			lines.push('\n## 💡 Diagnostic Suggestions\n');
			for (const s of suggestions) {
				lines.push(`- ${s}`);
			}
		}

		return lines.join('\n');
	}

	private categorizeError(error: string): string {
		const errorLower = error.toLowerCase();

		if (errorLower.includes('not found') || errorLower.includes('does not exist')) {
			return 'Resource Not Found';
		}
		if (errorLower.includes('permission') || errorLower.includes('access denied') || errorLower.includes('unauthorized')) {
			return 'Permission Error';
		}
		if (errorLower.includes('timeout')) {
			return 'Timeout';
		}
		if (errorLower.includes('rate limit') || errorLower.includes('quota')) {
			return 'Rate Limiting';
		}
		if (errorLower.includes('syntax') || errorLower.includes('parse')) {
			return 'Syntax/Parse Error';
		}
		if (errorLower.includes('network') || errorLower.includes('connection')) {
			return 'Network Error';
		}
		if (errorLower.includes('cancel')) {
			return 'Cancelled';
		}

		return 'Unknown Error';
	}

	private suggestErrorFixes(toolName: string, error: string | undefined, args: Record<string, unknown>): string[] {
		const suggestions: string[] = [];

		if (!error) {
			return ['No error message available for analysis'];
		}

		const errorLower = error.toLowerCase();

		// File-related tools
		if (toolName.includes('file') || toolName.includes('read') || toolName.includes('edit')) {
			if (errorLower.includes('not found')) {
				suggestions.push('Verify the file path is correct');
				suggestions.push('Check if the file exists in the workspace');
				if (args.filePath || args.path) {
					const path = (args.filePath || args.path) as string;
					suggestions.push(`Current path: \`${path}\``);
				}
			}
		}

		// Terminal/command tools
		if (toolName.includes('terminal') || toolName.includes('run')) {
			if (errorLower.includes('command not found')) {
				suggestions.push('Check if the command is installed');
				suggestions.push('Verify the PATH environment variable');
			}
		}

		// Generic suggestions
		if (errorLower.includes('timeout')) {
			suggestions.push('The operation took too long - consider breaking it into smaller tasks');
		}
		if (errorLower.includes('permission')) {
			suggestions.push('Check file and folder permissions');
		}

		if (suggestions.length === 0) {
			suggestions.push('Review the error message and tool arguments');
			suggestions.push('Check if the tool is being used correctly');
		}

		return suggestions;
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IAnalyzeLatestRequestParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const turn = options.input.turn || 'last';
		const focus = options.input.focus || 'all';
		const turnDesc = turn === 'last' ? 'latest' : `turn ${turn}`;

		return {
			invocationMessage: new MarkdownString(l10n.t`Analyzing ${turnDesc} (focus: ${focus})...`),
			pastTenseMessage: new MarkdownString(l10n.t`Analyzed ${turnDesc}`),
		};
	}
}

ToolRegistry.registerTool(AnalyzeLatestRequestTool);
