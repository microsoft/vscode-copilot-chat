/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Terminal as XtermTerminal } from '@xterm/headless';
import { basename as basenamePosix } from 'path/posix';
import { basename as basenameWin32 } from 'path/win32';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEnvService, OperatingSystem } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITerminalService, ShellIntegrationQuality } from '../../../platform/terminal/common/terminalService';
import { DeferredPromise, disposableTimeout, RunOnceScheduler, timeout } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { ThemeIcon } from '../../../util/vs/base/common/themables';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import type { IBuildPromptContext } from '../../prompt/common/intents';
import { sanitizeTerminalOutput } from './runInTerminalTool';
import { checkCancellation } from './toolUtils';

const enum ShellLaunchType {
	Unknown = 0,
	Default = 1,
	Fallback = 2,
}

export interface IToolTerminal {
	terminal: vscode.Terminal;
	shellIntegrationQuality: ShellIntegrationQuality;
}

export class ToolTerminalCreator {
	/**
	 * The shell preference cached for the lifetime of the window. This allows skipping previous
	 * shell approaches that failed in previous runs to save time.
	 */
	private static _lastSuccessfulShell: ShellLaunchType = ShellLaunchType.Unknown;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
	}

	async createTerminal(sessionId: string, id: string, token: vscode.CancellationToken, isBackground?: boolean): Promise<IToolTerminal> {
		const terminal = this._createCopilotTerminal();
		const toolTerminal: IToolTerminal = {
			terminal,
			shellIntegrationQuality: ShellIntegrationQuality.None,
		};

		// The default profile has shell integration
		if (ToolTerminalCreator._lastSuccessfulShell <= ShellLaunchType.Default) {
			const shellIntegrationQuality = await this.waitForShellIntegration(terminal, 5000);
			if (token.isCancellationRequested) {
				terminal.dispose();
				throw new CancellationError();
			}

			if (shellIntegrationQuality !== ShellIntegrationQuality.None) {
				ToolTerminalCreator._lastSuccessfulShell = ShellLaunchType.Default;
				toolTerminal.shellIntegrationQuality = shellIntegrationQuality;
				this.terminalService.associateTerminalWithSession(terminal, sessionId, id, shellIntegrationQuality, isBackground);
				return toolTerminal;
			}
		}
		this.terminalService.associateTerminalWithSession(terminal, sessionId, id, ShellIntegrationQuality.None, isBackground);
		// Fallback case: No shell integration in default profile
		ToolTerminalCreator._lastSuccessfulShell = ShellLaunchType.Fallback;
		return toolTerminal;
	}

	private _createCopilotTerminal(options?: vscode.TerminalOptions) {
		return this.terminalService.createTerminal({
			name: 'Copilot',
			iconPath: ThemeIcon.fromId('copilot'),
			hideFromUser: true,
			...options,
			env: {
				...options?.env,
				GIT_PAGER: 'cat', // avoid making `git diff` interactive when called from copilot
			},
		});
	}

	private waitForShellIntegration(
		terminal: vscode.Terminal,
		timeoutMs: number
	): Promise<ShellIntegrationQuality> {
		let shellIntegrationQuality: ShellIntegrationQuality = ShellIntegrationQuality.Basic;

		const dataFinished = new DeferredPromise<void>();
		const dataListener = this.terminalService.onDidWriteTerminalData((e) => {
			if (e.terminal === terminal) {
				if (e.data.match(oscRegex('633;P;HasRichCommandDetection=True'))) {
					shellIntegrationQuality = ShellIntegrationQuality.Rich;
					dataFinished.complete();
				}
			}
		});

		const deferred = new DeferredPromise<ShellIntegrationQuality>();
		const timer = disposableTimeout(() => deferred.complete(ShellIntegrationQuality.None), timeoutMs);

		if (terminal.shellIntegration) {
			timer.dispose();
			deferred.complete(shellIntegrationQuality);
		} else {
			const siListener = this.terminalService.onDidChangeTerminalShellIntegration((e) => {
				if (e.terminal === terminal && e.terminal.shellIntegration) {
					timer.dispose();
					if (shellIntegrationQuality === ShellIntegrationQuality.Rich) {
						deferred.complete(shellIntegrationQuality);
					} else {
						// While the rich command detection data should come in before
						// `onDidChangeTerminalShellIntegration` fires, the data write event is
						// debounced/buffered, so allow for up to 200ms for the data event to come
						// up.
						Promise.race([
							dataFinished.p,
							timeout(200)
						]).then(() => deferred.complete(shellIntegrationQuality));
					}
				}
			});

			deferred.p.finally(() => {
				siListener.dispose();
				dataListener.dispose();
			});
		}

		return deferred.p;
	}
}

