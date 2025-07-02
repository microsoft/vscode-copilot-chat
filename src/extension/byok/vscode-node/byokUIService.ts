/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { InputBoxOptions, QuickInputButton, QuickInputButtons, QuickPickItem, ThemeIcon, window } from 'vscode';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { BYOKAuthType, BYOKModelCapabilities, BYOKModelRegistry } from '../../byok/common/byokProvider';
import { resolveAzureUrl } from './azureProvider';
import { IBYOKStorageService } from './byokStorageService';

// Extended input box options that supports async validation
interface ExtendedInputBoxOptions extends Omit<InputBoxOptions, 'validateInput'> {
	validateInput?: (value: string) => string | null | Promise<string | null>;
}

// Define state machine for model configuration steps
enum ConfigurationStep {
	ProviderSelection,
	ModelSelection,
	ModelId,
	DeploymentUrl,
	AdvancedConfig,
	FriendlyName,
	InputTokens,
	OutputTokens,
	ToolCalling,
	Vision,
	CustomProviderName,
	CustomProviderUrl,
	Complete
}

interface ModelQuickPickItem extends QuickPickItem {
	modelId: string;
}

interface ProviderQuickPickItem extends QuickPickItem {
	providerName: string;
	authType: BYOKAuthType;
	isCustom?: boolean;
}

export interface ModelConfig {
	id: string;
	apiKey: string;
	isCustomModel: boolean;
	modelCapabilities?: BYOKModelCapabilities;
	deploymentUrl?: string;
}

type BackButtonClick = { back: true };
export function isBackButtonClick(value: unknown): value is BackButtonClick {
	return typeof value === 'object' && (value as BackButtonClick)?.back === true;
}

type StateResult = { nextStep: ConfigurationStep } | BackButtonClick | undefined;

// Interface to hold state data across steps
interface StateData {
	providerName: string;
	selectedProviderRegistry?: BYOKModelRegistry;
	modelId?: string;
	deploymentUrl?: string;
	modelApiKey?: string;
	customModelToDelete?: string;
	isNewApiKey: boolean;
	modelCapabilities?: BYOKModelCapabilities;
	friendlyName?: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	vision: boolean;
	selectedModels: string[];
	previousStep: ConfigurationStep;
	navigatingBack?: boolean;
	// Custom provider related
	customProviderName?: string;
	customProviderUrl?: string;
	customProviderToDelete?: string;
}

// Helper function for creating an input box with a back button
function createInputBoxWithBackButton(options: ExtendedInputBoxOptions): Promise<string | BackButtonClick | undefined> {
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
				const validation = await options.validateInput(value);
				if (validation) {
					// Show validation message but don't hide
					inputBox.validationMessage = validation;
					return;
				}
			}
			// Clear any previous validation message
			inputBox.validationMessage = undefined;
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

// For creating quick picks with a back button
function createQuickPickWithBackButton<T extends QuickPickItem>(
	items: T[],
	options: {
		title?: string;
		placeholder?: string;
		canPickMany?: boolean;
		includeBackButton?: boolean;
		selectedItems?: T[];
		ignoreFocusOut?: boolean;
	} = {}
): Promise<T[] | BackButtonClick | undefined> {
	const disposableStore = new DisposableStore();
	const quickPick = disposableStore.add(window.createQuickPick<T>());
	quickPick.title = options.title;
	quickPick.placeholder = options.placeholder;
	quickPick.canSelectMany = !!options.canPickMany;
	quickPick.ignoreFocusOut = options.ignoreFocusOut !== false;

	if (options.includeBackButton) {
		quickPick.buttons = [QuickInputButtons.Back];
	}

	quickPick.items = items;

	if (options.selectedItems) {
		quickPick.selectedItems = options.selectedItems;
	}

	return new Promise<T[] | BackButtonClick | undefined>(resolve => {
		disposableStore.add(quickPick.onDidTriggerButton(button => {
			if (button === QuickInputButtons.Back) {
				resolve({ back: true });
				disposableStore.dispose();
			}
		}));

		disposableStore.add(quickPick.onDidAccept(() => {
			const selectedItems = quickPick.selectedItems;
			if (selectedItems.length === 0) {
				return;
			}
			resolve(Array.from(selectedItems));
			disposableStore.dispose();
		}));

		disposableStore.add(quickPick.onDidHide(() => {
			if (!quickPick.selectedItems.length) {
				resolve(undefined);
				disposableStore.dispose();
			}
		}));

		quickPick.show();
	});
}


