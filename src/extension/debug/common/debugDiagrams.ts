/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getSubagentName, isSubagentTurn } from './debugFormatters';
import { DebugItemStatus, DebugSession, DebugSubAgent, DebugToolCall, DebugTurn } from './debugTypes';

/**
 * Maximum number of nodes before simplification kicks in
 */
const MAX_NODES_BEFORE_SIMPLIFICATION = 50;

/**
 * Check if two turns overlap in time (indicating parallel execution)
 */
export function turnsOverlap(a: DebugTurn, b: DebugTurn): boolean {
	if (!a.timestamp || !b.timestamp) {
		return false;
	}
	const aStart = a.timestamp.getTime();
	const aEnd = aStart + (a.durationMs || 1000);
	const bStart = b.timestamp.getTime();
	const bEnd = bStart + (b.durationMs || 1000);
	return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Escape special characters for Mermaid labels
 */
function escapeLabel(text: string): string {
	if (!text) {
		return '';
	}
	return text
		.replace(/"/g, '\'')     // Quotes
		.replace(/\[/g, '(')     // Square brackets
		.replace(/\]/g, ')')
		.replace(/</g, '&lt;')   // Angle brackets - HTML entities
		.replace(/>/g, '&gt;')
		.replace(/\{/g, '(')     // Curly braces
		.replace(/\}/g, ')')
		.replace(/\|/g, '/')     // Pipes are used for node shapes
		.replace(/:/g, '-')      // Colons can break Mermaid syntax
		.replace(/#/g, '')       // Hash can be interpreted as IDs
		.replace(/;/g, ',')      // Semicolons can break syntax
		.replace(/`/g, '\'')     // Backticks
		.replace(/\$/g, '')      // Dollar signs
		.replace(/&(?!lt;|gt;|amp;|quot;)/g, 'and')  // Ampersand (but not entities)
		.replace(/\n/g, ' ')     // Newlines
		.replace(/\r/g, '')      // Carriage returns
		.replace(/\\/g, '/')     // Backslashes (common in Windows paths)
		.substring(0, 50);
}

/**
 * Escape tool names for Mermaid - more permissive than labels but still safe
 */
function escapeToolName(name: string): string {
	if (!name) {
		return 'unknown';
	}
	return name
		.replace(/\[/g, '(')     // Square brackets break node syntax
		.replace(/\]/g, ')')
		.replace(/"/g, '\'')
		.replace(/</g, '')
		.replace(/>/g, '')
		.replace(/\{/g, '(')
		.replace(/\}/g, ')')
		.replace(/\|/g, '/')
		.replace(/;/g, '')
		.replace(/\n/g, ' ')
		.replace(/\r/g, '');
}

/**
 * Get a short ID for Mermaid node names
 */
function nodeId(prefix: string, index: number): string {
	return `${prefix}${index}`;
}

/**
 * Format a sub-agent label with internal metrics
 */
function formatSubAgentLabel(subAgent: DebugSubAgent): string {
	const escapedName = escapeToolName(subAgent.name);
	const parts: string[] = [];

	if (subAgent.internalTurns) {
		parts.push(`${subAgent.internalTurns} turns`);
	}
	if (subAgent.toolCalls.length > 0) {
		parts.push(`${subAgent.toolCalls.length} tools`);
	}
	if (subAgent.promptTokens) {
		const kTokens = Math.round(subAgent.promptTokens / 1000);
		parts.push(`${kTokens}k tokens`);
	}

	if (parts.length > 0) {
		return `${escapedName}<br/>${parts.join(', ')}`;
	}
	return escapedName;
}

/**
 * Get CSS class for status
 */
function statusClass(status: DebugItemStatus): string {
	switch (status) {
		case DebugItemStatus.Failure:
			return ':::error';
		case DebugItemStatus.Cancelled:
			return ':::cancelled';
		case DebugItemStatus.InProgress:
			return ':::inprogress';
		default:
			return '';
	}
}

/**
 * Group consecutive tool calls of the same type
 */
function groupConsecutiveTools(toolCalls: DebugToolCall[]): Array<{ name: string; count: number; tools: DebugToolCall[] }> {
	const groups: Array<{ name: string; count: number; tools: DebugToolCall[] }> = [];
	let currentGroup: { name: string; count: number; tools: DebugToolCall[] } | null = null;

	for (const tool of toolCalls) {
		if (currentGroup && currentGroup.name === tool.name) {
			currentGroup.count++;
			currentGroup.tools.push(tool);
		} else {
			if (currentGroup) {
				groups.push(currentGroup);
			}
			currentGroup = { name: tool.name, count: 1, tools: [tool] };
		}
	}

	if (currentGroup) {
		groups.push(currentGroup);
	}

	return groups;
}

/**
 * Generate a control flow diagram showing the sequence of operations
 */
export function generateControlFlowDiagram(session: DebugSession, detailed: boolean = false): string {
	const lines: string[] = ['flowchart TD'];

	// Add style definitions
	lines.push('    classDef error fill:#ff6b6b,stroke:#c92a2a,color:#fff');
	lines.push('    classDef cancelled fill:#ffd43b,stroke:#fab005,color:#000');
	lines.push('    classDef inprogress fill:#74c0fc,stroke:#339af0,color:#000');
	lines.push('    classDef subagent fill:#b2f2bb,stroke:#40c057,color:#000');
	lines.push('    classDef parallel fill:#e9d5ff,stroke:#9333ea,color:#000');
	lines.push('');

	const totalToolCalls = session.toolCalls.length;
	const shouldSimplify = !detailed && totalToolCalls > MAX_NODES_BEFORE_SIMPLIFICATION;

	// For very large sessions, limit turns and group subagent turns
	const MAX_TURNS_BEFORE_GROUPING = 15;
	const shouldGroupSubagents = !detailed && session.turns.length > MAX_TURNS_BEFORE_GROUPING;

	let nodeIndex = 0;
	let lastNodeId: string | null = null;

	// Pre-process: group subagent turns, detecting parallel execution
	interface TurnGroup {
		turns: typeof session.turns;
		isSubagentGroup: boolean;
		isParallel: boolean;
		subagentName?: string;
		totalTools: number;
	}
	const turnGroups: TurnGroup[] = [];

	if (shouldGroupSubagents) {
		let currentGroup: TurnGroup | null = null;

		for (const turn of session.turns) {
			const isSubagent = isSubagentTurn(turn.prompt);

			if (isSubagent) {
				// Extract subagent name from prompt
				const subagentName = getSubagentName(turn.prompt);

				if (currentGroup?.isSubagentGroup && currentGroup.subagentName === subagentName) {
					// Check if this turn overlaps with any turn in current group (parallel)
					const hasOverlap = currentGroup.turns.some(t => turnsOverlap(t, turn));
					if (hasOverlap) {
						currentGroup.isParallel = true;
					}
					currentGroup.turns.push(turn);
					currentGroup.totalTools += turn.toolCalls.length;
				} else {
					if (currentGroup) {
						turnGroups.push(currentGroup);
					}
					currentGroup = {
						turns: [turn],
						isSubagentGroup: true,
						isParallel: false,
						subagentName,
						totalTools: turn.toolCalls.length
					};
				}
			} else {
				if (currentGroup) {
					turnGroups.push(currentGroup);
				}
				currentGroup = {
					turns: [turn],
					isSubagentGroup: false,
					isParallel: false,
					totalTools: turn.toolCalls.length
				};
			}
		}
		if (currentGroup) {
			turnGroups.push(currentGroup);
		}
	} else {
		// No grouping - each turn is its own group
		for (const turn of session.turns) {
			turnGroups.push({
				turns: [turn],
				isSubagentGroup: isSubagentTurn(turn.prompt),
				isParallel: false,
				totalTools: turn.toolCalls.length
			});
		}
	}

	for (let groupIdx = 0; groupIdx < turnGroups.length; groupIdx++) {
		const group = turnGroups[groupIdx];

		if (group.isSubagentGroup && group.turns.length > 1) {
			// Render grouped subagent turns
			const groupNodeId = nodeId('SG', groupIdx);
			const subagentName = escapeToolName(group.subagentName || 'subagent');
			const parallelIndicator = group.isParallel ? ' ⚡' : '';
			const styleClass = group.isParallel ? ':::parallel' : ':::subagent';
			lines.push(`    ${groupNodeId}(["${subagentName}${parallelIndicator} - ${group.turns.length} turns, ${group.totalTools} tools"])${styleClass}`);
			if (lastNodeId) {
				lines.push(`    ${lastNodeId} --> ${groupNodeId}`);
			}
			lastNodeId = groupNodeId;
			continue;
		}

		// Render individual turns
		for (let i = 0; i < group.turns.length; i++) {
			const turn = group.turns[i];
			const turnIdx = session.turns.indexOf(turn);
			const isSubagent = group.isSubagentGroup;

			// User prompt node - style differently for subagent turns
			const userNodeId = nodeId('U', turnIdx);
			const promptPreview = escapeLabel(turn.prompt.substring(0, 40));
			if (isSubagent) {
				lines.push(`    ${userNodeId}(["${promptPreview}..."]):::subagent`);
			} else {
				lines.push(`    ${userNodeId}[/"User: ${promptPreview}..."/]`);
			}

			if (lastNodeId) {
				lines.push(`    ${lastNodeId} --> ${userNodeId}`);
			}
			lastNodeId = userNodeId;

			// Tool calls
			if (shouldSimplify) {
				// Group consecutive tools, but handle parallel subagents specially
				const groups = groupConsecutiveTools(turn.toolCalls);

				// Count runSubagent groups
				const subagentGroups = groups.filter(g => g.name === 'runSubagent');
				const hasParallelSubagents = subagentGroups.length > 0 && subagentGroups.reduce((sum, g) => sum + g.count, 0) > 1;

				for (const toolGroup of groups) {
					nodeIndex++;
					const toolNodeId = nodeId('T', nodeIndex);
					const hasError = toolGroup.tools.some(t => t.status === DebugItemStatus.Failure);
					const escapedName = escapeToolName(toolGroup.name);

					// Handle parallel subagents
					if (toolGroup.name === 'runSubagent' && hasParallelSubagents) {
						// Render as parallel fork/join
						const forkNodeId = nodeId('Fork', turnIdx);
						lines.push(`    ${forkNodeId}{{"⚡ ${toolGroup.count} Parallel SubAgents"}}:::parallel`);
						lines.push(`    ${lastNodeId} --> ${forkNodeId}`);

						const subagentEndNodeIds: string[] = [];
						for (let si = 0; si < toolGroup.tools.length; si++) {
							const subTool = toolGroup.tools[si];
							const subAgent = findSubAgent(session.subAgents, subTool.subAgentSessionId!);
							if (subAgent) {
								const subNodeId = nodeId('S', nodeIndex * 100 + si);
								const subAgentName = escapeToolName(subAgent.name);
								lines.push(`    ${subNodeId}(["${subAgentName}"]):::subagent`);
								lines.push(`    ${forkNodeId} --> ${subNodeId}`);
								subagentEndNodeIds.push(subNodeId);
							} else {
								// No session/subagent data
								const desc = subTool.args?.['description'] as string || `SubAgent ${si + 1}`;
								const subNodeId = nodeId('S', nodeIndex * 100 + si);
								lines.push(`    ${subNodeId}(["${escapeToolName(desc)}"]):::subagent`);
								lines.push(`    ${forkNodeId} --> ${subNodeId}`);
								subagentEndNodeIds.push(subNodeId);
							}
						}

						// Create join node
						const joinNodeId = nodeId('Join', turnIdx);
						lines.push(`    ${joinNodeId}(["Join"]):::parallel`);
						for (const endNodeId of subagentEndNodeIds) {
							lines.push(`    ${endNodeId} --> ${joinNodeId}`);
						}

						lastNodeId = joinNodeId;
						continue;
					}

					// Regular grouped tools
					const label = toolGroup.count > 1
						? `${toolGroup.count}x ${escapedName}`
						: escapedName;
					lines.push(`    ${toolNodeId}["${label}"]${hasError ? ':::error' : ''}`);
					lines.push(`    ${lastNodeId} --> ${toolNodeId}`);

					// Check for sub-agents (single subagent case)
					const subAgentTools = toolGroup.tools.filter(t => t.subAgentSessionId);
					if (subAgentTools.length > 0 && !hasParallelSubagents) {
						for (const subTool of subAgentTools) {
							const subAgent = findSubAgent(session.subAgents, subTool.subAgentSessionId!);
							if (subAgent) {
								const subNodeId = nodeId('S', nodeIndex);
								const subAgentLabel = formatSubAgentLabel(subAgent);
								lines.push(`    ${subNodeId}(["${subAgentLabel}"]):::subagent`);
								lines.push(`    ${toolNodeId} -.-> ${subNodeId}`);
								lines.push(`    ${subNodeId} -.-> ${toolNodeId}`);
							}
						}
					}

					lastNodeId = toolNodeId;
				}
			} else {
				// Show individual tool calls with parallel runSubagent detection
				// Identify subagent calls to detect parallel execution
				const subagentTools: DebugToolCall[] = [];
				let subagentStart = -1;

				for (let ti = 0; ti < turn.toolCalls.length; ti++) {
					const tool = turn.toolCalls[ti];
					if (tool.name === 'runSubagent') {
						subagentTools.push(tool);
						if (subagentStart < 0) {
							subagentStart = ti;
						}
					}
				}

				const hasParallelSubagents = subagentTools.length > 1;

				for (let ti = 0; ti < turn.toolCalls.length; ti++) {
					const tool = turn.toolCalls[ti];

					// If this is a runSubagent and we have parallel subagents, handle specially
					if (tool.name === 'runSubagent' && hasParallelSubagents) {
						// Only render the parallel fork once (at the first subagent position)
						if (ti === subagentStart) {
							const forkNodeId = nodeId('Fork', turnIdx);
							lines.push(`    ${forkNodeId}{{"⚡ Parallel SubAgents"}}:::parallel`);
							lines.push(`    ${lastNodeId} --> ${forkNodeId}`);

							// Render all subagent branches from the fork
							const subagentEndNodeIds: string[] = [];
							for (let si = 0; si < subagentTools.length; si++) {
								const subTool = subagentTools[si];
								nodeIndex++;
								const toolNodeId = nodeId('T', nodeIndex);
								const statusCls = statusClass(subTool.status);
								lines.push(`    ${toolNodeId}["runSubagent"]${statusCls}`);
								lines.push(`    ${forkNodeId} --> ${toolNodeId}`);

								// Sub-agent details
								if (subTool.subAgentSessionId) {
									const subAgent = findSubAgent(session.subAgents, subTool.subAgentSessionId!);
									if (subAgent) {
										const subNodeId = nodeId('S', nodeIndex);
										const subAgentName = escapeToolName(subAgent.name);
										const toolCount = subAgent.toolCalls.length > 0 ? ` - ${subAgent.toolCalls.length} tools` : '';
										lines.push(`    ${subNodeId}(["${subAgentName}${toolCount}"]):::subagent`);
										lines.push(`    ${toolNodeId} -.-> ${subNodeId}`);
										subagentEndNodeIds.push(subNodeId);
									} else {
										subagentEndNodeIds.push(toolNodeId);
									}
								} else {
									// No session ID - check args for description
									const desc = subTool.args?.['description'] as string || 'SubAgent';
									const subNodeId = nodeId('S', nodeIndex);
									lines.push(`    ${subNodeId}(["${escapeToolName(desc)}"]):::subagent`);
									lines.push(`    ${toolNodeId} -.-> ${subNodeId}`);
									subagentEndNodeIds.push(subNodeId);
								}
							}

							// Create join node
							const joinNodeId = nodeId('Join', turnIdx);
							lines.push(`    ${joinNodeId}(["Join"]):::parallel`);
							for (const endNodeId of subagentEndNodeIds) {
								lines.push(`    ${endNodeId} -.-> ${joinNodeId}`);
							}

							lastNodeId = joinNodeId;
						}
						// Skip other subagent positions (already rendered in the fork)
						continue;
					}

					// Regular tool call (or single subagent case)
					nodeIndex++;
					const toolNodeId = nodeId('T', nodeIndex);
					const statusCls = statusClass(tool.status);
					const escapedName = escapeToolName(tool.name);
					lines.push(`    ${toolNodeId}["${escapedName}"]${statusCls}`);
					lines.push(`    ${lastNodeId} --> ${toolNodeId}`);

					// Sub-agent branching (single subagent case)
					if (tool.subAgentSessionId) {
						const subAgent = findSubAgent(session.subAgents, tool.subAgentSessionId);
						if (subAgent && (subAgent.toolCalls.length > 0 || subAgent.internalTurns)) {
							// Show subagent box if we have tool call data or internal turn counts
							const subNodeId = nodeId('S', nodeIndex);
							const subAgentLabel = formatSubAgentLabel(subAgent);
							lines.push(`    ${subNodeId}(["${subAgentLabel}"]):::subagent`);
							lines.push(`    ${toolNodeId} -.-> ${subNodeId}`);
							lines.push(`    ${subNodeId} -.-> ${toolNodeId}`);
						}
						// Note: If subAgent has 0 toolCalls and no internalTurns, the subagent's work may appear as
						// separate turns in the session (common in chatreplay multi-prompt format)
					}

					lastNodeId = toolNodeId;
				}
			}

			// Agent response node
			if (turn.response) {
				const respNodeId = nodeId('A', turnIdx);
				const responsePreview = escapeLabel(turn.response.substring(0, 30));
				const statusCls = statusClass(turn.status);
				lines.push(`    ${respNodeId}["Agent: ${responsePreview}..."]${statusCls}`);
				lines.push(`    ${lastNodeId} --> ${respNodeId}`);
				lastNodeId = respNodeId;
			}
		} // End of inner group.turns loop
	} // End of turnGroups loop

	return lines.join('\n');
}

/**
 * Generate a data flow diagram showing how data moves between tools
 */
export function generateDataFlowDiagram(session: DebugSession): string {
	const lines: string[] = ['flowchart LR'];

	// Add style definitions
	lines.push('    classDef file fill:#e7f5ff,stroke:#339af0');
	lines.push('    classDef search fill:#fff3bf,stroke:#fab005');
	lines.push('    classDef edit fill:#d3f9d8,stroke:#40c057');
	lines.push('    classDef terminal fill:#ffe8cc,stroke:#fd7e14');
	lines.push('');

	// Categorize tools by type
	const fileReads = new Set<string>();
	const fileEdits = new Set<string>();
	const searches: string[] = [];
	const terminals: string[] = [];

	let nodeIndex = 0;

	for (const tool of session.toolCalls) {
		const args = tool.args || {};

		// Extract file paths from common tool patterns
		if (tool.name.includes('read_file') || tool.name.includes('readFile')) {
			const filePath = (args['filePath'] || args['path'] || args['file']) as string;
			if (filePath) {
				fileReads.add(filePath);
			}
		} else if (tool.name.includes('edit') || tool.name.includes('write') || tool.name.includes('create_file')) {
			const filePath = (args['filePath'] || args['path'] || args['file']) as string;
			if (filePath) {
				fileEdits.add(filePath);
			}
		} else if (tool.name.includes('search') || tool.name.includes('grep')) {
			const query = (args['query'] || args['pattern'] || args['term']) as string;
			if (query) {
				searches.push(query.substring(0, 20));
			}
		} else if (tool.name.includes('terminal') || tool.name.includes('run')) {
			const cmd = (args['command'] || args['cmd']) as string;
			if (cmd) {
				terminals.push(cmd.substring(0, 20));
			}
		}
	}

	// Generate nodes for file reads
	if (fileReads.size > 0) {
		lines.push('    subgraph Reads["Files Read"]');
		for (const file of fileReads) {
			nodeIndex++;
			const fileName = file.split(/[/\\]/).pop() || file;
			lines.push(`        R${nodeIndex}["${escapeLabel(fileName)}"]:::file`);
		}
		lines.push('    end');
	}

	// Generate nodes for searches
	if (searches.length > 0) {
		lines.push('    subgraph Searches["Searches"]');
		for (let i = 0; i < Math.min(searches.length, 10); i++) {
			nodeIndex++;
			lines.push(`        S${nodeIndex}["${escapeLabel(searches[i])}"]:::search`);
		}
		if (searches.length > 10) {
			lines.push(`        Smore["+${searches.length - 10} more"]:::search`);
		}
		lines.push('    end');
	}

	// Agent node in the middle
	lines.push('    Agent((Agent))');

	// Connect reads to agent
	if (fileReads.size > 0) {
		lines.push('    Reads --> Agent');
	}
	if (searches.length > 0) {
		lines.push('    Searches --> Agent');
	}

	// Generate nodes for file edits
	if (fileEdits.size > 0) {
		lines.push('    subgraph Edits["Files Modified"]');
		for (const file of fileEdits) {
			nodeIndex++;
			const fileName = file.split(/[/\\]/).pop() || file;
			lines.push(`        E${nodeIndex}["${escapeLabel(fileName)}"]:::edit`);
		}
		lines.push('    end');
		lines.push('    Agent --> Edits');
	}

	// Generate nodes for terminals
	if (terminals.length > 0) {
		lines.push('    subgraph Terminal["Commands"]');
		for (let i = 0; i < Math.min(terminals.length, 5); i++) {
			nodeIndex++;
			lines.push(`        C${nodeIndex}["${escapeLabel(terminals[i])}"]:::terminal`);
		}
		if (terminals.length > 5) {
			lines.push(`        Cmore["+${terminals.length - 5} more"]:::terminal`);
		}
		lines.push('    end');
		lines.push('    Agent --> Terminal');
	}

	return lines.join('\n');
}

/**
 * Generate a sub-agent hierarchy tree diagram
 */
export function generateSubAgentTreeDiagram(session: DebugSession): string {
	if (session.subAgents.length === 0) {
		return 'flowchart TD\n    Root[Main Agent<br/>No sub-agents invoked]';
	}

	const lines: string[] = ['flowchart TD'];
	lines.push('    classDef subagent fill:#b2f2bb,stroke:#40c057');
	lines.push('');

	// Root node
	lines.push(`    Root[Main Agent<br/>${session.metrics.totalToolCalls} tool calls]`);

	// Render sub-agents recursively
	function renderSubAgent(subAgent: DebugSubAgent, parentId: string, index: number): void {
		const safeNodeId = `S${index}_${subAgent.name.replace(/\W/g, '')}`;
		const toolCount = subAgent.toolCalls.length;
		const childCount = subAgent.children.length;
		const escapedName = escapeToolName(subAgent.name);

		// Build label with internal turn count if available
		let label = `${escapedName}`;
		const details: string[] = [];

		if (subAgent.internalTurns) {
			details.push(`${subAgent.internalTurns} turns`);
		}
		if (toolCount > 0) {
			details.push(`${toolCount} tools`);
		}
		if (subAgent.promptTokens) {
			const kTokens = Math.round(subAgent.promptTokens / 1000);
			details.push(`${kTokens}k tokens`);
		}
		if (childCount > 0) {
			details.push(`${childCount} nested`);
		}

		if (details.length > 0) {
			label += `<br/>${details.join(', ')}`;
		}

		lines.push(`    ${safeNodeId}(["${label}"]):::subagent`);
		lines.push(`    ${parentId} --> ${safeNodeId}`);

		// Render children
		subAgent.children.forEach((child, childIdx) => {
			renderSubAgent(child, safeNodeId, index * 100 + childIdx);
		});
	}

	session.subAgents.forEach((subAgent, idx) => {
		renderSubAgent(subAgent, 'Root', idx);
	});

	return lines.join('\n');
}

/**
 * Generate a sequence diagram showing temporal flow
 */
export function generateSequenceDiagram(session: DebugSession, detailed: boolean = false): string {
	const lines: string[] = ['sequenceDiagram'];

	// Check if we have any subagent turns (from patterns or session.subAgents)
	const hasSubagentTurns = session.subAgents.length > 0 ||
		session.turns.some(t => isSubagentTurn(t.prompt));

	// Define participants
	lines.push('    participant U as User');
	lines.push('    participant A as Agent');
	lines.push('    participant T as Tools');

	// Add sub-agent participant if we have subagent activity
	if (hasSubagentTurns) {
		lines.push('    participant S as SubAgents');
	}

	lines.push('');

	const maxTools = detailed ? 100 : 15;
	const maxTurns = detailed ? 50 : 20;
	let toolCount = 0;
	let turnCount = 0;

	// Group consecutive subagent turns for cleaner visualization
	let currentSubagentGroup: { name: string; turns: number; tools: number } | null = null;

	for (const turn of session.turns) {
		if (turnCount >= maxTurns && !detailed) {
			lines.push(`    Note over A: +${session.turns.length - maxTurns} more turns...`);
			break;
		}

		const isSubagent = isSubagentTurn(turn.prompt);

		if (isSubagent) {
			// This is a subagent turn
			const subagentName = escapeToolName(getSubagentName(turn.prompt));

			if (currentSubagentGroup && currentSubagentGroup.name === subagentName) {
				// Continue grouping consecutive subagent turns
				currentSubagentGroup.turns++;
				currentSubagentGroup.tools += turn.toolCalls.length;
			} else {
				// Flush previous group if any
				if (currentSubagentGroup) {
					lines.push(`    S-->>T: ${currentSubagentGroup.name} completed (${currentSubagentGroup.turns} turns, ${currentSubagentGroup.tools} tools)`);
					lines.push(`    T-->>A: subagent result`);
				}
				// Start new group
				currentSubagentGroup = { name: subagentName, turns: 1, tools: turn.toolCalls.length };
				lines.push(`    A->>T: runSubagent`);
				lines.push(`    T->>S: invoke ${subagentName}`);
			}
			turnCount++;
			continue;
		}

		// Flush any pending subagent group before processing main turn
		if (currentSubagentGroup) {
			lines.push(`    S-->>T: ${currentSubagentGroup.name} completed (${currentSubagentGroup.turns} turns, ${currentSubagentGroup.tools} tools)`);
			lines.push(`    T-->>A: subagent result`);
			currentSubagentGroup = null;
		}

		// User message (main turns only)
		const promptPreview = escapeLabel(turn.prompt.substring(0, 30));
		lines.push(`    U->>A: ${promptPreview}...`);

		// Tool calls
		const toolsToShow = detailed ? turn.toolCalls : turn.toolCalls.slice(0, maxTools);
		for (const tool of toolsToShow) {
			if (toolCount >= maxTools && !detailed) {
				lines.push(`    Note over T: +${turn.toolCalls.length - maxTools} more tools...`);
				break;
			}

			const statusIndicator = tool.status === DebugItemStatus.Failure ? ' X' : '';
			const escapedName = escapeToolName(tool.name);
			lines.push(`    A->>T: ${escapedName}${statusIndicator}`);

			// Check for subagent invocation via tool metadata
			if (tool.subAgentSessionId) {
				const subAgent = findSubAgent(session.subAgents, tool.subAgentSessionId);
				if (subAgent) {
					const subAgentName = escapeToolName(subAgent.name);
					lines.push(`    T->>S: invoke ${subAgentName}`);
					lines.push(`    S-->>T: ${subAgent.toolCalls.length} tools executed`);
				}
			}

			lines.push(`    T-->>A: result`);
			toolCount++;
		}

		// Agent response
		if (turn.response) {
			const statusIndicator = turn.status === DebugItemStatus.Failure ? ' X' : '';
			const responsePreview = escapeLabel(turn.response.substring(0, 25));
			lines.push(`    A->>U: ${responsePreview}...${statusIndicator}`);
		}

		lines.push('');
		turnCount++;
	}

	// Flush final subagent group if any
	if (currentSubagentGroup) {
		lines.push(`    S-->>T: ${currentSubagentGroup.name} completed (${currentSubagentGroup.turns} turns, ${currentSubagentGroup.tools} tools)`);
		lines.push(`    T-->>A: subagent result`);
	}

	return lines.join('\n');
}

/**
 * Find a sub-agent by session ID
 */
function findSubAgent(subAgents: DebugSubAgent[], sessionId: string): DebugSubAgent | undefined {
	for (const subAgent of subAgents) {
		if (subAgent.sessionId === sessionId) {
			return subAgent;
		}
		const found = findSubAgent(subAgent.children, sessionId);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/**
 * Generate a timeline diagram showing tool calls over time
 */
export function generateTimelineDiagram(session: DebugSession): string {
	const lines: string[] = ['gantt'];
	lines.push('    title Session Timeline');
	lines.push('    dateFormat X');
	lines.push('    axisFormat %s');
	lines.push('');

	if (session.turns.length === 0) {
		return 'flowchart TD\n    Empty[No turns recorded]';
	}

	// Use relative time from session start
	const sessionStart = session.startTime?.getTime() || session.turns[0]?.timestamp?.getTime() || 0;

	for (let turnIdx = 0; turnIdx < session.turns.length; turnIdx++) {
		const turn = session.turns[turnIdx];
		lines.push(`    section Turn ${turnIdx + 1}`);

		// Approximate timing - use index-based positioning if no timestamps
		const turnStart = turn.timestamp?.getTime() || (sessionStart + turnIdx * 10000);
		const turnRelStart = Math.floor((turnStart - sessionStart) / 1000);

		let toolIdx = 0;
		for (const tool of turn.toolCalls.slice(0, 10)) {
			const toolRelStart = turnRelStart + toolIdx;
			const duration = Math.max(1, Math.floor((tool.durationMs || 1000) / 1000));
			const status = tool.status === DebugItemStatus.Failure ? 'crit, ' : '';
			const escapedName = escapeToolName(tool.name).substring(0, 30);
			lines.push(`    ${status}${escapedName} :${toolRelStart}, ${duration}s`);
			toolIdx++;
		}

		if (turn.toolCalls.length > 10) {
			lines.push(`    +${turn.toolCalls.length - 10} more tools :${turnRelStart + 10}, 1s`);
		}
	}

	return lines.join('\n');
}
