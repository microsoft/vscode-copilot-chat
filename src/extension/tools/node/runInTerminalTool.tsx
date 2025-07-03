/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, TextChunk } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { IEnvService, OperatingSystem } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { ISimulationTestContext } from '../../../platform/simulationTestContext/common/simulationTestContext';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITerminalService, ShellIntegrationQuality } from '../../../platform/terminal/common/terminalService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { count, removeAnsiEscapeCodes } from '../../../util/vs/base/common/strings';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult, MarkdownString, PreparedTerminalToolInvocation } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { checkCancellation } from './toolUtils';
import { BasicIntegrationTerminalExecuteStrategy, CommandLineAutoApprover, extractInlineSubCommands, getRecommendedToolsOverRunInTerminal, isPowerShell, ITerminalExecuteStrategy, NoIntegrationTerminalExecuteStrategy, RichIntegrationTerminalExecuteStrategy, splitCommandLineIntoSubCommands, ToolTerminalCreator } from './toolUtils.terminal';

export interface IRunInTerminalParams {
	command: string;
	explanation: string;
	isBackground: boolean;
}


export class RunInTerminalTool extends Disposable implements ICopilotTool<IRunInTerminalParams> {
	public static readonly toolName = ToolName.RunInTerminal;
	private promptContext?: IBuildPromptContext;
	private static executions = new Map<string, BackgroundTerminalExecution>();
	protected readonly _commandLineAutoApprover: CommandLineAutoApprover;

	private alternativeRecommendation?: LanguageModelToolResult;
	private rewrittenCommand?: string;

	public static getBackgroundOutput(id: string): string {
		const bgExecution = RunInTerminalTool.executions.get(id);
		if (!bgExecution) {
			throw new Error('Invalid terminal ID');
		}

		return bgExecution.output;
	}

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEnvService private readonly envService: IEnvService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ISimulationTestContext private readonly simulationTestContext: ISimulationTestContext,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		super();