async function createErrorModal(errorMessage: string, currentStep: ConfigurationStep): Promise<StateResult> {
	const result = await window.showErrorMessage('Unexpected Error - Manage Models - Preview', { detail: errorMessage, modal: true }, 'Retry', 'Go Back');
	if (result === 'Retry') {
		return { nextStep: currentStep };
	} else if (result === 'Go Back') {
		return { back: true };
	} else {
		return undefined;
	}
}

export class BYOKUIService {
	constructor(
		private readonly _storageService: IBYOKStorageService,
		private readonly _modelRegistries: BYOKModelRegistry[]
	) { }

	/**
	 * Start the model management flow state machine
	 */
	public async startModelManagementFlow(): Promise<{
		selectedModels: string[];
		providerName: string;
		apiKey?: string;
		newApiKeyProvided?: boolean;
		customModelToDelete?: string;
		customModel?: ModelConfig;
		customProviderToDelete?: string;
		newCustomProvider?: { name: string; url: string };
	} | undefined> {
		// Start the state machine from the provider selection step
		let currentStep = ConfigurationStep.ProviderSelection;

		// Initialize state data
		const state: StateData = {
			providerName: '',
			selectedProviderRegistry: undefined,
			modelApiKey: '',
			isNewApiKey: false,
			selectedModels: [],
			maxInputTokens: 100000,
			maxOutputTokens: 8192,
			toolCalling: false,
			vision: false,
			previousStep: ConfigurationStep.ProviderSelection
		};

		while (currentStep !== ConfigurationStep.Complete) {
			let result: StateResult;
			const previousStepBeforeHandler = state.previousStep; // Store previous step before handler potentially changes it

			try {
				switch (currentStep) {
					case ConfigurationStep.ProviderSelection:
						result = await this._handleProviderSelection(state);
						break;
					case ConfigurationStep.ModelSelection:
						state.previousStep = ConfigurationStep.ProviderSelection;
						result = await this._handleModelSelection(state);
						break;
					case ConfigurationStep.ModelId:
						state.previousStep = ConfigurationStep.ModelSelection;
						result = await this._handleModelId(state);
						break;
					case ConfigurationStep.DeploymentUrl:
						state.previousStep = ConfigurationStep.ModelId;
						result = await this._handleDeploymentUrl(state);
						break;
					case ConfigurationStep.AdvancedConfig:
						// Previous step depends on whether deployment URL was entered
						state.previousStep = state.deploymentUrl ? ConfigurationStep.DeploymentUrl : ConfigurationStep.ModelId;
						result = await this._handleAdvancedConfig(state);
						break;
					case ConfigurationStep.FriendlyName:
						state.previousStep = ConfigurationStep.AdvancedConfig;
						result = await this._handleFriendlyName(state);
						break;
					case ConfigurationStep.InputTokens:
						state.previousStep = ConfigurationStep.FriendlyName;
						result = await this._handleInputTokens(state);
						break;
					case ConfigurationStep.OutputTokens:
						state.previousStep = ConfigurationStep.InputTokens;
						result = await this._handleOutputTokens(state);
						break;
					case ConfigurationStep.ToolCalling:
						state.previousStep = ConfigurationStep.OutputTokens;
						result = await this._handleToolCalling(state);
						break;
					case ConfigurationStep.Vision:
						state.previousStep = ConfigurationStep.ToolCalling;
						result = await this._handleVision(state);
						break;
					case ConfigurationStep.CustomProviderName:
						state.previousStep = ConfigurationStep.ProviderSelection;
						result = await this._handleCustomProviderName(state);
						break;
					case ConfigurationStep.CustomProviderUrl:
						state.previousStep = ConfigurationStep.CustomProviderName;
						result = await this._handleCustomProviderUrl(state);
						break;
					default:
						// Should not happen
						return undefined;
				}
			} catch (error) {
				result = await createErrorModal(error instanceof Error ? error.message : error, currentStep);
			}

			if (!result) {
				return undefined;
			}

			if (isBackButtonClick(result)) {
				// Handle back navigation
				// Special case: If back from DeploymentUrl for Azure, go to ModelSelection
				if (currentStep === ConfigurationStep.DeploymentUrl && state.selectedProviderRegistry?.name === 'Azure') {
					currentStep = ConfigurationStep.ModelSelection;
				} else {
					currentStep = state.previousStep;
				}
				// Restore the previous step state in case the handler modified it before back was pressed
				state.previousStep = previousStepBeforeHandler;
				state.navigatingBack = true;
			} else {
				// Move to the next step
				currentStep = result.nextStep;
				state.navigatingBack = undefined;
			}
		}

		// State machine is complete, return the final result
		return {
			apiKey: state.modelApiKey,
			newApiKeyProvided: state.isNewApiKey,
			providerName: state.providerName,
			customModelToDelete: state.customModelToDelete,
			customProviderToDelete: state.customProviderToDelete,
			selectedModels: state.selectedModels,
			customModel: state.modelId ? {
				isCustomModel: true,
				id: state.modelId,
				apiKey: state.modelApiKey!,
				modelCapabilities: state.modelCapabilities,
				deploymentUrl: state.deploymentUrl
			} : undefined,
			newCustomProvider: state.customProviderName && state.customProviderUrl ? {
				name: state.customProviderName,
				url: state.customProviderUrl
			} : undefined
		};
	}