export interface ITerminalExecuteStrategy {
	readonly type: 'rich' | 'basic' | 'none';
	/**
	 * Executes a command line and gets a result designed to be passed directly to an LLM. The
	 * result will include information about the exit code.
	 */
	execute(commandLine: string, token: CancellationToken): Promise<{ result: string; exitCode?: number; error?: string }>;
}

/**
 * This strategy is used when the terminal has rich shell integration/command detection is
 * available, meaning every sequence we rely upon should be exactly where we expect it to be. In
 * particular (`633;`) `A, B, E, C, D` all happen in exactly that order. While things still could go
 * wrong in this state, minimal verification is done in this mode since rich command detection is a
 * strong signal that it's behaving correctly.
 */
export class RichIntegrationTerminalExecuteStrategy implements ITerminalExecuteStrategy {
	readonly type = 'rich';

	constructor(
		private readonly _terminal: vscode.Terminal,
		private readonly _shellIntegration: vscode.TerminalShellIntegration,
		@ILogService private readonly _logService: ILogService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
	}

	async execute(commandLine: string, token: CancellationToken): Promise<{ result: string; exitCode?: number; error?: string }> {
		const store = new DisposableStore();
		try {
			const onDone = Promise.race([
				Event.toPromise(Event.filter(
					this._terminalService.onDidEndTerminalShellExecution as Event<vscode.TerminalShellExecutionEndEvent>,
					e => e.terminal === this._terminal,
					store
				), store).then(e => {
					this._logService.logger.debug('RunInTerminalTool#Rich: onDone via end event');
					return e;
				}),
				Event.toPromise(token.onCancellationRequested as Event<undefined>, store).then(() => {
					this._logService.logger.debug('RunInTerminalTool#Rich: onDone via cancellation');
				}),
				trackIdleOnPrompt(this._terminal, this._terminalService, 1000, store).then(() => {
					this._logService.logger.debug('RunInTerminalTool#Rich: onDone via idle prompt');
				}),
			]);

			this._logService.logger.debug(`RunInTerminalTool#Rich: Executing command line \`${commandLine}\``);
			const execution = this._shellIntegration.executeCommand(commandLine);

			this._logService.logger.debug(`RunInTerminalTool#Rich: Reading data stream`);
			const dataStream = execution.read();
			let result = '';

			// HACK: Read the data stream in a separate async function to avoid the off chance the
			// data stream doesn't resolve which can block the tool from ever finishing.
			enum DataStreamState {
				Reading,
				Timeout,
				Done,
			}
			let dataStreamState = DataStreamState.Reading as DataStreamState;
			const dataStreamDone = new DeferredPromise<void>();
			(async () => {
				for await (const chunk of dataStream) {
					checkCancellation(token);
					if (dataStreamState === DataStreamState.Timeout) {
						return;
					}
					result += chunk;
				}
				this._logService.logger.debug('RunInTerminalTool#Rich: Data stream flushed');
				dataStreamState = DataStreamState.Done;
				dataStreamDone.complete();
			})();

			this._logService.logger.debug(`RunInTerminalTool#Rich: Waiting for done event`);
			const doneData = await onDone;
			checkCancellation(token);

			// Give a little time for the data stream to flush before abandoning it
			if (dataStreamState !== DataStreamState.Done) {
				await Promise.race([
					dataStreamDone.p,
					timeout(500),
				]);
				checkCancellation(token);
				if (dataStreamState === DataStreamState.Reading) {
					dataStreamState = DataStreamState.Timeout;
					this._logService.logger.debug('RunInTerminalTool#Rich: Data stream timed out');
				}
			}

			result = sanitizeTerminalOutput(result);
			if (!result.trim()) {
				result = 'Command produced no output';
			}
			if (doneData && typeof doneData.exitCode === 'number' && doneData.exitCode > 0) {
				result += `\n\nCommand exited with code ${doneData.exitCode}`;
			}

			return {
				result,
				exitCode: doneData?.exitCode,
			};
		} finally {
			store.dispose();
		}
	}
}

