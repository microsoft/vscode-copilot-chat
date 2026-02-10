/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	generateControlFlowDiagram,
	generateDataFlowDiagram,
	generateSequenceDiagram,
	generateSubAgentTreeDiagram
} from '../common/debugDiagrams';
import {
	formatErrorsReport,
	formatHelp,
	formatSearchResults,
	formatSessionSummary,
	formatSubAgentsReport,
	formatThinkingReport,
	formatTimeline,
	formatTokensReport,
	formatToolCallsTable,
	formatTranscriptEvents
} from '../common/debugFormatters';
import {
	DebugQuery,
	DebugQueryResult,
	DebugQueryType,
	DebugSession
} from '../common/debugTypes';

/**
 * Parse a user query string into a structured DebugQuery
 */
export function parseQuery(input: string): DebugQuery {
	const trimmed = input.trim().toLowerCase();

	// Handle slash commands
	if (trimmed.startsWith('/')) {
		const parts = trimmed.substring(1).split(/\s+/);
		const command = parts[0];
		const rest = parts.slice(1).join(' ');

		// Parse options
		const detailed = parts.includes('--detailed') || parts.includes('-d');
		const limitMatch = rest.match(/--limit[=\s](\d+)/);
		const limit = limitMatch ? parseInt(limitMatch[1], 10) : undefined;

		switch (command) {
			case 'summary':
			case 's':
				return { type: DebugQueryType.Summary, options: {} };

			case 'tools':
			case 't':
				return { type: DebugQueryType.Tools, options: { limit } };

			case 'errors':
			case 'e':
			case 'failures':
				return { type: DebugQueryType.Errors, options: {} };

			case 'timeline':
			case 'tl':
				return { type: DebugQueryType.Timeline, options: {} };

			case 'subagents':
			case 'sub':
			case 'sa':
				return { type: DebugQueryType.SubAgents, options: {} };

			case 'search': {
				const searchTerm = parts.slice(1).filter(p => !p.startsWith('--')).join(' ');
				return { type: DebugQueryType.Search, searchTerm, options: {} };
			}

			case 'flow':
			case 'f':
				return { type: DebugQueryType.Flow, options: { detailed } };

			case 'dataflow':
			case 'df':
				return { type: DebugQueryType.DataFlow, options: {} };

			case 'tree':
				return { type: DebugQueryType.Tree, options: {} };

			case 'sequence':
			case 'seq':
				return { type: DebugQueryType.Sequence, options: { detailed } };

			case 'load':
			case 'l':
				return { type: DebugQueryType.Load, options: {} };

			case 'refresh':
			case 'r':
				return { type: DebugQueryType.Refresh, options: {} };

			case 'help':
			case 'h':
			case '?':
				return { type: DebugQueryType.Help, options: {} };

			case 'thinking':
			case 'think':
			case 'reasoning':
				return { type: DebugQueryType.Thinking, options: { detailed } };

			case 'tokens':
			case 'tok':
			case 'budget':
				return { type: DebugQueryType.Tokens, options: {} };

			case 'transcript':
			case 'events':
			case 'log':
				return { type: DebugQueryType.Transcript, options: { limit } };

			default:
				// Unknown command, treat as search
				return { type: DebugQueryType.Search, searchTerm: trimmed.substring(1), options: {} };
		}
	}

	// Natural language heuristics
	if (trimmed.includes('summary') || trimmed.includes('overview') || trimmed.includes('stats')) {
		return { type: DebugQueryType.Summary, options: {} };
	}
	if (trimmed.includes('tool') || trimmed.includes('function call')) {
		return { type: DebugQueryType.Tools, options: {} };
	}
	if (trimmed.includes('error') || trimmed.includes('fail') || trimmed.includes('problem')) {
		return { type: DebugQueryType.Errors, options: {} };
	}
	if (trimmed.includes('timeline') || trimmed.includes('sequence of events') || trimmed.includes('chronolog')) {
		return { type: DebugQueryType.Timeline, options: {} };
	}
	if (trimmed.includes('subagent') || trimmed.includes('sub-agent') || trimmed.includes('nested')) {
		return { type: DebugQueryType.SubAgents, options: {} };
	}
	if (trimmed.includes('flow') || trimmed.includes('diagram') || trimmed.includes('visual')) {
		return { type: DebugQueryType.Flow, options: {} };
	}
	if (trimmed.includes('data flow') || trimmed.includes('dataflow')) {
		return { type: DebugQueryType.DataFlow, options: {} };
	}
	if (trimmed.includes('tree') || trimmed.includes('hierarchy')) {
		return { type: DebugQueryType.Tree, options: {} };
	}
	if (trimmed.includes('load') || trimmed.includes('open file') || trimmed.includes('import')) {
		return { type: DebugQueryType.Load, options: {} };
	}
	if (trimmed.includes('refresh') || trimmed.includes('reload') || trimmed.includes('update')) {
		return { type: DebugQueryType.Refresh, options: {} };
	}
	if (trimmed.includes('help') || trimmed === '?') {
		return { type: DebugQueryType.Help, options: {} };
	}
	if (trimmed.includes('thinking') || trimmed.includes('reasoning') || trimmed.includes('chain of thought')) {
		return { type: DebugQueryType.Thinking, options: {} };
	}
	if (trimmed.includes('token') || trimmed.includes('budget') || trimmed.includes('usage')) {
		return { type: DebugQueryType.Tokens, options: {} };
	}
	if (trimmed.includes('transcript') || trimmed.includes('event log') || trimmed.includes('raw events')) {
		return { type: DebugQueryType.Transcript, options: {} };
	}

	// Default to search with the entire input
	return { type: DebugQueryType.Search, searchTerm: input.trim(), options: {} };
}