	// --- State Handler Methods ---

	private async _handleProviderSelection(state: StateData): Promise<{ nextStep: ConfigurationStep } | undefined> {
		// Create quick pick items for providers with option to reconfigure API key
		const quickPickItems: ProviderQuickPickItem[] = [];

		// Add built-in providers
		for (const registry of this._modelRegistries) {
			const apiKey = await this._storageService.getAPIKey(registry.name);
			quickPickItems.push({
				label: registry.name,
				providerName: registry.name,
				authType: registry.authType,
				isCustom: false,
				// Add gear icon for providers that use global API key
				buttons: registry.authType === BYOKAuthType.GlobalApiKey && !!apiKey ? [{
					iconPath: new ThemeIcon('gear'),
					tooltip: `Reconfigure ${registry.name} API Key`
				}] : []
			});
		}

		// Add custom providers from storage
		const customProviders = await this._storageService.getCustomProviders();
		for (const customProvider of customProviders) {
			const apiKey = await this._storageService.getAPIKey(customProvider.name);
			quickPickItems.push({
				label: customProvider.name,
				description: customProvider.url,
				providerName: customProvider.name,
				authType: BYOKAuthType.GlobalApiKey, // Custom providers use global API key
				isCustom: true,
				// Add gear icon for API key reconfiguration and trash icon for deletion
				buttons: [
					...(apiKey ? [{
						iconPath: new ThemeIcon('gear'),
						tooltip: `Reconfigure ${customProvider.name} API Key`
					}] : []),
					{
						iconPath: new ThemeIcon('trash'),
						tooltip: `Delete ${customProvider.name} provider`
					}
				]
			});
		}

		// Add special item for adding custom provider
		quickPickItems.push({
			label: '$(plus) Add Custom Provider',
			description: 'Add a new OpenAI-compatible provider',
			providerName: '_ADD_CUSTOM_',
			authType: BYOKAuthType.GlobalApiKey,
			isCustom: false
		});

		// Use manual quick pick creation for item button handling
		const quickPick = window.createQuickPick<ProviderQuickPickItem>();
		quickPick.title = 'Manage Models - Preview';
		quickPick.ignoreFocusOut = false;
		quickPick.placeholder = 'Select a provider or add a custom one';
		quickPick.items = quickPickItems;
		let didCancel = true;

		const providerResult = await new Promise<{ providerName: string; apiKey?: string; action?: 'delete' | 'add' } | undefined>(resolve => {
			// Handle button clicks for API key reconfiguration and deletion
			quickPick.onDidTriggerItemButton(async event => {
				didCancel = false;
				const item = event.item;
				const providerName = item.providerName;
				const authType = item.authType;

				// Check if it's a delete button (trash icon)
				if (event.button.iconPath instanceof ThemeIcon && (event.button.iconPath as ThemeIcon).id === 'trash') {
					// Delete custom provider
					state.customProviderToDelete = providerName;
					resolve({ providerName, action: 'delete' });
					return;
				}

				// Otherwise it's a gear icon for API key reconfiguration
				const newApiKey = await this.promptForAPIKey(providerName, true);
				if (newApiKey) {
					await this._storageService.storeAPIKey(providerName, newApiKey, authType);
					state.isNewApiKey = true;
					resolve({ providerName, apiKey: newApiKey });
				} else if (newApiKey === '') {
					// User left blank, delete key
					await this._storageService.deleteAPIKey(providerName, authType);
					resolve(undefined);
				} else {
					resolve(undefined);
				}
			});

			// Handle provider selection
			quickPick.onDidAccept(async () => {
				quickPick.hide();
				const selected = quickPick.selectedItems[0];
				if (!selected) {
					resolve(undefined);
					return;
				}

				const providerName = selected.providerName;

				// Check if user wants to add custom provider
				if (providerName === '_ADD_CUSTOM_') {
					resolve({ providerName, action: 'add' });
					return;
				}

				resolve({ providerName });
			});
			quickPick.show();
		});

		// If user cancelled or deleted key, restart provider selection
		if (!providerResult && !didCancel) {
			return { nextStep: ConfigurationStep.ProviderSelection };
		} else if (!providerResult) { // The user cancelled, so we just close the quickpick
			return undefined;
		}

		// Handle special actions
		if (providerResult.action === 'delete') {
			// Delete custom provider and restart selection
			await this._storageService.removeCustomProvider(providerResult.providerName);
			return { nextStep: ConfigurationStep.ProviderSelection };
		} else if (providerResult.action === 'add') {
			// Start custom provider creation flow
			return { nextStep: ConfigurationStep.CustomProviderName };
		}

		// Store provider selection results in state
		state.providerName = providerResult.providerName;
		state.selectedProviderRegistry = this._modelRegistries.find(r => r.name === providerResult.providerName);
		state.modelApiKey = providerResult.apiKey || ''; // Use reconfigured key if provided

		// For custom providers, we need to create a temporary registry
		if (!state.selectedProviderRegistry) {
			// Check if it's a custom provider
			const customProvider = customProviders.find(p => p.name === providerResult.providerName);
			if (customProvider) {
				// Create a temporary registry for the custom provider
				// We'll handle this in the parent class (BYOKContrib)
				state.providerName = customProvider.name;
				// For now, just proceed to model selection
				return { nextStep: ConfigurationStep.ModelSelection };
			} else {
				// Should not happen if providerResult is valid
				throw new Error('Selected provider registry not found.');
			}
		}

		// Get API key for providers that need it (if not already set by reconfigure)
		if (state.selectedProviderRegistry.authType === BYOKAuthType.GlobalApiKey && !state.modelApiKey) {
			state.modelApiKey = await this._storageService.getAPIKey(state.providerName);
			if (!state.modelApiKey) {
				state.modelApiKey = await this.promptForAPIKey(state.providerName);
				if (!state.modelApiKey) {
					// User cancelled API key prompt, go back to provider selection
					return { nextStep: ConfigurationStep.ProviderSelection };
				}
				await this._storageService.storeAPIKey(state.providerName, state.modelApiKey, state.selectedProviderRegistry.authType);
			}
		}

		// Move to model selection step
		return { nextStep: ConfigurationStep.ModelSelection };
	}