/**
 * This strategy is used when shell integration is enabled, but rich command detection was not
 * declared by the shell script. This is the large spectrum between rich command detection and no
 * shell integration, here are some problems that are expected:
 *
 * - `133;C` command executed may not happen.
 * - `633;E` comamnd line reporting will likely not happen, so the command line contained in the
 *   execution start and end events will be of low confidence and chances are it will be wrong.
 * - Execution tracking may be incorrect, particularly when `executeCommand` calls are overlapped,
 *   such as Python activating the environment at the same time as Copilot executing a command. So
 *   the end event for the execution may actually correspond to a different command.
 *
 * This strategy focuses on trying to get the most accurate output given these limitations and
 * unknowns. Basically we cannot fully trust the extension APIs in this case, so polling of the data
 * stream is used to detect idling, and we listen to the terminal's data stream instead of the
 * execution's data stream.
 *
 * This is best effort with the goal being the output is accurate, though it may contain some
 * content above and below the command output, such as prompts or even possibly other command
 * output. We lean on the LLM to be able to differentiate the actual output from prompts and bad
 * output when it's not ideal.
 */
export class BasicIntegrationTerminalExecuteStrategy implements ITerminalExecuteStrategy {
	readonly type = 'basic';

	constructor(
		private readonly _terminal: vscode.Terminal,
		private readonly _shellIntegration: vscode.TerminalShellIntegration,
		@ILogService private readonly _logService: ILogService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
	}

	async execute(commandLine: string, token: CancellationToken): Promise<{ result: string; exitCode?: number; error?: string }> {
		const store = new DisposableStore();
		try {
			const idlePromptPromise = trackIdleOnPrompt(this._terminal, this._terminalService, 1000, store);
			const onDone = Promise.race([
				Event.toPromise(Event.filter(
					this._terminalService.onDidEndTerminalShellExecution as Event<vscode.TerminalShellExecutionEndEvent>,
					e => e.terminal === this._terminal,
					store
				), store).then(e => {
					// When shell integration is basic, it means that the end execution event is
					// often misfired since we don't have command line verification. Because of this
					// we make sure the prompt is idle after the end execution event happens.
					this._logService.logger.debug('RunInTerminalTool#Basic: onDone 1 of 2 via end event, waiting for short idle prompt');
					return idlePromptPromise.then(() => {
						this._logService.logger.debug('RunInTerminalTool#Basic: onDone 2 of 2 via short idle prompt');
						return e;
					});
				}),
				Event.toPromise(token.onCancellationRequested as Event<undefined>, store).then(() => {
					this._logService.logger.debug('RunInTerminalTool#Basic: onDone via cancellation');
				}),
				// A longer idle prompt event is used here as a catch all for unexpected cases where
				// the end event doesn't fire for some reason.
				trackIdleOnPrompt(this._terminal, this._terminalService, 3000, store).then(() => {
					this._logService.logger.debug('RunInTerminalTool#Basic: onDone long idle prompt');
				}),
			]);

			const xterm = store.add(new XtermTerminal({ allowProposedApi: true }));
			const onData = createTerminalDataWriteEvent(this._terminal, this._terminalService, store);
			store.add(onData(e => xterm.write(e)));

			// Wait for the terminal to idle before executing the command
			this._logService.logger.debug('RunInTerminalTool#Basic: Waiting for idle');
			await waitForIdle(onData, 1000);

			// The TerminalShellExecution.read is only reliable when rich command detection
			// is available
			this._logService.logger.debug(`RunInTerminalTool#Basic: Executing command line \`${commandLine}\``);
			this._shellIntegration.executeCommand(commandLine);

			// Wait for the next end execution event - note that this may not correspond to the actual
			// execution requested
			const doneData = await onDone;

			// Wait for the terminal to idle
			this._logService.logger.debug('RunInTerminalTool#Basic: Waiting for idle');
			await waitForIdle(onData, 1000);

			// Assemble final result
			let result = getSanitizedXtermOutput(xterm);
			if (doneData && typeof doneData.exitCode === 'number' && doneData.exitCode > 0) {
				result += `\n\nCommand exited with code ${doneData.exitCode}`;
			}
			return {
				result,
				exitCode: doneData?.exitCode,
			};
		} finally {
			store.dispose();
		}
	}
}

