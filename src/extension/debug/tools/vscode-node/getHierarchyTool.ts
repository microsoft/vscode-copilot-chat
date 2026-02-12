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
import { findHierarchyNode, renderHierarchyDetailed, renderHierarchyMermaid, renderHierarchyTree } from '../../common/hierarchyRenderer';

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

		let targetRoots: readonly ITrajectoryNode[] = roots;
		if (sessionId) {
			// Find the specific node
			const node = findHierarchyNode(roots, sessionId);
			if (node) {
				targetRoots = [node];
			} else {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Session ID ${sessionId} not found in hierarchy. Available roots:\n${roots.map(r => `- ${r.sessionId} (${r.agentName})`).join('\n')}`)
				]);
			}
		}

		// Use shared rendering functions
		const renderOptions = {
			title: 'Agent Hierarchy',
			subtitle: 'Sub-agent tree from loaded trajectories',
			showModel: false,
			showMetrics: false
		};

		let output: string;
		switch (format) {
			case 'mermaid':
				output = renderHierarchyMermaid(targetRoots, renderOptions);
				break;
			case 'detailed':
				output = renderHierarchyDetailed(targetRoots, renderOptions);
				break;
			default:
				output = renderHierarchyTree(targetRoots, renderOptions);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
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