	private async _handleModelSelection(state: StateData): Promise<StateResult> {
		if (!state.selectedProviderRegistry || !state.providerName) {
			throw new Error('Provider information is missing.');
		}

		// Use manual quick pick for custom 'Add' button
		const quickPick = window.createQuickPick<ModelQuickPickItem>();
		quickPick.busy = true;
		quickPick.buttons = [QuickInputButtons.Back];
		quickPick.title = `Manage ${state.providerName} Models - Preview`;
		quickPick.ignoreFocusOut = true;
		quickPick.placeholder = `Fetching models...`;
		quickPick.canSelectMany = true;
		quickPick.enabled = false;
		quickPick.show();

		try {
			// Get currently registered models from stored config
			const modelConfigs = await this._storageService.getStoredModelConfigs(state.providerName);
			const registeredModels = Object.entries(modelConfigs);

			const providerModelInfo = await state.selectedProviderRegistry.getAllModels(state.modelApiKey || undefined);
			const availableModels: Map<string, { id: string; name: string }> = new Map();
			providerModelInfo.forEach(model => availableModels.set(model.id, { id: model.id, name: model.name }));

			// Mix in any custom/already registered models
			registeredModels.forEach(([modelId, modelConfig]) => {
				if (!availableModels.has(modelId)) {
					availableModels.set(modelId, { id: modelId, name: modelConfig?.modelCapabilities?.name || modelId });
				}
			});

			// If no models (neither available nor registered), go directly to custom model flow
			if (availableModels.size === 0) {
				quickPick.hide();

				if (state.navigatingBack) {
					// If we're navigating back and there are no models, go back to provider selection
					return { nextStep: ConfigurationStep.ProviderSelection };
				}
				return { nextStep: ConfigurationStep.ModelId };
			}

			const modelItems: ModelQuickPickItem[] = Array.from(availableModels.values()).map(model => ({
				label: model.name,
				description: model.id,
				modelId: model.id,
				buttons: (modelConfigs[model.id] && modelConfigs[model.id]?.isCustomModel) ? [{ iconPath: new ThemeIcon('trash'), tooltip: `Delete ${model.name}` }] : [],
				picked: (modelConfigs[model.id] && modelConfigs[model.id]?.isRegistered !== false) || state.selectedModels.includes(model.id) // Pre-select based on registration or previous step
			} satisfies ModelQuickPickItem)).sort((a, b) => {
				// Sort by picked first (picked items at the top)
				if (a.picked !== b.picked) {
					return a.picked ? -1 : 1;
				}
				// Then sort alphabetically by label
				return a.label.localeCompare(b.label);
			});

			quickPick.items = modelItems;
			quickPick.selectedItems = modelItems.filter(item => item.picked);
			quickPick.placeholder = `Select models to register or deregister`;
			quickPick.buttons = [
				QuickInputButtons.Back,
				{ iconPath: new ThemeIcon('add'), tooltip: 'Add Custom Model' },
			];
			quickPick.enabled = true;
			quickPick.busy = false;

			const modelResult = await new Promise<{
				selectedModels: string[];
				customModel?: boolean;
				modelToDelete?: string;
				back?: boolean;
			} | undefined>(resolve => {
				// Only item button is trash can for custom model, so assume that was what was clicked
				quickPick.onDidTriggerItemButton(e => {
					quickPick.hide();
					resolve({ selectedModels: [], modelToDelete: e.item.modelId });
				});
				quickPick.onDidTriggerButton(async (button: QuickInputButton) => {
					quickPick.hide();
					if (button === QuickInputButtons.Back) {
						resolve({ back: true, selectedModels: [] });
					} else { // Add Custom Model button
						resolve({
							selectedModels: quickPick.selectedItems.map(item => item.modelId),
							customModel: true
						});
					}
				});

				quickPick.onDidAccept(async () => {
					quickPick.hide();
					resolve({
						selectedModels: quickPick.selectedItems.map(item => item.modelId),
						customModel: false
					});
				});

				quickPick.onDidHide(() => {
					// Resolve undefined if dismissed without accept/button click
					resolve(undefined);
				});
			});

			if (!modelResult) {
				return undefined;
			}

			if (modelResult.back) {
				return { back: true };
			}

			// User has selected to delete a custom model from the list, we consider this a complete step and exit the flow
			if (modelResult.modelToDelete) {
				state.customModelToDelete = modelResult.modelToDelete;
				return { nextStep: ConfigurationStep.Complete };
			}

			// Update selected models in state
			state.selectedModels = modelResult.selectedModels;

			if (modelResult.customModel) {
				// Move to custom model flow (ModelId or DeploymentUrl based on provider)
				const nextStep = state.selectedProviderRegistry.authType === BYOKAuthType.PerModelDeployment ?
					ConfigurationStep.DeploymentUrl : ConfigurationStep.ModelId;
				return { nextStep: nextStep };
			} else {
				// User finished selecting standard models, complete the flow
				return { nextStep: ConfigurationStep.Complete };
			}
		} catch (error) {
			quickPick.hide(); // Ensure quick pick is hidden on error
			throw error;
		}
	}

