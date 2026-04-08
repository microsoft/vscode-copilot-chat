/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RefRow, SessionRow } from '../../../platform/chronicle/common/sessionStore';

/** A session row annotated with its source. */
export interface AnnotatedSession extends SessionRow {
	/** Where this session came from: 'vscode', 'cli', or 'cloud'. */
	source: 'vscode' | 'cli' | 'cloud';
}

/** A ref row annotated with its source. */
export interface AnnotatedRef extends RefRow {
	source: 'vscode' | 'cli' | 'cloud';
}

/** Sessions query — SQLite dialect, no time filter (demo) */
export const SESSIONS_QUERY_SQLITE = `SELECT id, summary, branch, repository, cwd, created_at, updated_at
	FROM sessions
	ORDER BY updated_at DESC`;

/** Build refs query for a list of session IDs */
export function buildRefsQuery(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, ref_type, ref_value FROM session_refs WHERE session_id IN (${ids})`;
}

/** Build files query for a list of session IDs */
export function buildFilesQuery(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, file_path, tool_name FROM session_files WHERE session_id IN (${ids})`;
}

/** Build turns query for a list of session IDs (user messages + assistant response summaries, truncated) */
export function buildTurnsQuery(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, turn_index, substr(user_message, 1, 120) as user_message, substr(assistant_response, 1, 200) as assistant_response FROM turns WHERE session_id IN (${ids}) AND (user_message IS NOT NULL OR assistant_response IS NOT NULL) ORDER BY session_id, turn_index`;
}

/** A file row from the session_files table. */
export interface SessionFileInfo {
	session_id: string;
	file_path: string;
	tool_name?: string;
}

/** A turn summary from the turns table. */
export interface SessionTurnInfo {
	session_id: string;
	turn_index: number;
	user_message: string;
	assistant_response?: string;
}

/**
 * Build a standup prompt from pre-fetched session and ref data.
 */
export function buildStandupPrompt(
	sessions: AnnotatedSession[],
	refs: AnnotatedRef[],
	extra?: string,
	files?: SessionFileInfo[],
	turns?: SessionTurnInfo[],
): string {
	if (sessions.length === 0) {
		return 'The user ran /standup but no sessions were found in the last 24 hours. Let them know there\'s no recent activity to report.';
	}

	const vscodeSessions = sessions.filter(s => s.source === 'vscode');
	const cliSessions = sessions.filter(s => s.source === 'cli');
	const cloudSessions = sessions.filter(s => s.source === 'cloud');
	const vscodeRefs = refs.filter(r => r.source === 'vscode');
	const cliRefs = refs.filter(r => r.source === 'cli');
	const cloudRefs = refs.filter(r => r.source === 'cloud');

	// Group files and turns by session ID for inline rendering
	const filesBySession = new Map<string, SessionFileInfo[]>();
	for (const f of files ?? []) {
		const arr = filesBySession.get(f.session_id) ?? [];
		arr.push(f);
		filesBySession.set(f.session_id, arr);
	}
	const turnsBySession = new Map<string, SessionTurnInfo[]>();
	for (const t of turns ?? []) {
		const arr = turnsBySession.get(t.session_id) ?? [];
		arr.push(t);
		turnsBySession.set(t.session_id, arr);
	}

	const formatSession = (s: AnnotatedSession) => {
		const branch = s.branch ?? 'unknown';
		const repo = s.repository ?? 'unknown';
		const cwd = (s as SessionRow & { cwd?: string }).cwd;
		const hostType = s.host_type;
		const summary = s.summary ?? 'No summary';
		let sourceLabel = s.source === 'cli' ? 'CLI' : s.source === 'cloud' ? 'Cloud' : 'VS Code';
		if (s.source === 'cloud' && hostType) {
			sourceLabel = `Cloud/${hostType}`;
		}
		let line = `- [${sourceLabel}] ${s.id} | ${repo} (${branch}) | ${summary} | updated ${s.updated_at}`;
		if (cwd && repo === 'unknown') {
			line += `\n    Working directory: ${cwd}`;
		}

		const sessionFiles = filesBySession.get(s.id);
		if (sessionFiles && sessionFiles.length > 0) {
			const fileList = sessionFiles.slice(0, 10).map(f => f.file_path).join(', ');
			line += `\n    Files touched: ${fileList}${sessionFiles.length > 10 ? ` (+${sessionFiles.length - 10} more)` : ''}`;
		}

		const sessionTurns = turnsBySession.get(s.id);
		if (sessionTurns && sessionTurns.length > 0) {
			// Show user messages as a brief activity log (skip slash commands)
			const meaningful = sessionTurns
				.filter(t => t.user_message && !t.user_message.startsWith('/'))
				.slice(0, 5);
			if (meaningful.length > 0) {
				const turnLines = meaningful.map(t => {
					let entry = t.user_message.trim();
					if (t.assistant_response) {
						entry += ` → ${t.assistant_response.trim()}`;
					}
					return entry;
				});
				line += `\n    Conversation:\n${turnLines.map(t => `      - ${t}`).join('\n')}`;
			}
		}

		return line;
	};

	const formatRef = (r: AnnotatedRef) =>
		`- ${r.session_id} | ${r.ref_type}: ${r.ref_value}`;

	let prompt = `The user ran /standup. Generate a concise standup update from the pre-fetched data below.
Data comes from three sources — VS Code (local editor sessions), CLI (terminal copilot sessions), and Cloud (sessions from other machines/surfaces).

## Pre-fetched Session Data (last 7 days)

### 🖥️ VS Code Sessions (${vscodeSessions.length})
${vscodeSessions.length > 0 ? vscodeSessions.map(formatSession).join('\n') : 'No VS Code sessions found.'}

### ⌨️ CLI Sessions (${cliSessions.length})
${cliSessions.length > 0 ? cliSessions.map(formatSession).join('\n') : 'No CLI sessions found.'}

### ☁️ Cloud Sessions (${cloudSessions.length})
${cloudSessions.length > 0 ? cloudSessions.map(formatSession).join('\n') : 'No cloud sessions found.'}

### References (PRs, Issues, Commits)
${vscodeRefs.length > 0 ? '**VS Code refs:**\n' + vscodeRefs.map(formatRef).join('\n') : ''}
${cliRefs.length > 0 ? '**CLI refs:**\n' + cliRefs.map(formatRef).join('\n') : ''}
${cloudRefs.length > 0 ? '**Cloud refs:**\n' + cloudRefs.map(formatRef).join('\n') : ''}
${refs.length === 0 ? 'No references found.' : ''}

## Next Steps

1. For any PR references above, use GitHub tools to check their current status (open, merged, draft, closed).

## Output Format

Format the update grouped by source first (VS Code, CLI, Cloud), then by work stream (branch). Show up to 10 items per section. For each session, provide rich detail. Use exactly this structure:

Standup for <date>:

**🖥️ VS Code Sessions**

**✅ Done**

**Feature name** (\`branch-name\` branch, \`repository\`)
  - Detailed summary of what was accomplished (use conversation and file data)
  - Key files modified: \`file1.ts\`, \`file2.ts\`
  - Tools used: apply_patch, run_in_terminal, etc.
  - References: [#123](link) if any
  - Session: \`full-session-id\`
  - Last active: <timestamp>

**🚧 In Progress**

**Feature name** (\`branch-name\` branch, \`repository\`)
  - What was started and current state of work
  - Key files being worked on: \`file1.ts\`, \`file2.ts\`
  - What's next / blockers if apparent
  - Session: \`full-session-id\`
  - Last active: <timestamp>

**⌨️ CLI Sessions**

(Same detailed format as above)

**☁️ Cloud Sessions**

(Same detailed format as above)

Formatting rules:
- Show up to 10 items per source section. Do NOT truncate or summarize multiple sessions into one.
- Include ALL detail available: file paths, conversation snippets, tool names, timestamps.
- Link PRs and issues using markdown link syntax.
- Use the conversation activity data to generate rich descriptions — don't just repeat the summary.
- Show the working directory if repository/branch is unknown.
- CRITICAL: You MUST keep VS Code, CLI, and Cloud sessions in separate sections. NEVER mix them.
- CRITICAL: You MUST include ALL three sections (VS Code, CLI, Cloud) if they have data. If a section has no sessions, show "No activity" under it.
- Omit the Done or In Progress subsection if there are no items for it.`;

	if (extra) {
		prompt += `\n\nAdditional context: ${extra}`;
	}

	return prompt;
}