/**
 * This strategy is used when no shell integration is available. There are very few extension APIs
 * available in this case. This uses similar strategies to the basic integration strategy, but
 * with `sendText` instead of `shellIntegration.executeCommand` and relying on idle events instead
 * of execution events.
 */
export class NoIntegrationTerminalExecuteStrategy implements ITerminalExecuteStrategy {
	readonly type = 'none';

	constructor(
		private readonly _terminal: vscode.Terminal,
		@ILogService private readonly _logService: ILogService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
	}

	async execute(commandLine: string, token: CancellationToken): Promise<{ result: string; exitCode?: number; error?: string }> {
		const store = new DisposableStore();
		try {
			const xterm = store.add(new XtermTerminal({ allowProposedApi: true }));
			const onData = createTerminalDataWriteEvent(this._terminal, this._terminalService, store);
			store.add(onData(e => xterm.write(e)));

			// Wait for the terminal to idle before executing the command
			this._logService.logger.debug('RunInTerminalTool#None: Waiting for idle');
			await waitForIdle(onData, 1000);

			// Execute the command
			this._logService.logger.debug(`RunInTerminalTool#None: Executing command line \`${commandLine}\``);
			this._terminal.sendText(commandLine);

			// Assume the command is done when it's idle
			this._logService.logger.debug('RunInTerminalTool#None: Waiting for idle');
			await waitForIdle(onData, 1000);

			// Assemble final result - exit code is not available without shell integration
			const result = getSanitizedXtermOutput(xterm);
			return {
				result,
				exitCode: undefined,
			};
		} finally {
			store.dispose();
		}
	}
}

function createTerminalDataWriteEvent(
	terminal: vscode.Terminal,
	terminalService: ITerminalService,
	store: DisposableStore,
): Event<string> {
	return Event.map(
		Event.filter(
			terminalService.onDidWriteTerminalData as Event<vscode.TerminalDataWriteEvent>,
			e => e.terminal === terminal,
			store
		),
		e => e.data,
		store
	);
}

async function waitForIdle(onData: Event<unknown>, idleDurationMs: number): Promise<void> {
	// This is basically Event.debounce but with an initial event to trigger the debounce
	// immediately
	const store = new DisposableStore();
	const deferred = new DeferredPromise<void>();
	const scheduler = store.add(new RunOnceScheduler(() => deferred.complete(), idleDurationMs));
	store.add(onData(() => scheduler.schedule()));
	scheduler.schedule();
	return deferred.p.finally(() => store.dispose());
}

/**
 * Tracks the terminal for being idle on a prompt input. This must be called before `executeCommand`
 * is called.
 */