	private async _handleModelId(state: StateData): Promise<StateResult> {
		if (!state.selectedProviderRegistry) { throw new Error('Provider information is missing.'); }

		const modelChoice = await createInputBoxWithBackButton({
			title: `Custom Model - ${state.providerName}`,
			placeHolder: 'Enter the model ID',
			ignoreFocusOut: true,
			prompt: `Enter a custom ${state.selectedProviderRegistry.name} model ID`,
			validateInput: (value) => value.trim().length > 0 ? null : 'Model ID cannot be empty'
		});

		if (!modelChoice) { return undefined; }
		if (isBackButtonClick(modelChoice)) { return { back: true }; }

		state.modelId = modelChoice;

		// PerModelDeployment requires URL next,
		// Open Router has all the info it needs after the model id due to the great Open Router API
		// others go to advanced config to ask the user for info
		if (state.selectedProviderRegistry.authType === BYOKAuthType.PerModelDeployment) {
			return { nextStep: ConfigurationStep.DeploymentUrl };
		} else if (state.selectedProviderRegistry.name === 'OpenRouter') {
			return { nextStep: ConfigurationStep.Complete };
		} else {
			return { nextStep: ConfigurationStep.AdvancedConfig };
		}


	}

	private async _handleDeploymentUrl(state: StateData): Promise<StateResult> {
		if (!state.selectedProviderRegistry) { throw new Error('Provider information is missing.'); }

		const isAzure = state.selectedProviderRegistry.name === 'Azure';
		const prompt = isAzure ? 'Enter the Azure OpenAI deployment endpoint URL' : 'Enter the deployment URL';
		const placeHolder = isAzure ? 'e.g., https://YOUR_RESOURCE_NAME.openai.azure.com/' : 'Enter deployment URL';

		const urlResult = await createInputBoxWithBackButton({
			title: `Custom Model - ${state.providerName}`,
			ignoreFocusOut: true,
			placeHolder: placeHolder,
			prompt: prompt,
			validateInput: (value) => value.trim().length > 0 ? null : 'Deployment URL cannot be empty'
		});

		if (!urlResult) { return undefined; } // Cancelled
		if (isBackButtonClick(urlResult)) { return { back: true }; }

		state.deploymentUrl = isAzure ? resolveAzureUrl(state.modelId!, urlResult) : urlResult;

		// Always need an API key for per-model deployments (unless already provided e.g. via reconfigure)
		if (!state.modelApiKey) {
			state.modelApiKey = await this.promptForAPIKey(state.modelId || state.providerName); // Use modelId if available for prompt
			if (!state.modelApiKey) {
				// User cancelled API key prompt, go back
				return { back: true };
			}
			// Note: We don't store per-model keys globally here, they are part of the final ModelConfig
		}

		return { nextStep: ConfigurationStep.AdvancedConfig };
	}