/**
 * Execute a debug query against a session
 */
export function executeQuery(query: DebugQuery, session: DebugSession | undefined): DebugQueryResult {
	// Handle queries that don't need a session
	if (query.type === DebugQueryType.Help) {
		return {
			success: true,
			markdown: formatHelp(),
			title: 'Help'
		};
	}

	if (query.type === DebugQueryType.Load) {
		// Load is handled externally by the panel
		return {
			success: true,
			markdown: '*Opening file picker...*',
			title: 'Load Session'
		};
	}

	if (query.type === DebugQueryType.Refresh) {
		// Refresh is handled externally by the panel
		return {
			success: true,
			markdown: '*Refreshing session data...*',
			title: 'Refresh'
		};
	}

	// All other queries need a session
	if (!session) {
		return {
			success: false,
			error: 'No session data available. Use `/load` to load a trajectory file or ensure there is an active chat session.',
			title: 'Error'
		};
	}

	switch (query.type) {
		case DebugQueryType.Summary:
			return {
				success: true,
				markdown: formatSessionSummary(session),
				title: 'Session Summary'
			};

		case DebugQueryType.Tools:
			return {
				success: true,
				markdown: formatToolCallsTable(session.toolCalls, query.options.limit || 50),
				title: 'Tool Calls'
			};

		case DebugQueryType.Errors:
			return {
				success: true,
				markdown: formatErrorsReport(session),
				title: 'Error Report'
			};

		case DebugQueryType.Timeline:
			return {
				success: true,
				markdown: formatTimeline(session),
				title: 'Timeline'
			};

		case DebugQueryType.SubAgents:
			return {
				success: true,
				markdown: formatSubAgentsReport(session),
				title: 'Sub-Agents'
			};

		case DebugQueryType.Search:
			if (!query.searchTerm) {
				return {
					success: false,
					error: 'Please provide a search term. Usage: `/search <term>`',
					title: 'Search'
				};
			}
			return {
				success: true,
				markdown: formatSearchResults(session.toolCalls, session.turns, query.searchTerm),
				title: `Search: ${query.searchTerm}`
			};

		case DebugQueryType.Flow:
			return {
				success: true,
				markdown: '### Control Flow Diagram\n\nThis diagram shows the sequence of operations in your session.\n',
				mermaid: generateControlFlowDiagram(session, query.options.detailed),
				title: 'Control Flow'
			};

		case DebugQueryType.DataFlow:
			return {
				success: true,
				markdown: '### Data Flow Diagram\n\nThis diagram shows how data moves through the session (files read, edited, searches performed).\n',
				mermaid: generateDataFlowDiagram(session),
				title: 'Data Flow'
			};

		case DebugQueryType.Tree:
			return {
				success: true,
				markdown: '### Sub-Agent Hierarchy\n\nThis diagram shows the tree of sub-agent invocations.\n',
				mermaid: generateSubAgentTreeDiagram(session),
				title: 'Sub-Agent Tree'
			};

		case DebugQueryType.Sequence:
			return {
				success: true,
				markdown: '### Sequence Diagram\n\nThis diagram shows the temporal flow of messages between participants.\n',
				mermaid: generateSequenceDiagram(session, query.options.detailed),
				title: 'Sequence'
			};

		case DebugQueryType.Thinking:
			return {
				success: true,
				markdown: formatThinkingReport(session, query.options.detailed),
				title: 'Thinking/Reasoning'
			};

		case DebugQueryType.Tokens:
			return {
				success: true,
				markdown: formatTokensReport(session),
				title: 'Token Usage'
			};

		case DebugQueryType.Transcript:
			return {
				success: true,
				markdown: formatTranscriptEvents(session, query.options.limit || 100),
				title: 'Transcript Events'
			};

		default:
			return {
				success: false,
				error: `Unknown query type: ${query.type}`,
				title: 'Error'
			};
	}
}

/**
 * Format a query result as HTML for the webview
 */
export function formatResultAsHtml(result: DebugQueryResult): string {
	const lines: string[] = [];

	if (result.title) {
		lines.push(`<h2>${escapeHtml(result.title)}</h2>`);
	}

	if (!result.success && result.error) {
		lines.push(`<div class="error-message">`);
		lines.push(`<p>⚠️ ${escapeHtml(result.error)}</p>`);
		lines.push(`</div>`);
		return lines.join('\n');
	}

	if (result.markdown) {
		// The webview will render Markdown, so we pass it as-is in a special container
		lines.push(`<div class="markdown-content">`);
		lines.push(result.markdown);
		lines.push(`</div>`);
	}

	if (result.mermaid) {
		lines.push(`<div class="mermaid-container">`);
		lines.push(`<pre class="mermaid">`);
		lines.push(escapeHtml(result.mermaid));
		lines.push(`</pre>`);
		lines.push(`</div>`);
	}

	return lines.join('\n');
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}
