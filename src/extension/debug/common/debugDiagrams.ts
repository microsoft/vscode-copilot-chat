/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DebugItemStatus, DebugSession, DebugSubAgent, DebugToolCall } from './debugTypes';

/**
 * Maximum number of nodes before simplification kicks in
 */
const MAX_NODES_BEFORE_SIMPLIFICATION = 50;

/**
 * Escape special characters for Mermaid labels
 */
function escapeLabel(text: string): string {
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
		.replace(/&(?!lt;|gt;|amp;|quot;)/g, '&amp;')  // Ampersand (but not entities)
		.replace(/\n/g, ' ')     // Newlines
		.replace(/\r/g, '')      // Carriage returns
		.substring(0, 50);
}

/**
 * Get a short ID for Mermaid node names
 */
function nodeId(prefix: string, index: number): string {
	return `${prefix}${index}`;
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
	lines.push('');

	const totalToolCalls = session.toolCalls.length;
	const shouldSimplify = !detailed && totalToolCalls > MAX_NODES_BEFORE_SIMPLIFICATION;

	let nodeIndex = 0;
	let lastNodeId: string | null = null;

	for (let turnIdx = 0; turnIdx < session.turns.length; turnIdx++) {
		const turn = session.turns[turnIdx];

		// User prompt node
		const userNodeId = nodeId('U', turnIdx);
		const promptPreview = escapeLabel(turn.prompt.substring(0, 40));
		lines.push(`    ${userNodeId}[/"User: ${promptPreview}..."/]`);

		if (lastNodeId) {
			lines.push(`    ${lastNodeId} --> ${userNodeId}`);
		}
		lastNodeId = userNodeId;

		// Tool calls
		if (shouldSimplify) {
			// Group consecutive tools
			const groups = groupConsecutiveTools(turn.toolCalls);
			for (const group of groups) {
				nodeIndex++;
				const toolNodeId = nodeId('T', nodeIndex);
				const hasError = group.tools.some(t => t.status === DebugItemStatus.Failure);
				const label = group.count > 1
					? `${group.count}× ${group.name}`
					: group.name;
				lines.push(`    ${toolNodeId}[${label}]${hasError ? ':::error' : ''}`);
				lines.push(`    ${lastNodeId} --> ${toolNodeId}`);

				// Check for sub-agents
				const subAgentTools = group.tools.filter(t => t.subAgentSessionId);
				if (subAgentTools.length > 0) {
					for (const subTool of subAgentTools) {
						const subAgent = findSubAgent(session.subAgents, subTool.subAgentSessionId!);
						if (subAgent) {
							const subNodeId = nodeId('S', nodeIndex);
							lines.push(`    ${subNodeId}([SubAgent: ${subAgent.name}]):::subagent`);
							lines.push(`    ${toolNodeId} -.-> ${subNodeId}`);
							lines.push(`    ${subNodeId} -.-> ${toolNodeId}`);
						}
					}
				}

				lastNodeId = toolNodeId;
			}
		} else {
			// Show individual tool calls
			for (const tool of turn.toolCalls) {
				nodeIndex++;
				const toolNodeId = nodeId('T', nodeIndex);
				const statusCls = statusClass(tool.status);
				lines.push(`    ${toolNodeId}[${tool.name}]${statusCls}`);
				lines.push(`    ${lastNodeId} --> ${toolNodeId}`);

				// Sub-agent branching
				if (tool.subAgentSessionId) {
					const subAgent = findSubAgent(session.subAgents, tool.subAgentSessionId);
					if (subAgent) {
						const subNodeId = nodeId('S', nodeIndex);
						lines.push(`    ${subNodeId}([SubAgent: ${subAgent.name}<br/>${subAgent.toolCalls.length} tools]):::subagent`);
						lines.push(`    ${toolNodeId} -.-> ${subNodeId}`);
						lines.push(`    ${subNodeId} -.-> ${toolNodeId}`);
					}
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
	}

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
		lines.push('    subgraph Reads["📖 Files Read"]');
		for (const file of fileReads) {
			nodeIndex++;
			const fileName = file.split(/[/\\]/).pop() || file;
			lines.push(`        R${nodeIndex}[${escapeLabel(fileName)}]:::file`);
		}
		lines.push('    end');
	}

	// Generate nodes for searches
	if (searches.length > 0) {
		lines.push('    subgraph Searches["🔍 Searches"]');
		for (let i = 0; i < Math.min(searches.length, 10); i++) {
			nodeIndex++;
			lines.push(`        S${nodeIndex}[${escapeLabel(searches[i])}]:::search`);
		}
		if (searches.length > 10) {
			lines.push(`        Smore[+${searches.length - 10} more]:::search`);
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
		lines.push('    subgraph Edits["✏️ Files Modified"]');
		for (const file of fileEdits) {
			nodeIndex++;
			const fileName = file.split(/[/\\]/).pop() || file;
			lines.push(`        E${nodeIndex}[${escapeLabel(fileName)}]:::edit`);
		}
		lines.push('    end');
		lines.push('    Agent --> Edits');
	}

	// Generate nodes for terminals
	if (terminals.length > 0) {
		lines.push('    subgraph Terminal["⚡ Commands"]');
		for (let i = 0; i < Math.min(terminals.length, 5); i++) {
			nodeIndex++;
			lines.push(`        C${nodeIndex}[${escapeLabel(terminals[i])}]:::terminal`);
		}
		if (terminals.length > 5) {
			lines.push(`        Cmore[+${terminals.length - 5} more]:::terminal`);
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
		const nodeId = `S${index}_${subAgent.name.replace(/\W/g, '')}`;
		const toolCount = subAgent.toolCalls.length;
		const childCount = subAgent.children.length;

		let label = `${subAgent.name}<br/>${toolCount} tools`;
		if (childCount > 0) {
			label += `<br/>${childCount} nested`;
		}

		lines.push(`    ${nodeId}([${label}]):::subagent`);
		lines.push(`    ${parentId} --> ${nodeId}`);

		// Render children
		subAgent.children.forEach((child, childIdx) => {
			renderSubAgent(child, nodeId, index * 100 + childIdx);
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

	// Define participants
	lines.push('    participant U as User');
	lines.push('    participant A as Agent');
	lines.push('    participant T as Tools');

	// Add sub-agent participant if any
	if (session.subAgents.length > 0) {
		lines.push('    participant S as SubAgents');
	}

	lines.push('');

	const maxTools = detailed ? 100 : 15;
	let toolCount = 0;

	for (const turn of session.turns) {
		// User message
		const promptPreview = escapeLabel(turn.prompt.substring(0, 30));
		lines.push(`    U->>A: ${promptPreview}...`);

		// Tool calls
		const toolsToShow = detailed ? turn.toolCalls : turn.toolCalls.slice(0, maxTools);
		for (const tool of toolsToShow) {
			if (toolCount >= maxTools && !detailed) {
				lines.push(`    Note over T: +${turn.toolCalls.length - maxTools} more tools...`);
				break;
			}

			const statusIndicator = tool.status === DebugItemStatus.Failure ? ' ❌' : '';
			lines.push(`    A->>T: ${tool.name}${statusIndicator}`);

			if (tool.subAgentSessionId) {
				const subAgent = findSubAgent(session.subAgents, tool.subAgentSessionId);
				if (subAgent) {
					lines.push(`    T->>S: invoke ${subAgent.name}`);
					lines.push(`    S-->>T: ${subAgent.toolCalls.length} tools executed`);
				}
			}

			lines.push(`    T-->>A: result`);
			toolCount++;
		}

		// Agent response
		if (turn.response) {
			const statusIndicator = turn.status === DebugItemStatus.Failure ? ' ❌' : '';
			const responsePreview = escapeLabel(turn.response.substring(0, 25));
			lines.push(`    A->>U: ${responsePreview}...${statusIndicator}`);
		}

		lines.push('');
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
			lines.push(`    ${status}${tool.name} :${toolRelStart}, ${duration}s`);
			toolIdx++;
		}

		if (turn.toolCalls.length > 10) {
			lines.push(`    +${turn.toolCalls.length - 10} more tools :${turnRelStart + 10}, 1s`);
		}
	}

	return lines.join('\n');
}