	private async _handleAdvancedConfig(state: StateData): Promise<StateResult> {
		if (!state.selectedProviderRegistry || !state.modelId) { throw new Error('Provider or model information is missing.'); }

		const items = [
			{ label: 'Yes', description: 'Configure token limits and capabilities' },
			{ label: 'No', description: 'Use default settings' }
		];

		const advancedResult = await createQuickPickWithBackButton(
			items,
			{
				title: `Advanced Configuration - ${state.modelId}`,
				placeholder: 'Configure advanced settings (optional)?',
				includeBackButton: true,
				ignoreFocusOut: true
			}
		);

		if (!advancedResult) { return undefined; } // Cancelled
		if (isBackButtonClick(advancedResult)) { return { back: true }; }

		if (advancedResult[0].label === 'Yes') {
			return { nextStep: ConfigurationStep.FriendlyName };
		} else {
			return {
				nextStep: ConfigurationStep.Complete
			};
		}
	}

	private async _handleFriendlyName(state: StateData): Promise<StateResult> {
		if (!state.modelId) { throw new Error('Model information is missing.'); }

		const nameResult = await createInputBoxWithBackButton({
			title: `Advanced Configuration - ${state.modelId}`,
			ignoreFocusOut: true,
			placeHolder: state.modelId, // Default to model ID
			prompt: 'Enter a friendly name for the model (optional)',
			value: state.friendlyName // Pre-fill if navigating back
		});

		// Allow empty input (uses modelId), but not cancellation
		if (nameResult === undefined) { return undefined; } // Cancelled
		if (isBackButtonClick(nameResult)) { return { back: true }; }

		state.friendlyName = nameResult || state.modelId; // Use modelId if empty
		return { nextStep: ConfigurationStep.InputTokens };
	}

