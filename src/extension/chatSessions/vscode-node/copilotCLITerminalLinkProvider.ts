/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { CancellationToken, Range, Terminal, TerminalLink, TerminalLinkContext, TerminalLinkProvider, Uri, window, workspace } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';

/**
 * Path detection adapted from VS Code's terminalLinkParsing.ts with :line:col
 * and (line, col) suffix handling appended.
 *
 * Structure:
 *   (?:prefix | start-chars)?  (?:separator segment)+  suffix?
 *
 * Prefix: `.`, `..`, or `~`
 * Separator: `/` or `\` (covers both Unix and Windows CLI output)
 * Start-chars / segment-chars: VS Code's ExcludedPathCharactersClause
 *   excludes  \0 < > ? \s ! ` & * ( ) ' " : ;
 * Start-chars additionally excludes [ ] to avoid matching inside markdown links.
 *
 * On Windows the CLI emits backslash paths (e.g. `~\.copilot\session-state\...`).
 * The separator alternation `[\\/]` mirrors VS Code's WinPathSeparatorClause.
 */
const FILE_PATH_REGEX = /(?<path>(?:(?:\.\.?|~)|(?:[^\0<>?\s!`&*()\[\]'":;\\][^\0<>?\s!`&*()'":;]*))?(?:[\\/](?:[^\0<>?\s!`&*()'":;\\]+))+)(?::(?<line>\d+)(?::(?<col>\d+))?|\((?<parenLine>\d+),\s*(?<parenCol>\d+)\))?/g;

interface CopilotCLITerminalLink extends TerminalLink {
	uri?: Uri;
	terminal: Terminal;
	pathText: string;
	line?: number;
	col?: number;
}

/**
 * Returns session-state directories to try for a terminal.
 */
export type SessionDirResolver = (terminal: Terminal) => Promise<Uri[]>;

/**
 * Resolves relative file links in Copilot CLI terminal output.
 *
 * Copilot CLI paths are relative to the session-state directory, not the
 * workspace root. VS Code's built-in detector cannot resolve that context.
 */
export class CopilotCLITerminalLinkProvider implements TerminalLinkProvider<CopilotCLITerminalLink> {

	private readonly _copilotTerminals = new WeakSet<Terminal>();
	private readonly _terminalSessionDirs = new WeakMap<Terminal, Uri>();
	private _sessionDirResolver: SessionDirResolver | undefined;

	constructor(
		private readonly logService: ILogService,
	) { }

	/**
	 * Marks a terminal as a Copilot CLI terminal.
	 */
	registerTerminal(terminal: Terminal): void {
		this._copilotTerminals.add(terminal);
	}

	/**
	 * Sets a terminal's session-state directory for relative path resolution.
	 */
	setSessionDir(terminal: Terminal, sessionDir: Uri): void {
		this._terminalSessionDirs.set(terminal, sessionDir);
	}

	/**
	 * Sets a resolver used when no session directory is cached.
	 */
	setSessionDirResolver(resolver: SessionDirResolver): void {
		this._sessionDirResolver = resolver;
	}

	async provideTerminalLinks(context: TerminalLinkContext, token: CancellationToken): Promise<CopilotCLITerminalLink[]> {
		const line = context.line;
		// Match VS Code's built-in MaxLineLength limit (terminalLocalLinkDetector.ts).
		if (!line.trim() || line.length > 2000) {
			return [];
		}

		const sessionDirs = await this._getSessionDirs(context.terminal);
		if (!this._copilotTerminals.has(context.terminal) && sessionDirs.length === 0) {
			return [];
		}
		const links: CopilotCLITerminalLink[] = [];
		const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);

		for (const match of line.matchAll(regex)) {
			// Match VS Code's built-in MaxResolvedLinksInLine (terminalLocalLinkDetector.ts).
			if (token.isCancellationRequested || links.length >= 10) {
				break;
			}

			let pathText = match.groups?.['path'];
			if (!pathText || pathText.length < 3) {
				continue;
			}

			// Strip trailing punctuation that is unlikely part of the path.
			// Mirrors VS Code's specialEndCharRegex (terminalLocalLinkDetector.ts).
			let trimmed = 0;
			while (pathText.length > 1 && /[\[\]"'.]$/.test(pathText)) {
				pathText = pathText.slice(0, -1);
				trimmed++;
			}

			// Skip URLs.
			if (pathText.includes('://')) {
				continue;
			}

			const lineNum = match.groups?.['line'] ?? match.groups?.['parenLine'];
			const colNum = match.groups?.['col'] ?? match.groups?.['parenCol'];

			// Tilde paths: expand ~ to home directory (~/... or ~\... on Windows).
			if (pathText.startsWith('~/') || pathText.startsWith('~\\')) {
				const absoluteUri = Uri.file(homedir() + pathText.substring(1));
				links.push({
					startIndex: match.index,
					length: match[0].length - trimmed,
					tooltip: absoluteUri.toString(true),
					uri: absoluteUri,
					terminal: context.terminal,
					pathText,
					line: lineNum ? parseInt(lineNum, 10) : undefined,
					col: colNum ? parseInt(colNum, 10) : undefined,
				});
				continue;
			}

			// Skip absolute paths; the built-in detector handles them.
			// Unix: /foo, Windows: C:\foo or \Users\foo
			if (pathText.startsWith('/') || pathText.startsWith('\\') || /^[a-zA-Z]:[/\\]/.test(pathText)) {
				continue;
			}

			const resolved = await this._resolvePath(pathText, sessionDirs);
			const fallbackUri = this._getFallbackUri(pathText, sessionDirs);
			if (!resolved && !fallbackUri) {
				continue;
			}

			links.push({
				startIndex: match.index,
				length: match[0].length - trimmed,
				tooltip: (resolved ?? fallbackUri)!.toString(true),
				uri: resolved,
				terminal: context.terminal,
				pathText,
				line: lineNum ? parseInt(lineNum, 10) : undefined,
				col: colNum ? parseInt(colNum, 10) : undefined,
			});
		}

		return links;
	}

	async handleTerminalLink(link: CopilotCLITerminalLink): Promise<void> {
		try {
			const sessionDirs = await this._getSessionDirs(link.terminal);
			const uriToOpen = link.uri
				?? await this._resolvePath(link.pathText, sessionDirs)
				?? this._getFallbackUri(link.pathText, sessionDirs);

			if (!uriToOpen) {
				return;
			}

			await window.showTextDocument(uriToOpen, {
				selection: link.line !== undefined
					? new Range(
						link.line - 1,
						(link.col ?? 1) - 1,
						link.line - 1,
						(link.col ?? 1) - 1
					)
					: undefined,
			});
		} catch (e) {
			this.logService.error('Failed to open terminal link', e);
		}
	}

	/**
	 * Returns candidate session directories for a terminal.
	 *
	 * Resolver results (from active sessions) are tried first because the
	 * resolver can order them by terminal affinity — sessions that belong to
	 * THIS terminal come before unrelated sessions. A cached dir from
	 * {@link setSessionDir} is appended only as a last-resort fallback when it
	 * is no longer among the active sessions (i.e. the session ended but its
	 * files may still be on disk). See https://github.com/microsoft/vscode/issues/301594.
	 */
	private async _getSessionDirs(terminal: Terminal): Promise<Uri[]> {
		const cached = this._terminalSessionDirs.get(terminal);

		if (this._sessionDirResolver) {
			const resolved = await this._sessionDirResolver(terminal);
			const cachedFsPath = cached?.fsPath;
			// Resolver results are already ordered by terminal affinity.
			const dirs = [...resolved];
			// If the cached dir is not among the active sessions it is stale
			// (the session ended). Append it as a fallback instead of
			// putting it first where it would shadow the current session.
			if (cached && !resolved.some(dir => dir.fsPath === cachedFsPath)) {
				dirs.push(cached);
			}
			return dirs;
		}

		return cached ? [cached] : [];
	}

	/**
	 * Resolves a relative path by trying:
	 * 1. Each session state directory (e.g., `~/.copilot/session-state/{uuid}/`)
	 * 2. Workspace folders as a fallback
	 */
	private async _resolvePath(pathText: string, sessionDirs: Uri[]): Promise<Uri | undefined> {
		// Try session-state directories first; CLI paths are relative to them.
		for (const sessionDir of sessionDirs) {
			const candidate = Uri.joinPath(sessionDir, pathText);
			try {
				await workspace.fs.stat(candidate);
				return candidate;
			} catch {
				// Not found in this session directory.
			}
		}

		// Fallback to workspace folders.
		const workspaceFolders = workspace.workspaceFolders;
		if (workspaceFolders) {
			for (const folder of workspaceFolders) {
				const candidate = Uri.joinPath(folder.uri, pathText);
				try {
					await workspace.fs.stat(candidate);
					return candidate;
				} catch {
					// Not found in this workspace folder.
				}
			}
		}

		return undefined;
	}

	private _getFallbackUri(pathText: string, sessionDirs: readonly Uri[]): Uri | undefined {
		const sessionDir = sessionDirs[0];
		if (sessionDir) {
			return Uri.joinPath(sessionDir, pathText);
		}

		const workspaceFolder = workspace.workspaceFolders?.[0];
		if (workspaceFolder) {
			return Uri.joinPath(workspaceFolder.uri, pathText);
		}

		return undefined;
	}
}
