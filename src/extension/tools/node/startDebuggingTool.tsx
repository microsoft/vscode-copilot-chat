/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// StartDebuggingTool: Replaces the former /startdebugging slash command intent with a callable tool.
// The tool takes either a free-form query (describing what the user wants to debug)
// or a command line invocation (args + cwd) and returns launch.json/tasks.json guidance.
// It reuses the existing StartDebuggingPrompt so prompt engineering stays centralized.

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IExtensionsService } from '../../../platform/extensions/common/extensionsService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { parseLaunchConfigFromResponse } from '../../onboardDebug/node/parseLaunchConfigFromResponse';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { StartDebuggingInput, StartDebuggingPrompt, StartDebuggingType } from '../../prompts/node/panel/startDebugging';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IStartDebuggingToolParams {
	// User describes desired debugging scenario (mutually exclusive with commandLine)
	query?: string;
	// Concrete command line invocation we should derive config from
	commandLine?: {
		args: string[];
		cwd?: string; // absolute path (workspace root or subfolder)
	};
}

class StartDebuggingTool implements ICopilotTool<IStartDebuggingToolParams> {
	public static readonly toolName = ToolName.StartDebugging;

	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IExtensionsService private readonly extensionsService: IExtensionsService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IStartDebuggingToolParams>, token: vscode.CancellationToken) {
		const input: StartDebuggingInput = options.input.commandLine
			? { type: StartDebuggingType.CommandLine, args: options.input.commandLine.args, absoluteCwd: options.input.commandLine.cwd ?? '' }
			: { type: StartDebuggingType.UserQuery, userQuery: options.input.query };

		const fallbackModel = this._promptContext?.request?.model;
		const endpoint = await this.endpointProvider.getChatEndpoint(options.model ?? fallbackModel ?? 'gpt-4o-mini');
		const renderer = PromptRenderer.create(this.instantiationService, endpoint, StartDebuggingPrompt, {
			input,
			history: this._promptContext?.history ?? []
		});

		const prompt = await renderer.render(undefined, token);
		const fetchResult = await endpoint.makeChatRequest(
			'startDebuggingTool',
			prompt.messages,
			undefined,
			token,
			ChatLocation.Panel,
		);

		if (fetchResult.type !== ChatFetchResponseType.Success) {
			return new LanguageModelToolResult([new LanguageModelTextPart('Failed to generate launch configuration.')]);
		}

		// Normalize python debug type like intent did
		const response = fetchResult.value.replaceAll(/"type": "python",/g, '"type": "debugpy",');
		let augmented = response.trim();
		let hasTask = false;
		let parsedConfig: ReturnType<typeof parseLaunchConfigFromResponse> | undefined;
		try {
			parsedConfig = parseLaunchConfigFromResponse(augmented, this.extensionsService);
			hasTask = !!parsedConfig?.tasks?.length;
		} catch {
			// ignore parse errors – still show guidance
		}

		// --- Refactored: show a pending state without implying files are written yet ---
		let synthesizedJson = '';
		if (parsedConfig) {
			try {
				const launchJson = JSON.stringify({ version: '0.2.0', configurations: parsedConfig.configurations }, null, '\t');
				synthesizedJson = '```json\n' + launchJson + '\n```';
				if (parsedConfig.tasks?.length) {
					const tasksJson = JSON.stringify({ tasks: parsedConfig.tasks }, null, '\t');
					synthesizedJson += '\n\n```json\n' + tasksJson + '\n```';
				}
			} catch { /* ignore */ }
		}

		// Sanitize narrative to avoid past-tense implication of persistence.
		augmented = augmented
			.replace(/has been created/gi, 'is ready (not yet saved)')
			.replace(/has been set up/gi, 'is prepared (not yet saved)')
			.replace(/you can now start debugging/gi, 'you can start debugging after you save or run it');

		if (!this._promptContext?.stream) {
			const lines: string[] = [];
			lines.push(l10n.t('Proposed debug configuration (not yet saved):'));
			if (synthesizedJson) { lines.push(synthesizedJson); }
			lines.push('');
			lines.push(augmented.trim());
			lines.push('');
			lines.push(l10n.t('Choose an action:'));
			lines.push(`[${hasTask ? l10n.t('Save Task and Configuration') : l10n.t('Save Configuration')}](command:github.copilot.createLaunchJsonFileWithContents)`);
			lines.push(`[${hasTask ? l10n.t('Run Task and Start Debugging') : l10n.t('Start Debugging')}](command:github.copilot.startDebugging)`);
			return new LanguageModelToolResult([new LanguageModelTextPart(lines.join('\n'))]);
		}

		if (this._promptContext?.stream) {
			this._promptContext.stream.markdown(l10n.t('Review the below proposed debug configuration then choose an action:\n'));
			if (synthesizedJson) {
				this._promptContext.stream.markdown(synthesizedJson + '\n');
			}
			if (parsedConfig) {
				this._promptContext.stream.button({
					title: hasTask ? l10n.t('Save Task and Configuration') : l10n.t('Save Configuration'),
					command: 'github.copilot.createLaunchJsonFileWithContents',
					arguments: [parsedConfig]
				});
				this._promptContext.stream.button({
					title: hasTask ? l10n.t('Run Task and Start Debugging') : l10n.t('Start Debugging'),
					command: 'github.copilot.startDebugging',
					arguments: [parsedConfig]
				});
			}
			return new LanguageModelToolResult([]);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart('The following debug config has been offered to the user: ' + augmented)]);
	}

	async resolveInput(input: IStartDebuggingToolParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IStartDebuggingToolParams> {
		this._promptContext = promptContext;
		// If neither provided, treat prompt query text as tool query
		if (!input.query && !input.commandLine && promptContext.query) {
			return { query: promptContext.query };
		}
		return input;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IStartDebuggingToolParams>): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const summary = options.input.commandLine
			? `Deriving debug configuration from command: ${options.input.commandLine.args.join(' ')}`
			: `Generating debug configuration for query: ${options.input.query ?? '(project overview)'}`;
		return { invocationMessage: new MarkdownString(summary) };
	}
}

ToolRegistry.registerTool(StartDebuggingTool);

export { StartDebuggingTool };
