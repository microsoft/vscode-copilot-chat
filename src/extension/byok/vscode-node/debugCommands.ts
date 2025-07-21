/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IBYOKStorageService } from './byokStorageService';

export class BYOKDebugCommands {
	constructor(
		@ILogService private readonly _logService: ILogService,
		private readonly _byokStorageService: IBYOKStorageService,
		private readonly _registeredModelDisposables: Map<string, vscode.Disposable>
	) { }

	registerDebugCommands(): vscode.Disposable[] {
		const disposables: vscode.Disposable[] = [];

		// Command to list all registered language models
		disposables.push(vscode.commands.registerCommand('github.copilot.chat.debug.listRegisteredModels', async () => {
			try {
				// Get all registered chat models from VS Code API
				const allModels = await vscode.lm.selectChatModels();

				const modelInfo = allModels.map(model => {
					// Try different ways to access isUserSelectable
					const metadata = (model as any).metadata || (model as any);
					const isUserSelectable = metadata.isUserSelectable ?? (model as any).isUserSelectable ?? 'not found';

					return {
						id: model.id,
						name: model.name,
						vendor: model.vendor,
						family: model.family,
						version: model.version,
						maxInputTokens: model.maxInputTokens,
						isUserSelectable: isUserSelectable
					};
				});

				this._logService.logger.info('=== All Registered Language Models ===');
				modelInfo.forEach(model => {
					this._logService.logger.info(`Model: ${model.id}`);
					this._logService.logger.info(`  Name: ${model.name}`);
					this._logService.logger.info(`  Vendor: ${model.vendor}`);
					this._logService.logger.info(`  Family: ${model.family}`);
					this._logService.logger.info(`  Version: ${model.version}`);
					this._logService.logger.info(`  Max Input Tokens: ${model.maxInputTokens}`);
					this._logService.logger.info(`  User Selectable: ${model.isUserSelectable}`);
					this._logService.logger.info('---');
				});

				// Show in VS Code output
				const output = vscode.window.createOutputChannel('Copilot Chat Debug');
				output.clear();
				output.appendLine('=== All Registered Language Models ===');
				modelInfo.forEach(model => {
					output.appendLine(`Model: ${model.id}`);
					output.appendLine(`  Name: ${model.name}`);
					output.appendLine(`  Vendor: ${model.vendor}`);
					output.appendLine(`  Family: ${model.family}`);
					output.appendLine(`  Version: ${model.version}`);
					output.appendLine(`  Max Input Tokens: ${model.maxInputTokens}`);
					output.appendLine(`  User Selectable: ${model.isUserSelectable}`);
					output.appendLine('---');
				});
				output.show();

				vscode.window.showInformationMessage(`Found ${modelInfo.length} registered language models. Check the output panel for details.`);
			} catch (error) {
				this._logService.logger.error('Error listing registered models:', error);
				vscode.window.showErrorMessage(`Error listing registered models: ${error}`);
			}
		}));

		// Command to list BYOK models specifically
		disposables.push(vscode.commands.registerCommand('github.copilot.chat.debug.listBYOKModels', async () => {
			try {
				this._logService.logger.info('=== BYOK Registered Models ===');
				this._logService.logger.info(`Total BYOK models tracked: ${this._registeredModelDisposables.size}`);

				const output = vscode.window.createOutputChannel('Copilot Chat Debug');
				output.clear();
				output.appendLine('=== BYOK Registered Models ===');
				output.appendLine(`Total BYOK models tracked: ${this._registeredModelDisposables.size}`);

				for (const [key] of this._registeredModelDisposables) {
					this._logService.logger.info(`BYOK Model Key: ${key}`);
					output.appendLine(`BYOK Model Key: ${key}`);
				}

				// Also show stored model configs
				const providers = ['SAPAICore', 'OpenAI', 'Anthropic', 'Azure', 'Gemini', 'Groq', 'Ollama', 'OpenRouter'];
				for (const provider of providers) {
					try {
						const modelConfigs = await this._byokStorageService.getStoredModelConfigs(provider);
						const modelIds = Object.keys(modelConfigs);
						if (modelIds.length > 0) {
							this._logService.logger.info(`${provider} stored models: ${modelIds.join(', ')}`);
							output.appendLine(`${provider} stored models: ${modelIds.join(', ')}`);
						}
					} catch (error) {
						// Provider might not have any models, ignore
					}
				}

				output.show();
				vscode.window.showInformationMessage(`BYOK models info displayed in output panel.`);
			} catch (error) {
				this._logService.logger.error('Error listing BYOK models:', error);
				vscode.window.showErrorMessage(`Error listing BYOK models: ${error}`);
			}
		}));

		return disposables;
	}
}