async function trackIdleOnPrompt(
	terminal: vscode.Terminal,
	terminalService: ITerminalService,
	idleDurationMs: number,
	store: DisposableStore,
): Promise<void> {
	const idleOnPrompt = new DeferredPromise<void>();
	const onData = createTerminalDataWriteEvent(terminal, terminalService, store);
	const scheduler = store.add(new RunOnceScheduler(() => {
		idleOnPrompt.complete();
	}, idleDurationMs));
	// Only schedule when a prompt sequence (A) is seen after an execute sequence (C). This prevents
	// cases where the command is executed before the prompt is written. While not perfect, sitting
	// on an A without a C following shortly after is a very good indicator that the command is done
	// and the terminal is idle. Note that D is treated as a signal for executed since shell
	// integration sometimes lacks the C sequence either due to limitations in the integation or the
	// required hooks aren't available.
	const enum TerminalState {
		Initial,
		Prompt,
		Executing,
		PromptAfterExecuting,
	}
	let state: TerminalState = TerminalState.Initial;
	store.add(onData(e => {
		// Update state
		// p10k fires C as `133;C;`
		const matches = e.matchAll(/(?:\x1b\]|\x9d)[16]33;(?<type>[ACD])(?:;.*)?(?:\x1b\\|\x07|\x9c)/g);
		for (const match of matches) {
			if (match.groups?.type === 'A') {
				if (state === TerminalState.Initial) {
					state = TerminalState.Prompt;
				} else if (state === TerminalState.Executing) {
					state = TerminalState.PromptAfterExecuting;
				}
			} else if (match.groups?.type === 'C' || match.groups?.type === 'D') {
				state = TerminalState.Executing;
			}
		}
		// Re-schedule on every data event as we're tracking data idle
		if (state === TerminalState.PromptAfterExecuting) {
			scheduler.schedule();
		} else {
			scheduler.cancel();
		}
	}));
	return idleOnPrompt.p;
}

function getSanitizedXtermOutput(xterm: XtermTerminal): string {
	// Assemble the output from the xterm buffer
	const outputLines: string[] = [];
	const buffer = xterm.buffer.active;
	for (let i = 0; i < xterm.buffer.active.length; i++) {
		outputLines.push(buffer.getLine(i)?.translateToString(true) ?? '');
	}

	// Clean output by removing empty lines at the end. The main case this covers is when the
	// buffer's content didn't get filled.
	for (let i = outputLines.length - 1; i >= 0; i--) {
		if (outputLines[i].length > 0) {
			break;
		}
		outputLines.pop();
	}

	// Clean output by removing empty lines at the start. The main case this covers is conpty
	// repositioning the cursor due to PSReadLine, causing many empty lines at the start of the
	// terminal for any commands after the first one.
	while (outputLines.length > 0) {
		if (outputLines[0].length > 0) {
			break;
		}
		outputLines.shift();
	}

	return outputLines.join('\n');
}

/**
 * Gets a regex that matches an OSC sequence with the given params.
 * @param params The body of the OSC sequence, such as `633;A`. This is passed in to the RegExp
 * constructor so it should follow those escape rules and you can match on things like `[16]33;A`.
 */
function oscRegex(params: string): RegExp {
	// This includes all the possible OSC encodings. The most common prefix is `\x1b]` and the most
	// command suffixes are `\x07` and `\x1b\\`.
	return new RegExp(`(?:\x1b\\]|\x9d)${params}(?:\x1b\\\\|\x07|\x9c)`);
}

const terminalCommands: { commands: RegExp[]; tags: string[] }[] = [
	{
		commands: [
			new RegExp(/^python3? -m pip install(\b)/),
			new RegExp(/^pip3? install(\b)/),
		],
		tags: ['python environment'],
	},
	{
		commands: [
			new RegExp(/^python3? -m jupyter(\b)/),
			new RegExp(/^python3? -m pip install\b.*jupyter\b.*/),
			new RegExp(/^pip3? install\b.*jupyter\b.*/),
			new RegExp(/^jupyter(\b)/), // jupyter lab, jupyer notebook, jupyter nbconvert, etc.
		],
		tags: ['python environment', 'jupyter environment'],
	}
];

let previouslyRecommededInSession = false;

export function getRecommendedToolsOverRunInTerminal(options: vscode.LanguageModelToolInvocationPrepareOptions<{ command: string }>, promptContext: IBuildPromptContext): vscode.LanguageModelToolResult | undefined {
	if (!promptContext.tools || previouslyRecommededInSession) {
		return;
	}

	const command = options.input.command;
	const recommendedTools = new Set<string>();
	const messages: string[] = [
		`The terminal command '${options.input.command}' was not executed.`,
		`Try using some of the following tools instead of running a Terminal Command (if unable to use one of these tools as an alternative then run the same terminal command again):`,
	];
	for (const terminalCommand of terminalCommands) {
		if (!terminalCommand.commands.some((condition) => condition.test(command))) {
			continue;
		}
		const tagsToSearchFor = terminalCommand.tags;
		promptContext.tools.availableTools
			.filter(t => tagsToSearchFor.some(tag => t.tags.includes(tag)))
			.forEach(tool => {
				recommendedTools.add(tool.name);
			});

	}
	recommendedTools.forEach(toolName => {
		messages.push(`- ${toolName}`);
	});

	if (recommendedTools.size) {
		previouslyRecommededInSession = true;
		return new LanguageModelToolResult([new LanguageModelTextPart(messages.join('  \n'))]);
	}
}

