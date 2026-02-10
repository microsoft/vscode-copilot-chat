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
import { IDebugContextService, ITrajectoryNode } from '../../common/debugContextService';

interface IGetHierarchyParams {
	/** Optional session ID to get hierarchy from a specific root. If not provided, shows all hierarchies. */
	sessionId?: string;
	/** Output format: 'tree' (default), 'mermaid', or 'detailed' */
	format?: 'tree' | 'mermaid' | 'detailed';
}

/**
 * Tool to get the sub-agent hierarchy tree
 */
class GetHierarchyTool implements ICopilotTool<IGetHierarchyParams> {
	public static readonly toolName = ToolName.DebugGetHierarchy;

	constructor(
		@IDebugContextService private readonly debugContext: IDebugContextService,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetHierarchyParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { sessionId, format = 'tree' } = options.input;

		// Build hierarchy from loaded trajectories
		const roots = this.debugContext.buildHierarchy();

		if (roots.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No hierarchies available. Use debug_loadTrajectoryFile to load trajectory data first, or ensure live trajectories are captured.')
			]);
		}

		let targetRoots = roots;
		if (sessionId) {
			// Find the specific node
			const node = this.findNode(roots, sessionId);
			if (node) {
				targetRoots = [node];
			} else {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Session ID ${sessionId} not found in hierarchy. Available roots:\n${roots.map(r => `- ${r.sessionId} (${r.agentName})`).join('\n')}`)
				]);
			}
		}

		let output: string;
		switch (format) {
			case 'mermaid':
				output = this.renderMermaid(targetRoots);
				break;
			case 'detailed':
				output = this.renderDetailed(targetRoots);
				break;
			default:
				output = this.renderTree(targetRoots);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	private findNode(nodes: ITrajectoryNode[], sessionId: string): ITrajectoryNode | undefined {
		for (const node of nodes) {
			if (node.sessionId === sessionId) {
				return node;
			}
			const found = this.findNode(node.children, sessionId);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	private renderTree(roots: ITrajectoryNode[], indent = ''): string {
		const lines: string[] = [];
		if (indent === '') {
			lines.push('## Agent Hierarchy Tree\n');
		}

		for (const node of roots) {
			const statusIcon = node.hasFailures ? '❌' : '✅';
			const toolCount = node.toolCallCount > 0 ? ` [${node.toolCallCount} tools]` : '';
			const subagentCount = node.children.length > 0 ? ` (${node.children.length} sub-agents)` : '';

			lines.push(`${indent}${statusIcon} **${node.agentName}**${toolCount}${subagentCount}`);
			lines.push(`${indent}   Session: \`${node.sessionId.substring(0, 16)}...\``);

			if (node.children.length > 0) {
				lines.push(this.renderTree(node.children, indent + '    '));
			}
		}

		return lines.join('\n');
	}

	private renderMermaid(roots: ITrajectoryNode[]): string {
		const lines: string[] = [];
		lines.push('## Agent Hierarchy (Mermaid)\n');
		lines.push('```mermaid');
		lines.push('graph TD');
		lines.push('');

		for (const root of roots) {
			this.addMermaidNode(root, lines);
		}

		lines.push('```');
		return lines.join('\n');
	}

	private addMermaidNode(node: ITrajectoryNode, lines: string[]): void {
		const nodeId = node.sessionId.substring(0, 8);
		const style = node.hasFailures ? ':::failed' : '';
		const label = `${node.agentName}<br/>${node.toolCallCount} tools`;

		lines.push(`    ${nodeId}["${label}"]${style}`);

		for (const child of node.children) {
			const childId = child.sessionId.substring(0, 8);
			lines.push(`    ${nodeId} --> ${childId}`);
			this.addMermaidNode(child, lines);
		}
	}

	private renderDetailed(roots: ITrajectoryNode[]): string {
		const lines: string[] = [];
		lines.push('## Detailed Agent Hierarchy\n');

		const renderNode = (node: ITrajectoryNode, depth: number) => {
			const prefix = '  '.repeat(depth);
			lines.push(`${prefix}### ${node.agentName}`);
			lines.push(`${prefix}- **Session ID:** \`${node.sessionId}\``);
			lines.push(`${prefix}- **Steps:** ${node.stepCount}`);
			lines.push(`${prefix}- **Tool Calls:** ${node.toolCallCount}`);
			lines.push(`${prefix}- **Status:** ${node.hasFailures ? 'Has Failures ❌' : 'OK ✅'}`);
			lines.push(`${prefix}- **Sub-agents:** ${node.children.length}`);
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

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IGetHierarchyParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const formatLabel = options.input.format || 'tree';
		return {
			invocationMessage: new MarkdownString(l10n.t`Building agent hierarchy (${formatLabel})...`),
			pastTenseMessage: new MarkdownString(l10n.t`Built agent hierarchy`),
		};
	}
}

ToolRegistry.registerTool(GetHierarchyTool);
