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
}

/**
 * Tool to get the current live session data from IRequestLogger
 */
class GetCurrentSessionTool implements ICopilotTool<IGetCurrentSessionParams> {
	public static readonly toolName = ToolName.DebugGetCurrentSession;

	constructor(
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetCurrentSessionParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const {
			format = 'summary',
			includeToolCalls = true,
			includeRequests = false,
			maxTurns = 20
		} = options.input;

		// Build the debug session from live data
		const session = buildSessionFromRequestLogger(this.requestLogger, 'live');

		if (session.turns.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No session data found. The current chat session has no recorded requests yet.')
			]);
		}

		let output: string;
		switch (format) {
			case 'detailed':
				output = this.renderDetailed(session, maxTurns, includeToolCalls, includeRequests);
				break;
			case 'metrics':
				output = this.renderMetrics(session);
				break;
			default:
				output = this.renderSummary(session, maxTurns, includeToolCalls);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	private renderSummary(session: ReturnType<typeof buildSessionFromRequestLogger>, maxTurns: number, includeToolCalls: boolean): string {
		const lines: string[] = [];
		const m = session.metrics;

		lines.push('# Current Live Session\n');
		lines.push('## Overview');
		lines.push(`- **Session ID:** ${session.sessionId}`);
		lines.push(`- **Total Turns:** ${m.totalTurns}`);
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

			lines.push(`### Turn ${turn.index + 1} ${statusIcon}`);
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

	private renderDetailed(session: ReturnType<typeof buildSessionFromRequestLogger>, maxTurns: number, includeToolCalls: boolean, includeRequests: boolean): string {
		const lines: string[] = [];

		lines.push('# Current Live Session (Detailed)\n');
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

	private renderMetrics(session: ReturnType<typeof buildSessionFromRequestLogger>): string {
		const lines: string[] = [];
		const m = session.metrics;

		lines.push('# Session Metrics\n');

		lines.push('## Summary Statistics\n');
		lines.push('| Metric | Value |');
		lines.push('|--------|-------|');
		lines.push(`| Total Turns | ${m.totalTurns} |`);
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