export class CommandLineAutoApprover extends Disposable {
	private _denyListRegexes: RegExp[] = [];
	private _allowListRegexes: RegExp[] = [];

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvService private readonly envService: IEnvService
	) {
		super();
		this.updateConfiguration();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.TerminalDenyList.fullyQualifiedId) || e.affectsConfiguration(ConfigKey.TerminalAllowList.fullyQualifiedId)) {
				this.updateConfiguration();
			}
		}));
	}

	updateConfiguration() {
		this._denyListRegexes = this.mapAutoApproveConfigToRegexList(this.configurationService.getConfig(ConfigKey.TerminalDenyList));
		this._allowListRegexes = this.mapAutoApproveConfigToRegexList(this.configurationService.getConfig(ConfigKey.TerminalAllowList));
	}

	isAutoApproved(command: string): boolean {
		// Check the deny list to see if this command requires explicit approval
		for (const regex of this._denyListRegexes) {
			if (this.commandMatchesRegex(regex, command)) {
				return false;
			}
		}

		// Check the allow list to see if the command is allowed to run without explicit approval
		for (const regex of this._allowListRegexes) {
			if (this.commandMatchesRegex(regex, command)) {
				return true;
			}
		}

		// TODO: LLM-based auto-approval

		// Fallback is always to require approval
		return false;
	}

	private commandMatchesRegex(regex: RegExp, command: string): boolean {
		if (regex.test(command)) {
			return true;
		} else if (isPowerShell(this.envService.shell, this.envService.OS) && command.startsWith('(')) {
			// Allow ignoring of the leading ( for PowerShell commands as it's a command pattern to
			// operate on the output of a command. For example `(Get-Content README.md) ...`
			if (regex.test(command.slice(1))) {
				return true;
			}
		}
		return false;
	}

	private mapAutoApproveConfigToRegexList(config: unknown): RegExp[] {
		if (!config || typeof config !== 'object') {
			return [];
		}
		return Object.entries(config)
			.map(([key, value]) => value ? this.convertAutoApproveEntryToRegex(key) : undefined)
			.filter(e => !!e);
	}

	private convertAutoApproveEntryToRegex(value: string): RegExp {
		// If it's wrapped in `/`, it's in regex format and should be converted directly
		if (value.match(/^\/.+\/$/)) {
			return new RegExp(value.slice(1, -1));
		}

		// Escape regex special characters
		const sanitizedValue = value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

		// Regular strings should match the start of the command line and be a word boundary
		return new RegExp(`^${sanitizedValue}\\b`);
	}
}

// Derived from https://github.com/microsoft/vscode/blob/315b0949786b3807f05cb6acd13bf0029690a052/extensions/terminal-suggest/src/tokens.ts#L14-L18
// Some of these can match the same string, so the order matters. Always put the more specific one
// first (eg. >> before >)
const shellTypeResetChars = new Map<'sh' | 'zsh' | 'pwsh', string[]>([
	['sh', ['&>>', '2>>', '>>', '2>', '&>', '||', '&&', '|&', '<<', '&', ';', '{', '>', '<', '|']],
	['zsh', ['<<<', '2>>', '&>>', '>>', '2>', '&>', '<(', '<>', '||', '&&', '|&', '&', ';', '{', '<<', '<(', '>', '<', '|']],
	['pwsh', ['*>>', '2>>', '>>', '2>', '&&', '*>', '>', '<', '|', ';', '!', '&']],
]);

