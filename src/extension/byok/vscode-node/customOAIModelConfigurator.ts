/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InputBoxOptions, LanguageModelChatInformation, QuickInputButtons, QuickPickItem, window } from 'vscode';
import { Config, ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { BYOKModelProvider } from '../common/byokProvider';

interface ModelConfig {
	name: string;
	url: string;
	toolCalling: boolean;
	vision: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
	requiresAPIKey?: boolean;
	thinking?: boolean;
}

interface ModelQuickPickItem extends QuickPickItem {
	modelId?: string;
	action?: 'add' | 'edit' | 'delete';
}

type BackButtonClick = { back: true };

function isBackButtonClick(value: unknown): value is BackButtonClick {
	return typeof value === 'object' && (value as BackButtonClick)?.back === true;
}

export class CustomOAIModelConfigurator {
	private readonly _configKey: Config<Record<string, ModelConfig>> = ConfigKey.CustomOAIModels;
	private readonly _forceRequiresAPIKey: boolean = false;
	constructor(
		private readonly _configurationService: IConfigurationService,
		private readonly _vendor: string,
		private readonly _provider: BYOKModelProvider<LanguageModelChatInformation>

	) {
		if (_vendor === 'azure') {
			this._forceRequiresAPIKey = true;
			this._configKey = ConfigKey.AzureModels;
		}
	}

	async configureModelOrUpdateAPIKey(): Promise<void> {
		interface BYOKQuickPickItem {
			label: string;
			detail: string;
			action: 'apiKey' | 'configureModels';
		}

		const options: BYOKQuickPickItem[] = [
			{
				label: '$(key) Manage API Key',
				detail: 'Update or configure the API key for this provider',
				action: 'apiKey'
			},
			{
				label: '$(settings-gear) Configure Models',
				detail: 'Add, edit, or remove model configurations',
				action: 'configureModels'
			}
		];

		const quickPick = window.createQuickPick<BYOKQuickPickItem>();
		quickPick.title = `Manage ${this._vendor === 'azure' ? 'Azure' : 'Custom OpenAI'} Provider`;
		quickPick.placeholder = 'Choose an action';
		quickPick.items = options;
		quickPick.ignoreFocusOut = true;

		const selected = await new Promise<BYOKQuickPickItem | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				const selectedItem = quickPick.selectedItems[0];
				resolve(selectedItem);
				quickPick.hide();
			});

			quickPick.onDidHide(() => {
				resolve(undefined);
			});

			quickPick.show();
		});
		if (selected?.action === 'apiKey') {
			return this._provider.updateAPIKey();
		} else if (selected?.action === 'configureModels') {
			return this.configure(false);
		}
	}

	/**
	 * Main entry point for configuring Custom OAI models
	 */
	async configure(isProvideLMInfoCall: boolean): Promise<void> {

		while (true) {
			const models = this._configurationService.getConfig(this._configKey);


			const items: ModelQuickPickItem[] = [];

			// Add existing models
			for (const [modelId, config] of Object.entries(models)) {
				items.push({
					label: config.name,
					description: modelId,
					detail: `$(arrow-up) ${config.maxInputTokens} $(arrow-down) ${config.maxOutputTokens}${config.toolCalling ? ' • Tools' : ''}${config.vision ? ' • Vision' : ''}${config.thinking ? ' • Thinking' : ''}`,
					modelId,
					action: 'edit'
				});
			}

			if (items.length === 0 && isProvideLMInfoCall) {
				const newModel = await this._configureModel();
				if (newModel) {
					const updatedModels = { ...models, [newModel.id]: newModel.config };
					await this._configurationService.setConfig(this._configKey, updatedModels);
				}
				return;
			}

			// Add separator and actions
			if (items.length > 0) {
				items.push({ label: '', kind: -1 } as any);
			}

			items.push({
				label: `$(add) Add New Model`,
				detail: 'Create a new Custom OAI model configuration',
				action: 'add'
			});

			const quickPick = window.createQuickPick<ModelQuickPickItem>();
			quickPick.title = 'Custom OAI Models Configuration';
			quickPick.placeholder = 'Select a model to edit or add a new one';
			quickPick.items = items;
			quickPick.ignoreFocusOut = true;
			quickPick.buttons = items.length > 1 ? [QuickInputButtons.Back] : [];

			const selected = await new Promise<ModelQuickPickItem | BackButtonClick | undefined>((resolve) => {
				const disposableStore = new DisposableStore();

				disposableStore.add(quickPick.onDidTriggerButton(button => {
					if (button === QuickInputButtons.Back) {
						resolve({ back: true });
						quickPick.hide();
					}
				}));

				disposableStore.add(quickPick.onDidAccept(() => {
					const selectedItem = quickPick.selectedItems[0];
					resolve(selectedItem);
					quickPick.hide();
				}));

				disposableStore.add(quickPick.onDidHide(() => {
					resolve(undefined);
					disposableStore.dispose();
				}));

				quickPick.show();
			});

			if (!selected || isBackButtonClick(selected)) {
				return;
			}

			if (selected.action === 'add') {
				const newModel = await this._configureModel();
				if (newModel) {
					const updatedModels = { ...models, [newModel.id]: newModel.config };
					await this._configurationService.setConfig(this._configKey, updatedModels);
				}
			} else if (selected.action === 'edit' && selected.modelId) {
				const result = await this._editModel(selected.modelId, models[selected.modelId]);
				if (result) {
					if (result.action === 'update') {
						const updatedModels = { ...models, [result.id]: result.config };
						await this._configurationService.setConfig(this._configKey, updatedModels);
					} else if (result.action === 'delete') {
						const updatedModels = { ...models };
						delete updatedModels[selected.modelId];
						await this._configurationService.setConfig(this._configKey, updatedModels);
					}
				}
			}
		}
	}

	/**
	 * Configure a new model through multi-step input
	 */
	private async _configureModel(): Promise<{ id: string; config: ModelConfig } | undefined> {
		// Step 1: Model ID
		const modelId = await this._createInputBoxWithBackButton({
			title: 'Add Custom OAI Model - Model ID',
			prompt: 'Enter a unique identifier for this model',
			placeHolder: 'e.g., my-custom-gpt-4',
			validateInput: (value) => {
				if (!value.trim()) {
					return 'Model ID cannot be empty';
				}
				const existingModels = this._configurationService.getConfig(this._configKey);
				if (existingModels[value.trim()]) {
					return 'A model with this ID already exists';
				}
				return null;
			}
		});

		if (!modelId || isBackButtonClick(modelId)) {
			return undefined;
		}

		// Step 2: Model Name
		const modelName = await this._createInputBoxWithBackButton({
			title: 'Add Custom OAI Model - Display Name',
			prompt: 'Enter a display name for this model',
			placeHolder: 'e.g., My Custom GPT-4',
			validateInput: (value) => {
				return !value.trim() ? 'Model name cannot be empty' : null;
			}
		});

		if (!modelName || isBackButtonClick(modelName)) {
			return undefined;
		}

		// Step 3: URL
		const url = await this._createInputBoxWithBackButton({
			title: 'Add Custom OAI Model - API URL',
			prompt: 'Enter the API endpoint URL',
			placeHolder: 'e.g., https://api.openai.com or https://my-api.example.com/v1',
			validateInput: (value) => {
				if (!value.trim()) {
					return 'URL cannot be empty';
				}
				try {
					new URL(value.trim());
					return null;
				} catch {
					return 'Please enter a valid URL';
				}
			}
		});

		if (!url || isBackButtonClick(url)) {
			return undefined;
		}

		// Step 4: Capabilities
		const capabilities = await this._selectCapabilities();
		if (!capabilities || isBackButtonClick(capabilities)) {
			return undefined;
		}

		// Step 5: Token limits
		const tokenLimits = await this._configureTokenLimits();
		if (!tokenLimits || isBackButtonClick(tokenLimits)) {
			return undefined;
		}

		const config: ModelConfig = {
			name: modelName.trim(),
			url: url.trim(),
			toolCalling: capabilities.toolCalling,
			vision: capabilities.vision,
			thinking: capabilities.thinking,
			maxInputTokens: tokenLimits.maxInputTokens,
			maxOutputTokens: tokenLimits.maxOutputTokens,
			...(this._forceRequiresAPIKey ? {} : { requiresAPIKey: capabilities.requiresAPIKey })
		};

		return { id: modelId.trim(), config };
	}

	/**
	 * Edit an existing model
	 */
	private async _editModel(modelId: string, currentConfig: ModelConfig): Promise<{ action: 'update' | 'delete'; id: string; config?: ModelConfig } | undefined> {
		const items: QuickPickItem[] = [
			{
				label: `$(edit) Edit Model`,
				detail: 'Modify the model configuration',
			},
			{
				label: `$(trash) Delete Model`,
				detail: 'Remove this model configuration',
			}
		];

		const quickPick = window.createQuickPick();
		quickPick.title = `Edit Model: ${currentConfig.name}`;
		quickPick.placeholder = 'Choose an action';
		quickPick.items = items;
		quickPick.ignoreFocusOut = true;
		quickPick.buttons = [QuickInputButtons.Back];

		const selected = await new Promise<QuickPickItem | BackButtonClick | undefined>((resolve) => {
			const disposableStore = new DisposableStore();

			disposableStore.add(quickPick.onDidTriggerButton(button => {
				if (button === QuickInputButtons.Back) {
					resolve({ back: true });
					quickPick.hide();
				}
			}));

			disposableStore.add(quickPick.onDidAccept(() => {
				const selectedItem = quickPick.selectedItems[0];
				resolve(selectedItem);
				quickPick.hide();
			}));

			disposableStore.add(quickPick.onDidHide(() => {
				resolve(undefined);
				disposableStore.dispose();
			}));

			quickPick.show();
		});

		if (!selected || isBackButtonClick(selected)) {
			return undefined;
		}

		if (selected.label.includes('Delete')) {
			const confirmed = await window.showWarningMessage(
				`Are you sure you want to delete the model "${currentConfig.name}"?`,
				{ modal: true },
				'Delete'
			);

			if (confirmed === 'Delete') {
				return { action: 'delete', id: modelId };
			}
			return undefined;
		}

		// Edit model
		const updatedConfig = await this._editModelConfig(currentConfig);
		if (updatedConfig && !isBackButtonClick(updatedConfig)) {
			return { action: 'update', id: modelId, config: updatedConfig };
		}

		return undefined;
	}

	/**
	 * Edit model configuration through multi-step inputs
	 */
	private async _editModelConfig(currentConfig: ModelConfig): Promise<ModelConfig | BackButtonClick | undefined> {
		// Edit Name
		const modelName = await this._createInputBoxWithBackButton({
			title: 'Edit Model - Display Name',
			prompt: 'Enter a display name for this model',
			placeHolder: 'e.g., My Custom GPT-4',
			value: currentConfig.name,
			validateInput: (value) => {
				return !value.trim() ? 'Model name cannot be empty' : null;
			}
		});

		if (!modelName || isBackButtonClick(modelName)) {
			return isBackButtonClick(modelName) ? modelName : undefined;
		}

		// Edit URL
		const url = await this._createInputBoxWithBackButton({
			title: 'Edit Model - API URL',
			prompt: 'Enter the API endpoint URL',
			placeHolder: 'e.g., https://api.openai.com or https://my-api.example.com/v1',
			value: currentConfig.url,
			validateInput: (value) => {
				if (!value.trim()) {
					return 'URL cannot be empty';
				}
				try {
					new URL(value.trim());
					return null;
				} catch {
					return 'Please enter a valid URL';
				}
			}
		});

		if (!url || isBackButtonClick(url)) {
			return isBackButtonClick(url) ? url : undefined;
		}

		// Edit Capabilities
		const capabilities = await this._selectCapabilities({
			toolCalling: currentConfig.toolCalling,
			vision: currentConfig.vision,
			thinking: currentConfig.thinking ?? false,
			requiresAPIKey: currentConfig.requiresAPIKey ?? true
		});

		if (!capabilities || isBackButtonClick(capabilities)) {
			return isBackButtonClick(capabilities) ? capabilities : undefined;
		}

		// Edit Token limits
		const tokenLimits = await this._configureTokenLimits({
			maxInputTokens: currentConfig.maxInputTokens,
			maxOutputTokens: currentConfig.maxOutputTokens
		});

		if (!tokenLimits || isBackButtonClick(tokenLimits)) {
			return isBackButtonClick(tokenLimits) ? tokenLimits : undefined;
		}

		return {
			name: modelName.trim(),
			url: url.trim(),
			toolCalling: capabilities.toolCalling,
			vision: capabilities.vision,
			thinking: capabilities.thinking,
			maxInputTokens: tokenLimits.maxInputTokens,
			maxOutputTokens: tokenLimits.maxOutputTokens,
			...(this._forceRequiresAPIKey ? {} : { requiresAPIKey: capabilities.requiresAPIKey })
		};
	}

	/**
	 * Select model capabilities
	 */
	private async _selectCapabilities(defaults?: { toolCalling: boolean; vision: boolean; thinking: boolean; requiresAPIKey: boolean }): Promise<{ toolCalling: boolean; vision: boolean; thinking: boolean; requiresAPIKey: boolean } | BackButtonClick | undefined> {
		const capabilities = {
			toolCalling: defaults?.toolCalling ?? false,
			vision: defaults?.vision ?? false,
			thinking: defaults?.thinking ?? false,
			requiresAPIKey: this._forceRequiresAPIKey || (defaults?.requiresAPIKey ?? true)
		};

		const items: QuickPickItem[] = [
			{
				label: 'Tool Calling',
				picked: capabilities.toolCalling
			},
			{
				label: 'Vision',
				picked: capabilities.vision
			},
			{
				label: 'Thinking',
				picked: capabilities.thinking
			}
		];

		// Only show "Requires API Key" option if not forced to true
		if (!this._forceRequiresAPIKey) {
			items.push({
				label: 'Requires API Key',
				picked: capabilities.requiresAPIKey
			});
		}

		const quickPick = window.createQuickPick();
		quickPick.title = 'Model Capabilities';
		quickPick.placeholder = 'Select model capabilities (use space to toggle, press Enter to confirm)';
		quickPick.items = items;
		quickPick.canSelectMany = true;
		quickPick.ignoreFocusOut = true;
		quickPick.buttons = [QuickInputButtons.Back];

		// Set initial selections
		quickPick.selectedItems = items.filter(item => item.picked);

		const result = await new Promise<QuickPickItem[] | BackButtonClick | undefined>((resolve) => {
			const disposableStore = new DisposableStore();

			disposableStore.add(quickPick.onDidTriggerButton(button => {
				if (button === QuickInputButtons.Back) {
					resolve({ back: true });
					quickPick.hide();
				}
			}));

			disposableStore.add(quickPick.onDidAccept(() => {
				const selectedItems = quickPick.selectedItems;
				resolve([...selectedItems]);
				quickPick.hide();
			}));

			disposableStore.add(quickPick.onDidChangeSelection((items) => {
				// Update capability state based on selection
				capabilities.toolCalling = items.some(item => item.label.includes('Tool Calling'));
				capabilities.vision = items.some(item => item.label.includes('Vision'));
				capabilities.thinking = items.some(item => item.label.includes('Thinking'));
				if (!this._forceRequiresAPIKey) {
					capabilities.requiresAPIKey = items.some(item => item.label.includes('Requires API Key'));
				}

				// Update items to reflect current state
				items.forEach(item => {
					if (item.label.includes('Tool Calling')) {
						item.label = 'Tool Calling';
					} else if (item.label.includes('Vision')) {
						item.label = 'Vision';
					} else if (item.label.includes('Thinking')) {
						item.label = 'Thinking';
					} else if (item.label.includes('Requires API Key')) {
						item.label = 'Requires API Key';
					}
				});
			}));

			disposableStore.add(quickPick.onDidHide(() => {
				resolve(undefined);
				disposableStore.dispose();
			}));

			quickPick.show();
		});

		if (!result || isBackButtonClick(result)) {
			return isBackButtonClick(result) ? result : undefined;
		}

		return capabilities;
	}

	/**
	 * Configure token limits
	 */
	private async _configureTokenLimits(defaults?: { maxInputTokens: number; maxOutputTokens: number }): Promise<{ maxInputTokens: number; maxOutputTokens: number } | BackButtonClick | undefined> {
		// Input tokens
		const maxInputTokensStr = await this._createInputBoxWithBackButton({
			title: 'Model Token Limits - Max Input Tokens',
			prompt: 'Enter the maximum number of input tokens',
			placeHolder: 'e.g., 128000',
			value: defaults?.maxInputTokens?.toString() || '128000',
			validateInput: (value) => {
				const num = parseInt(value.trim());
				if (isNaN(num) || num <= 0) {
					return 'Please enter a positive number';
				}
				return null;
			}
		});

		if (!maxInputTokensStr || isBackButtonClick(maxInputTokensStr)) {
			return isBackButtonClick(maxInputTokensStr) ? maxInputTokensStr : undefined;
		}

		// Output tokens
		const maxOutputTokensStr = await this._createInputBoxWithBackButton({
			title: 'Model Token Limits - Max Output Tokens',
			prompt: 'Enter the maximum number of output tokens',
			placeHolder: 'e.g., 4096',
			value: defaults?.maxOutputTokens?.toString() || '4096',
			validateInput: (value) => {
				const num = parseInt(value.trim());
				if (isNaN(num) || num <= 0) {
					return 'Please enter a positive number';
				}
				return null;
			}
		});

		if (!maxOutputTokensStr || isBackButtonClick(maxOutputTokensStr)) {
			return isBackButtonClick(maxOutputTokensStr) ? maxOutputTokensStr : undefined;
		}

		return {
			maxInputTokens: parseInt(maxInputTokensStr.trim()),
			maxOutputTokens: parseInt(maxOutputTokensStr.trim())
		};
	}

	/**
	 * Helper function for creating an input box with a back button
	 */
	private _createInputBoxWithBackButton(options: InputBoxOptions): Promise<string | BackButtonClick | undefined> {
		const disposableStore = new DisposableStore();
		const inputBox = disposableStore.add(window.createInputBox());
		inputBox.ignoreFocusOut = true;
		inputBox.title = options.title;
		inputBox.password = options.password || false;
		inputBox.prompt = options.prompt;
		inputBox.placeholder = options.placeHolder;
		inputBox.value = options.value || '';
		inputBox.buttons = [QuickInputButtons.Back];

		return new Promise<string | BackButtonClick | undefined>(resolve => {
			disposableStore.add(inputBox.onDidTriggerButton(button => {
				if (button === QuickInputButtons.Back) {
					resolve({ back: true });
					disposableStore.dispose();
				}
			}));

			disposableStore.add(inputBox.onDidAccept(async () => {
				const value = inputBox.value;
				if (options.validateInput) {
					const validation = options.validateInput(value);
					if (validation) {
						// Show validation message but don't hide
						inputBox.validationMessage = (await validation) || undefined;
						return;
					}
				}
				resolve(value);
				disposableStore.dispose();
			}));

			disposableStore.add(inputBox.onDidHide(() => {
				// This resolves undefined if the input box is dismissed without accepting
				resolve(undefined);
				disposableStore.dispose();
			}));

			inputBox.show();
		});
	}
}