		this._commandLineAutoApprover = this.instantiationService.createInstance(CommandLineAutoApprover);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IRunInTerminalParams>, token: CancellationToken) {
		if (this.alternativeRecommendation) {
			return this.alternativeRecommendation;
		}

		this.logService.logger.debug(`RunInTerminalTool: Invoking with options ${JSON.stringify(options.input)}`);
		if (!options.toolInvocationToken && !this.simulationTestContext.isInSimulationTests) {
			throw new Error('toolInvocationToken is required for this tool');
		}

		const sessionId = options.chatSessionId ?? JSON.stringify(options.toolInvocationToken);

		const command = options.terminalCommand ?? this.rewrittenCommand ?? options.input.command;
		const didUserEditCommand = typeof options.terminalCommand === 'string' && options.terminalCommand !== options.input.command;
		const didToolEditCommand = !didUserEditCommand && this.rewrittenCommand !== undefined;

		checkCancellation(token);

		let error: string | undefined;

		const timingStart = Date.now();
		const termId = generateUuid();

		if (options.input.isBackground) {
			this.logService.logger.debug(`RunInTerminalTool: Creating background terminal with ID=${termId}`);
			const toolTerminal = await this.instantiationService.createInstance(ToolTerminalCreator).createTerminal(sessionId, termId, token, true);
			if (token.isCancellationRequested) {
				toolTerminal.terminal.dispose();
				throw new CancellationError();
			}

			toolTerminal.terminal.show(true);
			const timingConnectMs = Date.now() - timingStart;

			try {
				this.logService.logger.debug(`RunInTerminalTool: Starting background execution \`${command}\``);
				const execution = new BackgroundTerminalExecution(toolTerminal.terminal, command);
				RunInTerminalTool.executions.set(termId, execution);
				const resultText = (
					didUserEditCommand
						? `Note: The user manually edited the command to \`${command}\`, and that command is now running in terminal with ID=${termId}`
						: didToolEditCommand
							? `Note: The tool simplified the command to \`${command}\`, and that command is now running in terminal with ID=${termId}`
							: `Command is running in terminal with ID=${termId}`
				);
				return new LanguageModelToolResult([new LanguageModelTextPart(resultText)]);
			} catch (e) {
				error = 'threw';
				if (termId) {
					RunInTerminalTool.executions.delete(termId);
				}
				throw e;
			} finally {
				const timingExecuteMs = Date.now() - timingStart;
				this.sendTelemetry({
					didUserEditCommand,
					didToolEditCommand,
					shellIntegrationQuality: toolTerminal.shellIntegrationQuality,
					isBackground: true,
					error,
					outputLineCount: -1,
					exitCode: undefined,
					isNewSession: true,
					timingExecuteMs,
					timingConnectMs,
				});
			}
		} else {
			let toolTerminal = sessionId ? await this.terminalService.getToolTerminalForSession(sessionId) : undefined;
			const isNewSession = !toolTerminal;
			if (toolTerminal) {
				this.logService.logger.debug(`RunInTerminalTool: Using existing terminal with session ID \`${sessionId}\``);
			} else {
				this.logService.logger.debug(`RunInTerminalTool: Creating terminal with session ID \`${sessionId}\``);
				toolTerminal = await this.instantiationService.createInstance(ToolTerminalCreator).createTerminal(sessionId, termId, token);
				if (token.isCancellationRequested) {
					toolTerminal.terminal.dispose();
					throw new CancellationError();
				}
			}

			toolTerminal.terminal.show(true);

			const timingConnectMs = Date.now() - timingStart;

			let terminalResult = '';
			let outputLineCount = -1;
			let exitCode: number | undefined;
			try {
				let strategy: ITerminalExecuteStrategy;
				if (this.simulationTestContext.isInSimulationTests) {
					strategy = this.instantiationService.createInstance(RichIntegrationTerminalExecuteStrategy, toolTerminal.terminal, toolTerminal.terminal.shellIntegration!);
				} else {
					switch (toolTerminal.shellIntegrationQuality) {
						case ShellIntegrationQuality.None: {
							strategy = this.instantiationService.createInstance(NoIntegrationTerminalExecuteStrategy, toolTerminal.terminal);
							break;
						}
						case ShellIntegrationQuality.Basic: {
							strategy = this.instantiationService.createInstance(BasicIntegrationTerminalExecuteStrategy, toolTerminal.terminal, toolTerminal.terminal.shellIntegration!);
							break;
						}
						case ShellIntegrationQuality.Rich: {
							strategy = this.instantiationService.createInstance(RichIntegrationTerminalExecuteStrategy, toolTerminal.terminal, toolTerminal.terminal.shellIntegration!);
							break;
						}
					}
				}
				this.logService.logger.debug(`RunInTerminalTool: Using \`${strategy.type}\` execute strategy for command \`${command}\``);
				const executeResult = await strategy.execute(command, token);
				this.logService.logger.debug(`RunInTerminalTool: Finished \`${strategy.type}\` execute strategy with exitCode \`${executeResult.exitCode}\`, result.length \`${executeResult.result.length}\`, error \`${executeResult.error}\``);
				outputLineCount = count(executeResult.result, '\n');
				exitCode = executeResult.exitCode;
				error = executeResult.error;
				if (typeof executeResult.result === 'string') {
					terminalResult = executeResult.result;
				} else {
					return executeResult.result;
				}
			} catch (e) {
				this.logService.logger.debug(`RunInTerminalTool: Threw exception`);
				toolTerminal.terminal.dispose();
				error = 'threw';
				throw e;
			} finally {
				const timingExecuteMs = Date.now() - timingStart;
				this.sendTelemetry({
					didUserEditCommand,
					didToolEditCommand,
					isBackground: false,
					shellIntegrationQuality: toolTerminal.shellIntegrationQuality,
					error,
					isNewSession,
					outputLineCount,
					exitCode,
					timingExecuteMs,
					timingConnectMs,
				});
			}
			return new LanguageModelToolResult([
				new LanguageModelPromptTsxPart(
					await renderPromptElementJSON(this.instantiationService, RunInTerminalResult, {
						result: terminalResult,
						newCommand: command,
						newCommandReason: didUserEditCommand ? 'user' : didToolEditCommand ? 'tool' : undefined
					}, options.tokenizationOptions, token)
				)
			]);
		}
	}

	private sendTelemetry(state: {
		didUserEditCommand: boolean;
		didToolEditCommand: boolean;
		error: string | undefined;
		isBackground: boolean;
		isNewSession: boolean;
		shellIntegrationQuality: ShellIntegrationQuality;
		outputLineCount: number;
		timingConnectMs: number;
		timingExecuteMs: number;
		exitCode: number | undefined;
	}) {
		/* __GDPR__
			"toolUse.runInTerminal" : {
				"owner": "roblourens",
				"comment": "Understanding the usage of the runInTerminal tool",
				"result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the tool ran successfully, or the type of error" },
				"strategy": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "What strategy was used to execute the command (0=none, 1=basic, 2=rich)" },
				"userEditedCommand": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the user edited the command" },
				"toolEditedCommand": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the tool edited the command" },
				"isBackground": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the command is a background command" },
				"isNewSession": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": "Whether this was the first execution for the terminal session" },
				"outputLineCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": "How many lines of output were produced, this is -1 when isBackground is true or if there's an error" },
				"nonZeroExitCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": "Whether the command exited with a non-zero code (-1=error/unknown, 0=zero exit code, 1=non-zero)" },
				"timingConnectMs": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": "How long the terminal took to start up and connect to" },
				"timingExecuteMs": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": "How long the command took to execute" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('toolUse.runInTerminal', {
			result: state.error ?? 'success'
		}, {
			strategy: state.shellIntegrationQuality === ShellIntegrationQuality.Rich ? 2 : state.shellIntegrationQuality === ShellIntegrationQuality.Basic ? 1 : 0,
			userEditedCommand: state.didUserEditCommand ? 1 : 0,
			toolEditedCommand: state.didToolEditCommand ? 1 : 0,
			isBackground: state.isBackground ? 1 : 0,
			isNewSession: state.isNewSession ? 1 : 0,
			outputLineCount: state.outputLineCount,
			nonZeroExitCode: state.exitCode === undefined ? -1 : state.exitCode === 0 ? 0 : 1,
			timingConnectMs: state.timingConnectMs,
			timingExecuteMs: state.timingExecuteMs,
		});
	}

	resolveInput(input: IRunInTerminalParams, promptContext: IBuildPromptContext, mode: CopilotToolMode): Promise<IRunInTerminalParams> {
		this.promptContext = promptContext;
		return Promise.resolve(input);
	}

	async prepareInvocation2(options: vscode.LanguageModelToolInvocationPrepareOptions<IRunInTerminalParams>, token: vscode.CancellationToken): Promise<vscode.PreparedTerminalToolInvocation | null | undefined> {
		this.alternativeRecommendation = this.promptContext ? getRecommendedToolsOverRunInTerminal(options, this.promptContext) : undefined;
		const presentation = this.alternativeRecommendation ? 'hidden' : undefined;
		const shellId = this.envService.OS === OperatingSystem.Windows ? 'pwsh' : 'sh';

		let confirmationMessages: vscode.LanguageModelToolConfirmationMessages | undefined;
		if (this.alternativeRecommendation || this.simulationTestContext.isInSimulationTests) {
			confirmationMessages = undefined;
		} else {
			const subCommands = splitCommandLineIntoSubCommands(options.input.command, this.envService.shell);
			const inlineSubCommands = subCommands.map(e => Array.from(extractInlineSubCommands(e, this.envService.shell))).flat();
			const allSubCommands = [...subCommands, ...inlineSubCommands];
			if (allSubCommands.every(e => this._commandLineAutoApprover.isAutoApproved(e))) {
				confirmationMessages = undefined;
			} else {
				confirmationMessages = {
					title: options.input.isBackground ?
						l10n.t`Run command in background terminal` :
						l10n.t`Run command in terminal`,
					message: new MarkdownString(
						options.input.explanation
					),
				};
			}
		}

		this.rewrittenCommand = await this._rewriteCommandIfNeeded(options);

		return new PreparedTerminalToolInvocation(
			this.rewrittenCommand,
			shellId,
			confirmationMessages,
			presentation);
	}

	protected async _rewriteCommandIfNeeded(options: vscode.LanguageModelToolInvocationPrepareOptions<IRunInTerminalParams>): Promise<string> {
		const commandLine = options.input.command;

		// Re-write the command if it starts with `cd <dir> && <suffix>` or `cd <dir>; <suffix>`
		// to just `<suffix>` if the directory matches the current terminal's cwd. This simplifies
		// the result in the chat by removing redundancies that some models like to add.
		const isPwsh = isPowerShell(this.envService.shell);
		const cdPrefixMatch = commandLine.match(
			isPwsh
				? /^(?:cd|Set-Location(?: -Path)?) (?<dir>[^\s]+) ?(?:&&|;)\s+(?<suffix>.+)$/i
				: /^cd (?<dir>[^\s]+) &&\s+(?<suffix>.+)$/
		);
		const cdDir = cdPrefixMatch?.groups?.dir;
		const cdSuffix = cdPrefixMatch?.groups?.suffix;
		if (cdDir && cdSuffix) {
			// Get the current session terminal's cwd
			const sessionId = options.chatSessionId;
			let cwd: vscode.Uri | undefined;
			if (sessionId) {
				const terminal = await this.terminalService.getToolTerminalForSession(sessionId);
				if (terminal) {
					cwd = await this.terminalService.getCwdForSession(sessionId);
				}
			}

			// If a terminal is not available, use the workspace root
			if (!cwd) {
				const workspaceFolders = this.workspaceService.getWorkspaceFolders();
				if (workspaceFolders.length === 1) {
					cwd = workspaceFolders[0];
				}
			}

			// Re-write the command if it matches the cwd
			if (cwd) {
				let cdDirPath = cdDir;
				if (cdDirPath.startsWith('"') && cdDirPath.endsWith('"')) {
					cdDirPath = cdDirPath.slice(1, -1);
				}
				let cwdFsPath = cwd.fsPath;
				if (this.envService.OS === OperatingSystem.Windows) {
					cdDirPath = cdDirPath.toLowerCase();
					cwdFsPath = cwdFsPath.toLowerCase();
				}
				if (cdDirPath === cwdFsPath) {
					return cdSuffix;
				}
			}
		}

		return commandLine;
	}
}

ToolRegistry.registerTool(RunInTerminalTool);

interface IRunInTerminalResultProps extends BasePromptElementProps {
	result: string;
	newCommand?: string;
	newCommandReason?: 'user' | 'tool';
}

export class RunInTerminalResult extends PromptElement<IRunInTerminalResultProps> {
	render() {
		// todo@connor4312 `TextChunk breakOnWhitespace` is not very optimized, so
		// break by lines (for normal prioritization logic)
		return (
			<>
				{this.props.newCommand && (
					this.props.newCommandReason === 'user'
						? `Note: The user manually edited the command to \`${this.props.newCommand}\`, and this is the output of running that command instead:`
						: `Note: The tool simplified the command to \`${this.props.newCommand}\`, and this is the output of running that command instead:`
				)}
				{this.props.result.split('\n').map(line => <TextChunk>{line}</TextChunk>)}
			</>
		);
	}
}

interface IGetTerminalOutputParams {
	id: string;
}

export class GetTerminalOutputTool implements vscode.LanguageModelTool<IGetTerminalOutputParams> {
	public static readonly toolName = ToolName.GetTerminalOutput;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IGetTerminalOutputParams>, token: CancellationToken) {
		return new LanguageModelToolResult([
			new LanguageModelTextPart(`Output of terminal ${options.input.id}:\n${RunInTerminalTool.getBackgroundOutput(options.input.id)}`)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IGetTerminalOutputParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: l10n.t`Checking background terminal output`,
			pastTenseMessage: l10n.t`Checked background terminal output`
		};
	}
}

ToolRegistry.registerTool(GetTerminalOutputTool);

// Maximum output length to prevent context overflow
const MAX_OUTPUT_LENGTH = 60000; // ~60KB limit to keep context manageable
const TRUNCATION_MESSAGE = '\n\n[... MIDDLE OF OUTPUT TRUNCATED ...]\n\n';

export function sanitizeTerminalOutput(output: string): string {
	let sanitized = removeAnsiEscapeCodes(output)
		// Trim trailing \r\n characters
		.trimEnd();

	// Truncate if output is too long to prevent context overflow
	if (sanitized.length > MAX_OUTPUT_LENGTH) {
		const truncationMessageLength = TRUNCATION_MESSAGE.length;
		const availableLength = MAX_OUTPUT_LENGTH - truncationMessageLength;
		const startLength = Math.floor(availableLength * 0.4); // Keep 40% from start
		const endLength = availableLength - startLength; // Keep 60% from end

		const startPortion = sanitized.substring(0, startLength);
		const endPortion = sanitized.substring(sanitized.length - endLength);

		sanitized = startPortion + TRUNCATION_MESSAGE + endPortion;
	}

	return sanitized;
}

class BackgroundTerminalExecution {
	private _output: string = '';
	get output(): string {
		return sanitizeTerminalOutput(this._output);
	}

	constructor(
		public readonly terminal: vscode.Terminal,
		command: string
	) {
		const shellExecution = terminal.shellIntegration!.executeCommand(command);
		this.init(shellExecution);
	}

	private async init(shellExecution: vscode.TerminalShellExecution) {
		try {
			const stream = shellExecution.read();
			for await (const chunk of stream) {
				this._output += chunk;
			}
		} catch (e) {
			this._output += e instanceof Error ? e.message : String(e);
		}
	}
}