export function splitCommandLineIntoSubCommands(commandLine: string, envShell: string, envOS: OperatingSystem): string[] {
	let shellType: 'sh' | 'zsh' | 'pwsh';
	const envShellWithoutExe = envShell.replace(/\.exe$/, '');
	if (isPowerShell(envShell, envOS)) {
		shellType = 'pwsh';
	} else {
		switch (envShellWithoutExe) {
			case 'zsh': shellType = 'zsh'; break;
			default: shellType = 'sh'; break;
		}
	}
	const subCommands = [commandLine];
	const resetChars = shellTypeResetChars.get(shellType);
	if (resetChars) {
		for (const chars of resetChars) {
			for (let i = 0; i < subCommands.length; i++) {
				const subCommand = subCommands[i];
				if (subCommand.includes(chars)) {
					subCommands.splice(i, 1, ...subCommand.split(chars).map(e => e.trim()));
					i--;
				}
			}
		}
	}
	return subCommands;
}

export function extractInlineSubCommands(commandLine: string, envShell: string, envOS: OperatingSystem): Set<string> {
	const inlineCommands: string[] = [];
	const shellType = isPowerShell(envShell, envOS) ? 'pwsh' : 'sh';

	/**
	 * Extract command substitutions that start with a specific prefix and are enclosed in parentheses
	 * Handles nested parentheses correctly
	 */
	function extractWithPrefix(text: string, prefix: string): string[] {
		const results: string[] = [];
		let i = 0;

		while (i < text.length) {
			const startIndex = text.indexOf(prefix, i);
			if (startIndex === -1) {
				break;
			}

			const contentStart = startIndex + prefix.length;
			if (contentStart >= text.length || text[contentStart] !== '(') {
				i = startIndex + 1;
				continue;
			}

			// Find the matching closing parenthesis, handling nested parentheses
			let parenCount = 1;
			let j = contentStart + 1;

			while (j < text.length && parenCount > 0) {
				if (text[j] === '(') {
					parenCount++;
				} else if (text[j] === ')') {
					parenCount--;
				}
				j++;
			}

			if (parenCount === 0) {
				// Found matching closing parenthesis
				const innerCommand = text.substring(contentStart + 1, j - 1).trim();
				if (innerCommand) {
					results.push(innerCommand);
					// Recursively extract nested inline commands
					results.push(...extractInlineSubCommands(innerCommand, envShell, envOS));
				}
			}

			i = startIndex + 1;
		}

		return results;
	}

	/**
	 * Extract backtick command substitutions (legacy POSIX)
	 */
	function extractBackticks(text: string): string[] {
		const results: string[] = [];
		let i = 0;

		while (i < text.length) {
			const startIndex = text.indexOf('`', i);
			if (startIndex === -1) {
				break;
			}

			const endIndex = text.indexOf('`', startIndex + 1);
			if (endIndex === -1) {
				break;
			}

			const innerCommand = text.substring(startIndex + 1, endIndex).trim();
			if (innerCommand) {
				results.push(innerCommand);
				// Recursively extract nested inline commands
				results.push(...extractInlineSubCommands(innerCommand, envShell, envOS));
			}

			i = endIndex + 1;
		}

		return results;
	}

	if (shellType === 'pwsh') {
		// PowerShell command substitution patterns
		inlineCommands.push(...extractWithPrefix(commandLine, '$'));  // $(command)
		inlineCommands.push(...extractWithPrefix(commandLine, '@'));  // @(command)
		inlineCommands.push(...extractWithPrefix(commandLine, '&'));  // &(command)
	} else {
		// POSIX shell (bash, zsh, sh) command substitution patterns
		inlineCommands.push(...extractWithPrefix(commandLine, '$'));  // $(command)
		inlineCommands.push(...extractWithPrefix(commandLine, '<'));  // <(command) - process substitution
		inlineCommands.push(...extractWithPrefix(commandLine, '>'));  // >(command) - process substitution
		inlineCommands.push(...extractBackticks(commandLine));        // `command`
	}

	return new Set(inlineCommands);
}

export function isPowerShell(envShell: string, os: OperatingSystem): boolean {
	if (os === OperatingSystem.Windows) {
		return /^(?:powershell|pwsh)(?:-preview)?$/i.test(basenameWin32(envShell).replace(/\.exe$/i, ''));

	}
	return /^(?:powershell|pwsh)(?:-preview)?$/.test(basenamePosix(envShell));
}