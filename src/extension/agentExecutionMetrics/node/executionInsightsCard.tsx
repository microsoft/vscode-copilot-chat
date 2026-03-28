/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import { IExecutionMetrics } from './executionMetricsService';

export interface ExecutionInsightsCardProps extends BasePromptElementProps {
	metrics: IExecutionMetrics;
}

/**
 * Renders an execution insights card showing agent performance metrics.
 * Displays execution summary including timing, tool usage, and resource estimates.
 */
export class ExecutionInsightsCard extends PromptElement<ExecutionInsightsCardProps> {
	render(_state: void, _sizing: PromptSizing) {
		const { metrics } = this.props;

		// Format duration in a human-readable way
		const formatDuration = (ms: number): string => {
			if (ms < 1000) {
				return `${Math.round(ms)}ms`;
			}
			return `${(ms / 1000).toFixed(1)}s`;
		};

		// Get unique tool names
		const uniqueTools = [...new Set(metrics.toolCalls.map(tc => tc.name))];

		const lines: string[] = [
			'',
			'─'.repeat(50),
			'📊 Agent Execution Summary',
			'─'.repeat(50),
		];

		// Add timing info
		if (metrics.totalDuration !== undefined) {
			lines.push(`⏱️  Total Time: ${formatDuration(metrics.totalDuration)}`);
		}

		// Add tool call summary
		const toolSummary = `🛠️  Tools: ${metrics.totalToolCalls} call${metrics.totalToolCalls !== 1 ? 's' : ''}`;
		if (metrics.failedToolCalls > 0) {
			lines.push(`${toolSummary} (${metrics.successfulToolCalls} ✓, ${metrics.failedToolCalls} ✗)`);
		} else if (metrics.totalToolCalls > 0) {
			lines.push(`${toolSummary} (all ✓)`);
		} else {
			lines.push(`${toolSummary}`);
		}

		// Add tools used
		if (uniqueTools.length > 0) {
			lines.push(`📚 Used: ${uniqueTools.join(', ')}`);
		}

		// Add resource usage estimation
		lines.push('');
		lines.push('💰 Resource Usage (Estimated)');
		lines.push(`  • Tokens: ~${metrics.estimatedTokensUsed.toLocaleString()} tokens`);

		if (metrics.estimatedApiCostUSD !== undefined && metrics.estimatedApiCostUSD > 0) {
			const costStr = metrics.estimatedApiCostUSD < 0.001
				? '<$0.001'
				: `$${metrics.estimatedApiCostUSD.toFixed(4)}`;
			lines.push(`  • Cost: ${costStr}`);
		}

		// Add additional insights
		if (metrics.toolCalls.length > 0) {
			const avgDuration = metrics.toolCalls.reduce((sum, tc) => sum + (tc.duration || 0), 0) / metrics.toolCalls.length;
			lines.push(`  • Avg Tool Time: ${formatDuration(avgDuration)}`);
		}

		// Add indicators for performance
		lines.push('');
		const toolEfficiency = metrics.totalToolCalls > 0
			? (metrics.successfulToolCalls / metrics.totalToolCalls * 100).toFixed(0)
			: 100;
		lines.push(`✨ Efficiency: ${toolEfficiency}% success rate`);

		lines.push('─'.repeat(50));
		lines.push('');

		return <TextChunk>{lines.join('\n')}</TextChunk>;
	}
}
