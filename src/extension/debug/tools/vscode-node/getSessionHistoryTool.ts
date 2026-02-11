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
import { DebugTurn } from '../../common/debugTypes';
import { buildSessionFromRequestLogger } from '../../node/debugSessionService';

interface IGetSessionHistoryParams {
	/** Number of most recent turns to retrieve (default: 10) */
	lastN?: number;
	/** Include tool call summaries for each turn */
	includeToolCalls?: boolean;
	/** Include token usage statistics */
	includeTokenUsage?: boolean;
	/** Include timing information */
	includeTiming?: boolean;
	/** Filter to only show failed turns */
	failedOnly?: boolean;
	/** Output format: 'conversation' (default), 'timeline', 'compact' */
	format?: 'conversation' | 'timeline' | 'compact';
	/** Exclude debug subagent's own calls from the analysis (default: true) */
	excludeDebugSubagent?: boolean;
}

/**
 * Tool to get the conversation history from the current session
 */
class GetSessionHistoryTool implements ICopilotTool<IGetSessionHistoryParams> {
	public static readonly toolName = ToolName.DebugGetSessionHistory;

	constructor(
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetSessionHistoryParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const {
			lastN = 10,
			includeToolCalls = true,
			includeTokenUsage = false,
			includeTiming = true,
			failedOnly = false,
			format = 'conversation',
			excludeDebugSubagent = true  // Default to excluding debug subagent's own calls
		} = options.input;

		// Build the debug session from live data
		const session = buildSessionFromRequestLogger(this.requestLogger, 'live', { excludeDebugSubagent });

		if (session.turns.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No conversation history found. The session has no recorded turns yet.')
			]);
		}

		// Filter turns
		let turns = session.turns;
		if (failedOnly) {
			turns = turns.filter(t => t.status === 'failure');
		}

		// Get the last N turns
		turns = turns.slice(-lastN);

		if (turns.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No turns match the specified criteria.')
			]);
		}

		let output: string;
		switch (format) {
			case 'timeline':
				output = this.renderTimeline(turns, session.turns.length, includeToolCalls, includeTiming);
				break;
			case 'compact':
				output = this.renderCompact(turns, session.turns.length);
				break;
			default:
				output = this.renderConversation(turns, session.turns.length, includeToolCalls, includeTokenUsage, includeTiming);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	private renderConversation(
		turns: DebugTurn[],
		totalTurns: number,
		includeToolCalls: boolean,
		includeTokenUsage: boolean,
		includeTiming: boolean
	): string {
		const lines: string[] = [];

		lines.push(`# Conversation History (${turns.length} of ${totalTurns} turns)\n`);

		for (const turn of turns) {
			const statusIcon = turn.status === 'failure' ? '❌' : turn.status === 'cancelled' ? '⚠️' : '✅';

			lines.push(`---\n## Turn ${turn.index + 1} ${statusIcon}\n`);

			// User message
			lines.push('### 👤 User\n');
			lines.push(turn.prompt);
			lines.push('');

			// Metadata
			const meta: string[] = [];
			if (includeTiming && turn.timestamp) {
				meta.push(`Time: ${turn.timestamp.toLocaleString()}`);
			}
			if (includeTiming && turn.durationMs) {
				meta.push(`Duration: ${turn.durationMs}ms`);
			}
			if (meta.length > 0) {
				lines.push(`*${meta.join(' | ')}*\n`);
			}

			// Tool calls summary
			if (includeToolCalls && turn.toolCalls.length > 0) {
				lines.push('### 🔧 Tool Calls\n');

				for (const tc of turn.toolCalls) {
					const tcIcon = tc.status === 'failure' ? '❌' : '✅';
					const duration = tc.durationMs ? ` (${tc.durationMs}ms)` : '';
					lines.push(`- ${tcIcon} **${tc.name}**${duration}`);

					// Show brief args summary
					const argKeys = Object.keys(tc.args);
					if (argKeys.length > 0) {
						const argSummary = argKeys
							.slice(0, 3)
							.map(k => {
								const v = tc.args[k];
								const vStr = typeof v === 'string' ? (v.length > 30 ? v.substring(0, 30) + '...' : v) : JSON.stringify(v).substring(0, 30);
								return `${k}=${vStr}`;
							})
							.join(', ');
						lines.push(`  - Args: ${argSummary}${argKeys.length > 3 ? ', ...' : ''}`);
					}

					if (tc.error) {
						lines.push(`  - Error: ${tc.error.substring(0, 100)}`);
					}
				}
				lines.push('');
			}

			// Token usage
			if (includeTokenUsage && turn.requests.length > 0) {
				const totalPromptTokens = turn.requests.reduce((sum, r) => sum + (r.promptTokens || 0), 0);
				const totalCompletionTokens = turn.requests.reduce((sum, r) => sum + (r.completionTokens || 0), 0);

				if (totalPromptTokens > 0 || totalCompletionTokens > 0) {
					lines.push(`**Token Usage:** ${totalPromptTokens} prompt / ${totalCompletionTokens} completion\n`);
				}
			}

			// Assistant response
			if (turn.response) {
				lines.push('### 🤖 Assistant\n');
				// Truncate very long responses
				const response = turn.response.length > 1000 ? turn.response.substring(0, 1000) + '...\n\n*[Response truncated]*' : turn.response;
				lines.push(response);
				lines.push('');
			}
		}

		return lines.join('\n');
	}

	private renderTimeline(turns: DebugTurn[], totalTurns: number, includeToolCalls: boolean, includeTiming: boolean): string {
		const lines: string[] = [];

		lines.push(`# Session Timeline (${turns.length} of ${totalTurns} turns)\n`);

		// Mermaid gantt chart for timeline visualization
		if (turns.some(t => t.timestamp)) {
			lines.push('```mermaid');
			lines.push('gantt');
			lines.push('    title Session Timeline');
			lines.push('    dateFormat HH:mm:ss');
			lines.push('');
			lines.push('    section Turns');

			for (const turn of turns) {
				if (turn.timestamp) {
					const status = turn.status === 'failure' ? 'crit, ' : '';
					const time = turn.timestamp.toTimeString().substring(0, 8);
					const duration = turn.durationMs || 1000;
					const label = turn.prompt.substring(0, 20).replace(/[^a-zA-Z0-9 ]/g, '');
					lines.push(`        ${label} : ${status}${time}, ${duration}ms`);
				}
			}

			if (includeToolCalls) {
				lines.push('');
				lines.push('    section Tool Calls');

				for (const turn of turns) {
					for (const tc of turn.toolCalls.slice(0, 3)) {
						if (tc.timestamp) {
							const status = tc.status === 'failure' ? 'crit, ' : '';
							const time = tc.timestamp.toTimeString().substring(0, 8);
							const duration = tc.durationMs || 100;
							lines.push(`        ${tc.name} : ${status}${time}, ${duration}ms`);
						}
					}
				}
			}

			lines.push('```');
			lines.push('');
		}

		// Text timeline
		lines.push('## Chronological Events\n');

		for (const turn of turns) {
			const statusIcon = turn.status === 'failure' ? '❌' : '✅';
			const time = turn.timestamp ? turn.timestamp.toLocaleTimeString() : 'N/A';
			const duration = includeTiming && turn.durationMs ? ` (${turn.durationMs}ms)` : '';

			lines.push(`### ${time} - Turn ${turn.index + 1} ${statusIcon}${duration}`);
			lines.push(`> ${turn.prompt.substring(0, 100)}${turn.prompt.length > 100 ? '...' : ''}`);

			if (includeToolCalls && turn.toolCalls.length > 0) {
				lines.push('');
				for (const tc of turn.toolCalls) {
					const tcIcon = tc.status === 'failure' ? '❌' : '✅';
					const tcTime = tc.timestamp ? tc.timestamp.toLocaleTimeString() : '';
					const tcDuration = tc.durationMs ? ` ${tc.durationMs}ms` : '';
					lines.push(`- ${tcTime} ${tcIcon} \`${tc.name}\`${tcDuration}`);
				}
			}

			lines.push('');
		}

		return lines.join('\n');
	}

	private renderCompact(turns: DebugTurn[], totalTurns: number): string {
		const lines: string[] = [];

		lines.push(`# Session History (Compact) - ${turns.length} of ${totalTurns} turns\n`);
		lines.push('| Turn | Status | Prompt | Tools | Response |');
		lines.push('|------|--------|--------|-------|----------|');

		for (const turn of turns) {
			const status = turn.status === 'failure' ? '❌' : turn.status === 'cancelled' ? '⚠️' : '✅';
			const prompt = turn.prompt.substring(0, 40).replace(/\|/g, '\\|').replace(/\n/g, ' ');
			const toolCount = turn.toolCalls.length;
			const failedTools = turn.toolCalls.filter(t => t.status === 'failure').length;
			const toolSummary = failedTools > 0 ? `${toolCount} (${failedTools}❌)` : `${toolCount}`;
			const response = turn.response ? turn.response.substring(0, 30).replace(/\|/g, '\\|').replace(/\n/g, ' ') + '...' : '-';

			lines.push(`| ${turn.index + 1} | ${status} | ${prompt}... | ${toolSummary} | ${response} |`);
		}

		return lines.join('\n');
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IGetSessionHistoryParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const lastN = options.input.lastN || 10;
		return {
			invocationMessage: new MarkdownString(l10n.t`Getting last ${lastN} conversation turns...`),
			pastTenseMessage: new MarkdownString(l10n.t`Retrieved conversation history`),
		};
	}
}

ToolRegistry.registerTool(GetSessionHistoryTool);