	private async _handleInputTokens(state: StateData): Promise<StateResult> {
		if (!state.modelId) { throw new Error('Model information is missing.'); }

		const inputTokensResult = await createInputBoxWithBackButton({
			title: `Advanced Configuration - ${state.modelId}`,
			ignoreFocusOut: true,
			placeHolder: String(state.maxInputTokens), // Show current/default
			prompt: 'Enter maximum input tokens (prompt size)',
			value: String(state.maxInputTokens), // Pre-fill
			validateInput: (value) => {
				if (!value.trim()) { return null; } // Allow empty (uses default)
				const num = Number(value);
				return isNaN(num) || num <= 0 ? 'Please enter a valid positive number' : null;
			}
		});

		if (inputTokensResult === undefined) { return undefined; } // Cancelled
		if (isBackButtonClick(inputTokensResult)) { return { back: true }; }

		state.maxInputTokens = inputTokensResult ? Number(inputTokensResult) : 100000; // Default if empty
		return { nextStep: ConfigurationStep.OutputTokens };
	}

	private async _handleOutputTokens(state: StateData): Promise<StateResult> {
		if (!state.modelId) { throw new Error('Model information is missing.'); }

		const outputTokensResult = await createInputBoxWithBackButton({
			title: `Advanced Configuration - ${state.modelId}`,
			ignoreFocusOut: true,
			placeHolder: String(state.maxOutputTokens), // Show current/default
			prompt: 'Enter maximum output tokens (completion size)',
			value: String(state.maxOutputTokens), // Pre-fill
			validateInput: (value) => {
				if (!value.trim()) { return null; } // Allow empty (uses default)
				const num = Number(value);
				return isNaN(num) || num <= 0 ? 'Please enter a valid positive number' : null;
			}
		});

		if (outputTokensResult === undefined) { return undefined; } // Cancelled
		if (isBackButtonClick(outputTokensResult)) { return { back: true }; }

		state.maxOutputTokens = outputTokensResult ? Number(outputTokensResult) : 8192; // Default if empty
		return { nextStep: ConfigurationStep.ToolCalling };
	}

	private async _handleToolCalling(state: StateData): Promise<StateResult> {
		if (!state.modelId) { throw new Error('Model information is missing.'); }

		const items = [
			{ label: 'Yes', value: true },
			{ label: 'No', value: false }
		];

		const toolCallingResult = await createQuickPickWithBackButton(
			items,
			{
				title: `Advanced Configuration - ${state.modelId}`,
				placeholder: 'Does this model support tool calling?',
				includeBackButton: true,
				ignoreFocusOut: true,
			}
		);

		if (!toolCallingResult) { return undefined; } // Cancelled
		if (isBackButtonClick(toolCallingResult)) { return { back: true }; }

		// Type assertion needed as createQuickPickWithBackButton returns generic QuickPickItem[]
		state.toolCalling = !!(toolCallingResult[0] as { value: boolean }).value;
		return { nextStep: ConfigurationStep.Vision };
	}

