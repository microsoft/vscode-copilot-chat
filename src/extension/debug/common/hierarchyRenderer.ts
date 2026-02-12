/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Common interface for hierarchy nodes used by both getHierarchyTool and getLiveHierarchyTool.
 * This is the minimal shared shape that both ITrajectoryNode and ILiveHierarchyNode implement.
 */
export interface IHierarchyNode {
	readonly sessionId: string;
	readonly agentName: string;
	readonly children: readonly IHierarchyNode[];
	readonly depth: number;
	readonly stepCount: number;
	readonly toolCallCount: number;
	readonly hasFailures: boolean;
	/** The tool call ID that invoked this sub-agent */
	readonly parentToolCallId?: string;
	/** Optional model name (available in live hierarchy) */
	readonly modelName?: string;
	/** Optional metrics (available in live hierarchy) */
	readonly metrics?: {
		promptTokens?: number;
		completionTokens?: number;
		durationMs?: number;
	};
}

/**
 * Options for hierarchy rendering
 */
export interface IHierarchyRenderOptions {
	/** Title for the output */
	title?: string;
	/** Subtitle/description */
	subtitle?: string;
	/** Whether to show model names */
	showModel?: boolean;
	/** Whether to show token metrics */
	showMetrics?: boolean;
}

/**
 * Find a node by session ID in a hierarchy tree
 */
export function findHierarchyNode<T extends IHierarchyNode>(nodes: readonly T[], sessionId: string): T | undefined {
	for (const node of nodes) {
		if (node.sessionId === sessionId) {
			return node;
		}
		const found = findHierarchyNode(node.children as readonly T[], sessionId);
		if (found) {
			return found as T;
		}
	}
	return undefined;
}

/**
 * Render hierarchy as a text tree
 */
export function renderHierarchyTree(
	roots: readonly IHierarchyNode[],
	options: IHierarchyRenderOptions = {},
	indent = ''
): string {
	const lines: string[] = [];

	if (indent === '') {
		lines.push(`## ${options.title || 'Agent Hierarchy Tree'}\n`);
		if (options.subtitle) {
			lines.push(`> ${options.subtitle}\n`);
		}
	}

	for (const node of roots) {
		const statusIcon = node.hasFailures ? 'FAILED' : 'OK';
		const toolCount = node.toolCallCount > 0 ? ` [${node.toolCallCount} tools]` : '';
		const subagentCount = node.children.length > 0 ? ` (${node.children.length} sub-agents)` : '';
		const model = options.showModel && node.modelName ? ` - ${node.modelName}` : '';

		lines.push(`${indent}${statusIcon} **${node.agentName}**${model}${toolCount}${subagentCount}`);
		lines.push(`${indent}   Session: \`${node.sessionId.substring(0, 16)}...\``);

		if (options.showMetrics && node.metrics) {
			const tokens = [];
			if (node.metrics.promptTokens) {
				tokens.push(`${node.metrics.promptTokens} prompt`);
			}
			if (node.metrics.completionTokens) {
				tokens.push(`${node.metrics.completionTokens} completion`);
			}
			if (tokens.length > 0) {
				lines.push(`${indent}   Tokens: ${tokens.join(', ')}`);
			}
		}

		if (node.children.length > 0) {
			lines.push(renderHierarchyTree(node.children, { ...options, title: undefined, subtitle: undefined }, indent + '    '));
		}
	}

	return lines.join('\n');
}

/**
 * Render hierarchy as a mermaid diagram
 */
export function renderHierarchyMermaid(
	roots: readonly IHierarchyNode[],
	options: IHierarchyRenderOptions = {}
): string {
	const lines: string[] = [];
	lines.push(`## ${options.title || 'Agent Hierarchy'}\n`);
	if (options.subtitle) {
		lines.push(`> ${options.subtitle}\n`);
	}
	lines.push('```mermaid');
	lines.push('graph TD');
	lines.push('');

	// Add class definitions for styling
	lines.push('    classDef failed fill:#ffcccc,stroke:#cc0000');
	lines.push('    classDef success fill:#ccffcc,stroke:#00cc00');
	lines.push('');

	for (const root of roots) {
		addMermaidNode(root, lines, options);
	}

	lines.push('```');
	return lines.join('\n');
}

function addMermaidNode(
	node: IHierarchyNode,
	lines: string[],
	options: IHierarchyRenderOptions
): void {
	// Create safe node ID (alphanumeric only)
	const nodeId = node.sessionId.substring(0, 8).replace(/-/g, '');
	const styleClass = node.hasFailures ? ':::failed' : ':::success';
	const model = options.showModel && node.modelName ? `<br/>${node.modelName}` : '';
	const label = `${node.agentName}${model}<br/>${node.toolCallCount} tools, ${node.stepCount} steps`;

	lines.push(`    ${nodeId}["${label}"]${styleClass}`);

	for (const child of node.children) {
		const childId = child.sessionId.substring(0, 8).replace(/-/g, '');
		lines.push(`    ${nodeId} --> ${childId}`);
		addMermaidNode(child, lines, options);
	}
}

/**
 * Render hierarchy with detailed information
 */
export function renderHierarchyDetailed(
	roots: readonly IHierarchyNode[],
	options: IHierarchyRenderOptions = {}
): string {
	const lines: string[] = [];
	lines.push(`## ${options.title || 'Detailed Agent Hierarchy'}\n`);
	if (options.subtitle) {
		lines.push(`> ${options.subtitle}\n`);
	}

	const renderNode = (node: IHierarchyNode, depth: number) => {
		const prefix = '  '.repeat(depth);
		lines.push(`${prefix}### ${node.agentName}`);
		lines.push(`${prefix}- **Session ID:** \`${node.sessionId}\``);
		if (options.showModel && node.modelName) {
			lines.push(`${prefix}- **Model:** ${node.modelName}`);
		}
		lines.push(`${prefix}- **Steps:** ${node.stepCount}`);
		lines.push(`${prefix}- **Tool Calls:** ${node.toolCallCount}`);
		lines.push(`${prefix}- **Status:** ${node.hasFailures ? 'Has Failures' : 'OK'}`);
		lines.push(`${prefix}- **Sub-agents:** ${node.children.length}`);

		if (options.showMetrics && node.metrics) {
			lines.push(`${prefix}- **Tokens:**`);
			if (node.metrics.promptTokens) {
				lines.push(`${prefix}  - Prompt: ${node.metrics.promptTokens}`);
			}
			if (node.metrics.completionTokens) {
				lines.push(`${prefix}  - Completion: ${node.metrics.completionTokens}`);
			}
		}
		lines.push('');

		for (const child of node.children) {
			renderNode(child, depth + 1);
		}
	};

	for (const root of roots) {
		renderNode(root, 0);
	}

	return lines.join('\n');
}
