/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Copilot } from '../../../platform/inlineCompletions/vscode-node/api';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { autorun, IObservable } from '../../../util/vs/base/common/observableInternal';

const promptFileSelector = ['prompt', 'instructions', 'chatmode'];

export class PromptFileContextContribution extends Disposable {

	private readonly _enableCompletionContext: IObservable<boolean>;
	private registration: Promise<IDisposable> | undefined;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IExperimentationService experimentationService: IExperimentationService,
	) {
		super();
		this._enableCompletionContext = configurationService.getExperimentBasedConfigObservable(ConfigKey.Internal.PromptFileContext, experimentationService);
		this._register(autorun(reader => {
			if (this._enableCompletionContext.read(reader)) {
				this.registration = this.register();
			} else if (this.registration) {
				this.registration.then(disposable => disposable.dispose());
				this.registration = undefined;
			}
		}));

	}

	override dispose() {
		super.dispose();
		if (this.registration) {
			this.registration.then(disposable => disposable.dispose());
			this.registration = undefined;
		}
	}

	private async register(): Promise<IDisposable> {
		const disposables = new DisposableStore();
		try {
			const copilotAPI = await this.getCopilotApi();
			if (copilotAPI === undefined) {
				this.logService.logger.warn('Copilot API is undefined, unable to register context provider.');
				return disposables;
			}
			const self = this;
			const resolver: Copilot.ContextResolver<Copilot.SupportedContextItem> = {
				async *resolve(request: Copilot.ResolveRequest, token: vscode.CancellationToken): AsyncIterable<Copilot.SupportedContextItem> {
					console.log(`Resolve request ${Date.now()}`);
					const [document, position] = self.getDocumentAndPosition(request, token);
					if (document === undefined || position === undefined) {
						return;
					}
					const tokenBudget = self.getTokenBudget(document);
					if (tokenBudget <= 0) {
						return [];
					}
					const snippet = self.getSnippet(document.languageId);
					if (snippet === undefined) {
						return [snippet];
					}
					yield snippet;
				},
				resolveOnTimeout(request: Copilot.ResolveRequest): Copilot.SupportedContextItem | readonly Copilot.SupportedContextItem[] | undefined {
					console.log(`on timout ${Date.now()}`);
					return undefined;
				}
			};

			disposables.add(copilotAPI.registerContextProvider({
				id: 'promptfile-ai-context-provider',
				selector: promptFileSelector,
				resolver: resolver
			}));
		} catch (error) {
			this.logService.logger.error('Error regsistering prompt file context provider:', error);
		}
		return disposables;
	}

	private getSnippet(languageId: string): Copilot.CodeSnippet | undefined {
		switch (languageId) {
			case 'prompt':
				return {
					uri: 'file:///exampleProject/.github/prompts/newIssue.prompt.md',
					value: [
						`---`,
						`mode: 'agent'`,
						`description: This prompt is used to generate a new issue template for GitHub repositories.`,
						`model: GPT-4.1`,
						`tools: ['changes', 'codebase', 'editFiles', 'extensions', 'fetch', 'findTestFiles', 'githubRepo', 'new', 'openSimpleBrowser', 'problems', 'runCommands', 'runNotebooks', 'runTasks', 'runTests', 'search', 'searchResults', 'terminalLastCommand', 'terminalSelection', 'testFailure', 'usages', 'vscodeAPI']`,
						`---`,
						`Generate a new issue template for a GitHub repository.`,
					].join('\n'),
				};
			case 'instructions':
				return {
					uri: 'file:///exampleProject/.github/instructions/codeStyle.instructions.md',
					value: [
						`---`,
						`description: This file describes the TypeScript code style for the project.`,
						`applyTo: **/*.ts`,
						`---`,
						`For private fields, start the field name with an underscore (_).`,
					].join('\n'),
				};
			case 'mode':
				return {
					uri: 'file:///exampleProject/.github/chatmodes/planMode.chatmode.md',
					value: [
						`---`,
						`description: This mode is used to plan a new feature.`,
						`model: GPT-4.1`,
						`tools: ['changes', 'codebase','extensions', 'fetch', 'findTestFiles', 'githubRepo', 'openSimpleBrowser', 'problems', 'search', 'searchResults', 'terminalLastCommand', 'terminalSelection', 'testFailure', 'usages', 'vscodeAPI']`,
						`---`,
						`First come up with a plan for the new feature. Write a todo list of tasks to complete the feature.`,
					].join('\n'),
				};
			default:
				return undefined;
		}
	}


	private async getCopilotApi(): Promise<Copilot.ContextProviderApiV1 | undefined> {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		if (copilotExtension === undefined) {
			this.logService.logger.error('Copilot extension not found');
			return undefined;
		}
		try {
			const api = await copilotExtension.activate();
			return api.getContextProviderAPI('v1');
		} catch (error) {
			if (error instanceof Error) {
				this.logService.logger.error('Error activating Copilot extension:', error.message);
			} else {
				this.logService.logger.error('Error activating Copilot extension: Unknown error.');
			}
			return undefined;
		}
	}

	public getTokenBudget(document: vscode.TextDocument): number {
		return Math.trunc((8 * 1024) - (document.getText().length / 4) - 256);
	}

	private getDocumentAndPosition(request: Copilot.ResolveRequest, token?: vscode.CancellationToken): [vscode.TextDocument | undefined, vscode.Position | undefined] {
		let document: vscode.TextDocument | undefined;
		if (vscode.window.activeTextEditor?.document.uri.toString() === request.documentContext.uri) {
			document = vscode.window.activeTextEditor.document;
		} else {
			document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === request.documentContext.uri);
		}
		if (document === undefined) {
			return [undefined, undefined];
		}
		const requestPos = request.documentContext.position;
		const position = requestPos !== undefined ? new vscode.Position(requestPos.line, requestPos.character) : document.positionAt(request.documentContext.offset);
		if (document.version > request.documentContext.version) {
			if (!token?.isCancellationRequested) {
			}
			return [undefined, undefined];
		}
		if (document.version < request.documentContext.version) {
			return [undefined, undefined];
		}
		return [document, position];
	}



}