	private async _handleVision(state: StateData): Promise<StateResult> {
		if (!state.modelId) { throw new Error('Model information is missing.'); }

		const items = [
			{ label: 'Yes', value: true },
			{ label: 'No', value: false }
		];
		const visionResult = await createQuickPickWithBackButton(
			items,
			{
				title: `Advanced Configuration - ${state.modelId}`,
				placeholder: 'Does this model support vision (image understanding)?',
				includeBackButton: true,
				ignoreFocusOut: true,
			}
		);

		if (!visionResult) { return undefined; } // Cancelled
		if (isBackButtonClick(visionResult)) { return { back: true }; }

		state.vision = !!(visionResult[0] as { value: boolean }).value;

		// Final step: Assemble capabilities and complete the flow
		state.modelCapabilities = {
			name: state.friendlyName!, // Friendly name defaults to modelId if not entered
			maxInputTokens: state.maxInputTokens,
			maxOutputTokens: state.maxOutputTokens,
			toolCalling: state.toolCalling,
			vision: state.vision
		};

		return { nextStep: ConfigurationStep.Complete };
	}

	// --- Helper Methods ---

	private async _handleCustomProviderName(state: StateData): Promise<StateResult> {
		const nameResult = await createInputBoxWithBackButton({
			title: 'Add Custom Provider',
			prompt: 'Enter a name for the custom provider',
			placeHolder: 'e.g., Local LM Studio, Custom OpenAI',
			ignoreFocusOut: true,
			validateInput: async (value) => {
				if (!value.trim()) {
					return 'Provider name cannot be empty';
				}

				// Check if name already exists
				const existingProviders = await this._storageService.getCustomProviders();
				const existingBuiltInProviders = this._modelRegistries.map(r => r.name);

				if (existingProviders.some(p => p.name === value.trim()) ||
					existingBuiltInProviders.includes(value.trim())) {
					return 'A provider with this name already exists';
				}

				return null;
			}
		});

		if (!nameResult) {
			return undefined;
		}
		if (isBackButtonClick(nameResult)) {
			return { back: true };
		}

		state.customProviderName = nameResult.trim();
		return { nextStep: ConfigurationStep.CustomProviderUrl };
	}

	private async _handleCustomProviderUrl(state: StateData): Promise<StateResult> {
		if (!state.customProviderName) {
			return undefined;
		}

		const urlResult = await createInputBoxWithBackButton({
			title: `Add Custom Provider - ${state.customProviderName}`,
			prompt: 'Enter the base URL for the OpenAI-compatible API',
			placeHolder: 'e.g., http://localhost:1234/v1, https://api.openrouter.ai/api/v1',
			ignoreFocusOut: true,
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

		if (!urlResult) {
			return undefined;
		}
		if (isBackButtonClick(urlResult)) {
			return { back: true };
		}

		state.customProviderUrl = urlResult.trim();

		// Save the custom provider and complete
		await this._storageService.addCustomProvider({
			name: state.customProviderName,
			url: state.customProviderUrl,
			addedAt: Date.now()
		});

		return { nextStep: ConfigurationStep.Complete };
	}

	private async promptForAPIKey(contextName: string, reconfigure: boolean = false): Promise<string | undefined> {
		const prompt = reconfigure ? `Enter new ${contextName} API Key or leave blank to delete saved key` : `Enter ${contextName} API Key`;
		const title = reconfigure ? `Reconfigure ${contextName} API Key - Preview` : `Enter ${contextName} API Key - Preview`;

		const result = await createInputBoxWithBackButton({
			prompt: prompt,
			title: title,
			placeHolder: `${contextName} API Key`,
			ignoreFocusOut: true,
			password: true,
			validateInput: (value) => {
				// Allow empty input only when reconfiguring (to delete the key)
				return (value.trim().length > 0 || reconfigure) ? null : 'API Key cannot be empty';
			}
		});

		if (isBackButtonClick(result)) {
			return undefined;
		}

		return result;
	}
}