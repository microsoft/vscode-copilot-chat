/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import { IDebugContextService, IToolCallInfo } from '../../common/debugContextService';

interface IGetToolCallsParams {
	/** Optional session ID to scope tool calls to a specific trajectory */
	sessionId?: string;
	/** Filter by tool name (partial match) */
	toolName?: string;
	/** Only show failed tool calls */
	failedOnly?: boolean;
	/** Maximum number of tool calls to return (default: 50) */
	limit?: number;
	/** Output format: 'summary' (default), 'detailed', or 'timeline' */
	format?: 'summary' | 'detailed' | 'timeline';
}

/**
 * Tool to get and filter tool call information across trajectories
 */
class GetToolCallsTool implements ICopilotTool<IGetToolCallsParams> {
	public static readonly toolName = ToolName.DebugGetToolCalls;

	constructor(
		@IDebugContextService private readonly debugContext: IDebugContextService,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetToolCallsParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const {
			sessionId,
			toolName,
			failedOnly = false,
			limit = 50,
			format = 'summary'
		} = options.input;

		const filter = {
			sessionId,
			toolName,
			failedOnly
		};

		let toolCalls = this.debugContext.getToolCalls(filter);

		if (toolCalls.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(this.buildNoResultsMessage(filter))
			]);
		}

		const totalCount = toolCalls.length;
		toolCalls = toolCalls.slice(0, limit);

		let output: string;
		switch (format) {
			case 'detailed':
				output = this.renderDetailed(toolCalls, totalCount, limit);
				break;
			case 'timeline':
				output = this.renderTimeline(toolCalls, totalCount, limit);
				break;
			default:
				output = this.renderSummary(toolCalls, totalCount, limit);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	private buildNoResultsMessage(filter: { sessionId?: string; toolName?: string; failedOnly?: boolean }): string {
		const conditions: string[] = [];
		if (filter.sessionId) {
			conditions.push(`session ${filter.sessionId.substring(0, 16)}...`);
		}
		if (filter.toolName) {
			conditions.push(`tool name containing "${filter.toolName}"`);
		}
		if (filter.failedOnly) {
			conditions.push('failed calls only');
		}

		if (conditions.length === 0) {
			return 'No tool calls found. Ensure trajectories are loaded using debug_loadTrajectoryFile or live trajectories are being captured.';
		}

		return `No tool calls found matching criteria: ${conditions.join(', ')}.`;
	}

	private renderSummary(toolCalls: IToolCallInfo[], totalCount: number, limit: number): string {
		const lines: string[] = [];
		lines.push(`## Tool Calls: ${totalCount}${totalCount > limit ? ` (showing first ${limit})` : ''}\n`);

		// Aggregate statistics
		const byTool = new Map<string, { count: number; failures: number; totalDuration: number }>();
		for (const call of toolCalls) {
			const stats = byTool.get(call.toolName) || { count: 0, failures: 0, totalDuration: 0 };
			stats.count++;
			if (call.failed) {
				stats.failures++;
			}
			if (call.durationMs) {
				stats.totalDuration += call.durationMs;
			}
			byTool.set(call.toolName, stats);
		}

		lines.push('### Tool Statistics\n');
		lines.push('| Tool | Calls | Failures | Avg Duration |');
		lines.push('|------|-------|----------|--------------|');

		for (const [tool, stats] of byTool) {
			const avgDuration = stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0;
			const failRate = stats.failures > 0 ? ` (${Math.round(stats.failures / stats.count * 100)}% fail)` : '';
			lines.push(`| \`${tool}\` | ${stats.count}${failRate} | ${stats.failures} | ${avgDuration}ms |`);
		}

		lines.push('\n### Recent Calls\n');

		for (const call of toolCalls.slice(0, 10)) {
			const status = call.failed ? '❌' : '✅';
			const duration = call.durationMs ? ` (${call.durationMs}ms)` : '';
			const shortSession = call.sessionId.substring(0, 8);
			lines.push(`- ${status} \`${call.toolName}\` in step ${call.stepId} [${shortSession}...] ${duration}`);
		}

		return lines.join('\n');
	}

	private renderDetailed(toolCalls: IToolCallInfo[], totalCount: number, limit: number): string {
		const lines: string[] = [];
		lines.push(`## Tool Calls (Detailed): ${totalCount}${totalCount > limit ? ` (showing first ${limit})` : ''}\n`);

		for (const call of toolCalls) {
			const status = call.failed ? '❌ FAILED' : '✅ OK';
			lines.push(`### \`${call.toolName}\` - ${status}`);
			lines.push(`- **Call ID:** \`${call.toolCallId}\``);
			lines.push(`- **Session:** \`${call.sessionId.substring(0, 16)}...\``);
			lines.push(`- **Step:** ${call.stepId}`);

			if (call.durationMs) {
				lines.push(`- **Duration:** ${call.durationMs}ms`);
			}

			lines.push('\n**Arguments:**');
			lines.push('```json');
			const argsStr = JSON.stringify(call.arguments, null, 2);
			lines.push(argsStr.length > 500 ? argsStr.substring(0, 500) + '...' : argsStr);
			lines.push('```');

			if (call.result) {
				lines.push('\n**Result:**');
				lines.push('```');
				lines.push(call.result.length > 300 ? call.result.substring(0, 300) + '...' : call.result);
				lines.push('```');
			}

			if (call.error) {
				lines.push('\n**Error:**');
				lines.push('```');
				lines.push(call.error);
				lines.push('```');
			}

			if (call.subAgentSessionId) {
				lines.push(`\n**Spawned Sub-agent:** \`${call.subAgentSessionId}\``);
			}

			lines.push('\n---\n');
		}

		return lines.join('\n');
	}

	private renderTimeline(toolCalls: IToolCallInfo[], totalCount: number, limit: number): string {
		const lines: string[] = [];
		lines.push(`## Tool Call Timeline: ${totalCount}${totalCount > limit ? ` (showing first ${limit})` : ''}\n`);

		// Sort by timestamp if available
		const sorted = [...toolCalls].sort((a, b) => {
			if (!a.timestamp && !b.timestamp) { return 0; }
			if (!a.timestamp) { return 1; }
			if (!b.timestamp) { return -1; }
			return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
		});

		lines.push('```mermaid');
		lines.push('gantt');
		lines.push('    title Tool Call Timeline');
		lines.push('    dateFormat HH:mm:ss');
		lines.push('');

		// Group by session
		const bySession = new Map<string, IToolCallInfo[]>();
		for (const call of sorted) {
			const existing = bySession.get(call.sessionId) || [];
			existing.push(call);
			bySession.set(call.sessionId, existing);
		}

		for (const [sessId, calls] of bySession) {
			const shortSession = sessId.substring(0, 12);
			lines.push(`    section ${shortSession}`);

			for (const call of calls) {
				const status = call.failed ? 'crit,' : '';
				const duration = call.durationMs || 100;
				const start = call.timestamp ? new Date(call.timestamp).toTimeString().substring(0, 8) : '00:00:00';
				lines.push(`        ${call.toolName} : ${status}${start}, ${duration}ms`);
			}
		}

		lines.push('```');

		// Also include text summary
		lines.push('\n### Chronological List\n');
		for (const call of sorted.slice(0, 20)) {
			const status = call.failed ? '❌' : '✅';
			const time = call.timestamp ? new Date(call.timestamp).toLocaleTimeString() : 'N/A';
			lines.push(`- ${time} ${status} \`${call.toolName}\` (step ${call.stepId})`);
		}

		return lines.join('\n');
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IGetToolCallsParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const filters: string[] = [];
		if (options.input.sessionId) {
			filters.push('session');
		}
		if (options.input.toolName) {
			filters.push(`"${options.input.toolName}"`);
		}
		if (options.input.failedOnly) {
			filters.push('failures');
		}
		const filterDesc = filters.length > 0 ? ` (${filters.join(', ')})` : '';

		return {
			invocationMessage: new MarkdownString(l10n.t`Getting tool calls${filterDesc}...`),
			pastTenseMessage: new MarkdownString(l10n.t`Retrieved tool calls`),
		};
	}
}

ToolRegistry.registerTool(GetToolCallsTool);
