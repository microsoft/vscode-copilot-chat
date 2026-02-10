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
import { IDebugContextService, ITrajectoryFailure } from '../../common/debugContextService';

interface IGetFailuresParams {
	/** Optional session ID to scope failures to a specific trajectory */
	sessionId?: string;
	/** Filter by failure type: 'tool_error', 'api_error', 'validation_error', etc. */
	failureType?: string;
	/** Maximum number of failures to return (default: 20) */
	limit?: number;
}

/**
 * Tool to find and analyze failures across trajectories
 */
class GetFailuresTool implements ICopilotTool<IGetFailuresParams> {
	public static readonly toolName = ToolName.DebugGetFailures;

	constructor(
		@IDebugContextService private readonly debugContext: IDebugContextService,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetFailuresParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { sessionId, failureType, limit = 20 } = options.input;

		let failures = this.debugContext.findFailures(sessionId);

		if (failureType) {
			failures = failures.filter((f: ITrajectoryFailure) => f.type.toLowerCase().includes(failureType.toLowerCase()));
		}

		if (failures.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(sessionId
					? `No failures found in session ${sessionId}${failureType ? ` with type "${failureType}"` : ''}.`
					: `No failures found${failureType ? ` with type "${failureType}"` : ''}. This could mean:\n1. All operations completed successfully\n2. No trajectories are loaded (use debug_loadTrajectoryFile first)\n3. Failures are recorded in a different format`)
			]);
		}

		const totalCount = failures.length;
		failures = failures.slice(0, limit);

		const lines: string[] = [];
		lines.push(`## Failures Found: ${totalCount}${totalCount > limit ? ` (showing first ${limit})` : ''}\n`);

		// Group by session for better readability
		const bySession = new Map<string, ITrajectoryFailure[]>();
		for (const failure of failures) {
			const existing = bySession.get(failure.sessionId) || [];
			existing.push(failure);
			bySession.set(failure.sessionId, existing);
		}

		for (const [sessId, sessionFailures] of bySession) {
			const shortId = sessId.substring(0, 16);
			lines.push(`### Session: \`${shortId}...\` (${sessionFailures.length} failures)\n`);

			for (const failure of sessionFailures) {
				lines.push(`#### ${failure.type} at Step ${failure.stepId}`);
				if (failure.toolName) {
					lines.push(`**Tool:** \`${failure.toolName}\``);
				}
				if (failure.timestamp) {
					lines.push(`*${new Date(failure.timestamp).toLocaleTimeString()}*`);
				}
				lines.push('');
				lines.push('**Error Message:**');
				lines.push('```');
				lines.push(failure.message);
				lines.push('```');

				if (failure.context) {
					lines.push('');
					lines.push('<details><summary>Context</summary>\n');
					const contextPreview = JSON.stringify(failure.context, null, 2);
					if (contextPreview.length > 500) {
						lines.push('```json');
						lines.push(contextPreview.substring(0, 500) + '...');
						lines.push('```');
					} else {
						lines.push('```json');
						lines.push(contextPreview);
						lines.push('```');
					}
					lines.push('\n</details>');
				}
				lines.push('\n---\n');
			}
		}

		// Summary statistics
		lines.push('### Failure Summary\n');

		const typeCount = new Map<string, number>();
		for (const failure of this.debugContext.findFailures(sessionId)) {
			typeCount.set(failure.type, (typeCount.get(failure.type) || 0) + 1);
		}

		lines.push('| Type | Count |');
		lines.push('|------|-------|');
		for (const [type, count] of typeCount) {
			lines.push(`| ${type} | ${count} |`);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(lines.join('\n'))]);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IGetFailuresParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const scope = options.input.sessionId ? 'session' : 'all trajectories';
		return {
			invocationMessage: new MarkdownString(l10n.t`Searching for failures in ${scope}...`),
			pastTenseMessage: new MarkdownString(l10n.t`Found failures`),
		};
	}
}

ToolRegistry.registerTool(GetFailuresTool);
