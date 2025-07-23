/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { PromptElement } from '@vscode/prompt-tsx';
import type { LanguageModelToolInvocationOptions, LanguageModelToolInvocationPrepareOptions, PreparedToolInvocation } from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITestProvider } from '../../../platform/testing/common/testProvider';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/path';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { TestFailureList, TestFailureListElementProps } from './testFailureTool';


export interface IRunTestToolsInput {
	files?: string[];
}

/** @deprecated moving to core soon */
export class RunTestsTool implements ICopilotTool<IRunTestToolsInput> {
	public static readonly toolName = ToolName.RunTests;

	constructor(
		@IRunCommandExecutionService private readonly runCommandExecutionService: IRunCommandExecutionService,
		@ITestProvider private readonly testProvider: ITestProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke({ input, tokenizationOptions }: LanguageModelToolInvocationOptions<IRunTestToolsInput>, token: CancellationToken): Promise<LanguageModelToolResult> {
		const prevResults = this.testProvider.lastResultsFrom;
		if (input.files?.length) {
			this.runCommandExecutionService.executeCommand(
				'testing.runCurrentFile',
				input.files.map(f => this.promptPathRepresentationService.resolveFilePath(f))
			);
		} else {
			this.runCommandExecutionService.executeCommand('testing.runAll');
		}

		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		const store = new DisposableStore();
		await new Promise<void>(resolve => {
			store.add(this.testProvider.onDidChangeResults(() => {
				if (this.testProvider.lastResultsFrom !== prevResults) {
					resolve();
				}
			}));
			store.add(token.onCancellationRequested(() => {
				resolve();
			}));
		}).finally(() => store.dispose());

		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		const json = await renderPromptElementJSON(this.instantiationService, TestResult, { failures: [...this.testProvider.getAllFailures()] }, tokenizationOptions);

		return new LanguageModelToolResult([
			new LanguageModelPromptTsxPart(json)
		]);
	}

	prepareInvocation?(options: LanguageModelToolInvocationPrepareOptions<IRunTestToolsInput>, token: CancellationToken): PreparedToolInvocation {
		const title = l10n.t`Allow test run?`;
		const inFiles = options.input.files?.map(f => '`' + basename(f) + '`');

		return {
			invocationMessage: l10n.t`Running tests...`,
			confirmationMessages: {
				title,
				message: inFiles?.length
					? new MarkdownString(l10n.t`The model wants to run tests in ${inFiles.join(', ')}.`)
					: l10n.t`The model wants to run all tests.`
			},
		};
	}
}

ToolRegistry.registerTool(RunTestsTool);

class TestResult extends PromptElement<TestFailureListElementProps> {
	render() {
		return <>
			<Tag name='testResult' attrs={{ passed: this.props.failures.length === 0 }}>
				<TestFailureList failures={this.props.failures} />
			</Tag>
		</>;
	}
}
