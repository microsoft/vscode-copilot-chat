/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IAgentTrajectory, ITrajectoryStep } from '../../../../platform/trajectory/common/trajectoryTypes';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import { IDebugContextService } from '../../common/debugContextService';

interface ILoadTrajectoryFileParams {
	/** Path to the trajectory file (ATIF JSON format) */
	filePath: string;
	/** Whether to append to existing loaded trajectories or replace them */
	append?: boolean;
}

/**
 * Tool to load trajectory data from a file for analysis
 */
class LoadTrajectoryFileTool implements ICopilotTool<ILoadTrajectoryFileParams> {
	public static readonly toolName = ToolName.DebugLoadTrajectoryFile;

	constructor(
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@IDebugContextService private readonly debugContext: IDebugContextService,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ILoadTrajectoryFileParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { filePath, append = false } = options.input;

		try {
			const uri = URI.file(filePath);

			// Check if file exists by trying to stat it
			try {
				await this.fileSystem.stat(uri);
			} catch {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`File not found: ${filePath}\n\nPlease provide a valid path to an ATIF trajectory file.`)
				]);
			}

			// Read file content
			const content = await this.fileSystem.readFile(uri);
			const textContent = new TextDecoder().decode(content);

			// Parse and validate
			let trajectories: IAgentTrajectory[];
			try {
				const parsed = JSON.parse(textContent) as unknown;

				// Handle both single trajectory and array of trajectories
				if (Array.isArray(parsed)) {
					trajectories = parsed;
				} else if (parsed && typeof parsed === 'object' && 'session_id' in parsed && 'steps' in parsed) {
					// Single ATIF trajectory
					trajectories = [parsed as IAgentTrajectory];
				} else if (parsed && typeof parsed === 'object' && 'trajectories' in parsed && Array.isArray((parsed as Record<string, unknown>).trajectories)) {
					// Wrapped format
					trajectories = (parsed as { trajectories: IAgentTrajectory[] }).trajectories;
				} else {
					return new LanguageModelToolResult([
						new LanguageModelTextPart(`Invalid trajectory format. Expected ATIF format with 'session_id' and 'steps' fields.\n\nFile content preview:\n\`\`\`\n${textContent.substring(0, 500)}...\n\`\`\``)
					]);
				}
			} catch (parseError) {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Failed to parse trajectory file as JSON: ${parseError}\n\nMake sure the file is a valid JSON file in ATIF trajectory format.`)
				]);
			}

			// Validate trajectories
			const validTrajectories = trajectories.filter((t): t is IAgentTrajectory =>
				t && typeof t.session_id === 'string' && Array.isArray(t.steps)
			);

			if (validTrajectories.length === 0) {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`No valid trajectories found in file. Expected ATIF format with:\n- session_id (string)\n- steps (array)\n\nFound ${trajectories.length} object(s) but none had the required fields.`)
				]);
			}

			// Load into context
			// Clear existing if not appending
			if (!append) {
				this.debugContext.clearTrajectories();
			}

			// Add each trajectory
			let loadedCount = 0;
			for (const traj of validTrajectories) {
				this.debugContext.addTrajectory(traj);
				loadedCount++;
			}

			// Build summary
			const lines: string[] = [];
			lines.push(`## Trajectories Loaded: ${loadedCount}\n`);

			if (!append) {
				lines.push('*(Replaced existing trajectories)*\n');
			} else {
				lines.push('*(Appended to existing trajectories)*\n');
			}

			lines.push('### Loaded Sessions\n');
			for (const traj of validTrajectories.slice(0, 10)) {
				const stepCount = traj.steps?.length || 0;
				const toolCallCount = traj.steps?.reduce((sum: number, s: ITrajectoryStep) =>
					sum + (s.tool_calls?.length || 0), 0) || 0;
				const agentName = traj.agent?.name || 'Unknown Agent';

				lines.push(`- **${agentName}** (\`${traj.session_id.substring(0, 16)}...\`)`);
				lines.push(`  - Steps: ${stepCount}, Tool calls: ${toolCallCount}`);
			}

			if (validTrajectories.length > 10) {
				lines.push(`\n... and ${validTrajectories.length - 10} more trajectories`);
			}

			// Show hierarchy preview
			const roots = this.debugContext.buildHierarchy();
			if (roots.length > 0) {
				lines.push('\n### Hierarchy Preview\n');
				for (const root of roots.slice(0, 5)) {
					const childCount = root.children.length;
					const status = root.hasFailures ? '❌' : '✅';
					lines.push(`${status} ${root.agentName}${childCount > 0 ? ` → ${childCount} sub-agents` : ''}`);
				}
			}

			// Show any failures found
			const failures = this.debugContext.findFailures();
			if (failures.length > 0) {
				lines.push(`\n### ⚠️ ${failures.length} Failure(s) Detected\n`);
				lines.push('Use `debug_getFailures` to see details.');
			}

			lines.push('\n### Available Commands\n');
			lines.push('- `debug_getTrajectories` - List all loaded trajectories');
			lines.push('- `debug_getTrajectory sessionId=...` - Get specific trajectory details');
			lines.push('- `debug_getHierarchy` - View sub-agent hierarchy');
			lines.push('- `debug_getFailures` - Find all failures');
			lines.push('- `debug_getToolCalls` - Analyze tool usage');

			return new LanguageModelToolResult([new LanguageModelTextPart(lines.join('\n'))]);

		} catch (error) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`Failed to load trajectory file: ${error instanceof Error ? error.message : String(error)}`)
			]);
		}
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ILoadTrajectoryFileParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const fileName = options.input.filePath.split(/[/\\]/).pop() || 'file';
		return {
			invocationMessage: new MarkdownString(l10n.t`Loading trajectory file ${fileName}...`),
			pastTenseMessage: new MarkdownString(l10n.t`Loaded trajectory file ${fileName}`),
		};
	}
}

ToolRegistry.registerTool(LoadTrajectoryFileTool);
