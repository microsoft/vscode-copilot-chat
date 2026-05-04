/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolName } from '../../common/toolNames';
import { IToolResultCompressor, IToolResultFilter, IToolResultFilterOutput } from '../../common/toolResultCompressor';

/**
 * Input shape used by the core `run_in_terminal` tool. We only depend on the
 * `command` field; everything else is ignored.
 */
interface ITerminalInput {
	command?: string;
}

/**
 * Returns the "head" of a shell command — the first executable word, after
 * skipping common env-var assignments like `FOO=bar baz`. Returns `undefined`
 * when the command can't be parsed.
 */
export function parseCommandHead(command: string | undefined): { head: string; sub: string | undefined } | undefined {
	if (!command) {
		return undefined;
	}
	// Take only the first pipeline segment so `git diff | cat` still routes to git.
	const firstSegment = command.split(/[|;&]/)[0].trim();
	if (!firstSegment) {
		return undefined;
	}
	const tokens = firstSegment.split(/\s+/).filter(t => !/^[A-Z_][A-Z0-9_]*=/.test(t));
	const head = tokens[0];
	const sub = tokens[1];
	return head ? { head, sub } : undefined;
}

function isTerminalInput(input: unknown): input is ITerminalInput {
	return typeof input === 'object' && input !== null && 'command' in input;
}

/**
 * Compresses `git diff` / `git show` output by reducing context lines to a
 * tighter window and dropping the huge no-op chunks that diffs of generated
 * files (lockfiles, snapshots) produce.
 */
export const gitDiffFilter: IToolResultFilter = {
	id: 'terminal.git-diff',
	toolNames: [ToolName.CoreRunInTerminal],
	matches(_toolName, input) {
		if (!isTerminalInput(input)) {
			return false;
		}
		const parsed = parseCommandHead(input.command);
		return parsed?.head === 'git' && (parsed.sub === 'diff' || parsed.sub === 'show');
	},
	apply(text): IToolResultFilterOutput {
		const lines = text.split('\n');
		const out: string[] = [];
		let suppressed = 0;
		let inBinaryOrLock = false;
		let currentFileHeader: string | null = null;

		const flushSuppression = () => {
			if (suppressed > 0) {
				out.push(`... ${suppressed} unchanged context line${suppressed === 1 ? '' : 's'} omitted ...`);
				suppressed = 0;
			}
		};

		for (const line of lines) {
			if (line.startsWith('diff --git')) {
				flushSuppression();
				currentFileHeader = line;
				inBinaryOrLock = /package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.lockb?$|\.snap$/.test(line);
				if (inBinaryOrLock) {
					out.push(line);
					out.push('... lockfile/snapshot diff omitted ...');
					continue;
				}
				out.push(line);
				continue;
			}
			if (inBinaryOrLock) {
				continue;
			}
			// Drop noisy headers we don't need.
			if (line.startsWith('index ') || line.startsWith('similarity index ') ||
				line.startsWith('dissimilarity index ') || line.startsWith('rename from ') ||
				line.startsWith('rename to ')) {
				continue;
			}
			// Keep file-mode markers, hunk markers, +/- lines verbatim.
			if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@') ||
				line.startsWith('+') || line.startsWith('-') || line.startsWith('Binary files ')) {
				flushSuppression();
				out.push(line);
				continue;
			}
			// Unchanged context line — suppress past 1 line per side.
			// Cheap heuristic: just count consecutive context runs and collapse runs >2.
			suppressed++;
			if (suppressed <= 1) {
				out.push(line);
				suppressed = 0; // reset since we kept it
			}
		}
		flushSuppression();
		void currentFileHeader;

		const result = out.join('\n');
		return {
			text: result,
			compressed: result.length < text.length,
		};
	},
};

/**
 * Compresses `ls -l` / `ls -la` output by dropping permission/owner/size
 * columns and keeping only the entry name. Plain `ls` is already terse and
 * passes through.
 */
export const lsFilter: IToolResultFilter = {
	id: 'terminal.ls',
	toolNames: [ToolName.CoreRunInTerminal],
	matches(_toolName, input) {
		if (!isTerminalInput(input)) {
			return false;
		}
		const parsed = parseCommandHead(input.command);
		if (parsed?.head !== 'ls') {
			return false;
		}
		// Only worth running on long-form listings.
		return /\s-\w*l/.test(input.command ?? '');
	},
	apply(text): IToolResultFilterOutput {
		const lines = text.split('\n');
		const out: string[] = [];
		let dropped = 0;
		// `ls -l` line: perms links owner group size date1 date2 date3 name
		const longRe = /^[-dlcbpsDLCBPS][rwx\-tTsS@+.]{9,}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/;
		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			if (line.startsWith('total ')) {
				dropped++;
				continue;
			}
			const m = longRe.exec(line);
			if (m) {
				const isDir = line.startsWith('d');
				out.push(isDir ? m[1] + '/' : m[1]);
			} else {
				out.push(line);
			}
		}
		void dropped;
		const result = out.join('\n');
		return {
			text: result,
			compressed: result.length < text.length,
		};
	},
};

/**
 * Compresses `npm install` / `yarn` / `pnpm install` output by stripping
 * progress lines and audit summary noise, keeping the package summary plus
 * any error/warning lines.
 */
export const npmInstallFilter: IToolResultFilter = {
	id: 'terminal.npm-install',
	toolNames: [ToolName.CoreRunInTerminal],
	matches(_toolName, input) {
		if (!isTerminalInput(input)) {
			return false;
		}
		const parsed = parseCommandHead(input.command);
		if (!parsed) {
			return false;
		}
		if (parsed.head === 'npm' && (parsed.sub === 'install' || parsed.sub === 'i' || parsed.sub === 'ci')) {
			return true;
		}
		if ((parsed.head === 'yarn' || parsed.head === 'pnpm') && parsed.sub !== 'test') {
			return /\binstall\b|\badd\b/.test(input.command ?? '') || parsed.sub === undefined;
		}
		return false;
	},
	apply(text): IToolResultFilterOutput {
		const lines = text.split('\n');
		const dropPatterns: RegExp[] = [
			/^npm warn deprecated /i,
			/^\s*\[#+>?\s*\] /, // progress bars
			/^npm http /i,
			/^npm timing /i,
			/^npm sill /i,
			/^npm verb /i,
			/^\s*\d+ packages? are looking for funding/i,
			/run `npm fund`/i,
			/^Run `npm audit/i,
		];
		const out: string[] = [];
		for (const line of lines) {
			if (dropPatterns.some(re => re.test(line))) {
				continue;
			}
			out.push(line);
		}
		const result = out.join('\n');
		return {
			text: result,
			compressed: result.length < text.length,
		};
	},
};

export function registerTerminalCompressors(compressor: IToolResultCompressor): void {
	compressor.registerFilter(gitDiffFilter);
	compressor.registerFilter(lsFilter);
	compressor.registerFilter(npmInstallFilter);
}
