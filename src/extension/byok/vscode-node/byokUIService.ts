/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { InputBoxOptions, QuickInputButton, QuickInputButtons, QuickPickItem, ThemeIcon, window } from 'vscode';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { BYOKAuthType, BYOKModelCapabilities, BYOKModelRegistry } from '../../byok/common/byokProvider';
import { resolveAzureUrl } from './azureProvider';
import { IBYOKStorageService } from './byokStorageService';

// Define state machine for model configuration steps
enum ConfigurationStep {
	ProviderSelection,
	ModelSelection,
	ModelId,
	DeploymentUrl,
	ApiModelSelection, // New step for selecting from API-fetched models
	AdvancedConfig,
	FriendlyName,
	InputTokens,
	OutputTokens,
	ToolCalling,
	Vision,
	Complete
}

interface ModelQuickPickItem extends QuickPickItem {
	modelId: string;
}

interface ProviderQuickPickItem extends QuickPickItem {
	providerName: string;
	authType: BYOKAuthType;
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
}

// Helper function for creating an input box with a back button
function createInputBoxWithBackButton(options: InputBoxOptions): Promise<string | BackButtonClick | undefined> {
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
	// Enhanced error modal with better categorization and user guidance
	let title = 'Configuration Error - Manage Models - Preview';
	let actions = ['Retry', 'Go Back'];

	// Provide specific guidance based on error type
	if (errorMessage.includes('API key') || errorMessage.includes('authentication') || errorMessage.includes('unauthorized')) {
		title = 'API Key Error - Manage Models - Preview';
		actions = ['Check API Key', 'Go Back'];
	} else if (errorMessage.includes('endpoint') || errorMessage.includes('URL') || errorMessage.includes('connection')) {
		title = 'Connection Error - Manage Models - Preview';
		actions = ['Check Endpoint', 'Go Back'];
	} else if (errorMessage.includes('model') && errorMessage.includes('not found')) {
		title = 'Model Error - Manage Models - Preview';
		actions = ['Check Model ID', 'Go Back'];
	}

	const result = await window.showErrorMessage(title, { detail: errorMessage, modal: true }, ...actions);
	if (result === 'Retry' || result === 'Check API Key' || result === 'Check Endpoint' || result === 'Check Model ID') {
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
	public async startModelManagementFlow(): Promise<{ selectedModels: string[]; providerName: string; apiKey?: string; newApiKeyProvided?: boolean; customModelToDelete?: string; customModel?: ModelConfig } | undefined> {
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
						state.previousStep = ConfigurationStep.ModelSelection;
						result = await this._handleDeploymentUrl(state);
						break;
					case ConfigurationStep.ApiModelSelection:
						state.previousStep = ConfigurationStep.DeploymentUrl;
						result = await this._handleApiModelSelection(state);
						break;
					case ConfigurationStep.AdvancedConfig:
						// Previous step depends on the flow taken
						state.previousStep = state.modelId && state.deploymentUrl ? ConfigurationStep.ApiModelSelection :
							state.deploymentUrl ? ConfigurationStep.DeploymentUrl : ConfigurationStep.ModelId;
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
			selectedModels: state.selectedModels,
			customModel: state.modelId ? {
				isCustomModel: true,
				id: state.modelId,
				apiKey: state.modelApiKey!,
				modelCapabilities: state.modelCapabilities,
				deploymentUrl: state.deploymentUrl
			} : undefined
		};
	}

	// --- State Handler Methods ---

	private async _handleProviderSelection(state: StateData): Promise<{ nextStep: ConfigurationStep } | undefined> {
		// Create quick pick items for providers with option to reconfigure API key
		const quickPickItems: ProviderQuickPickItem[] = [];

		for (const registry of this._modelRegistries) {
			const apiKey = await this._storageService.getAPIKey(registry.name);
			const isCustomProvider = registry.name === 'Custom';
			quickPickItems.push({
				label: registry.name,
				description: isCustomProvider ? 'Configure your own OpenAI-compatible API endpoint' : undefined,
				providerName: registry.name,
				authType: registry.authType,
				// Add gear icon for providers that use global API key
				buttons: registry.authType === BYOKAuthType.GlobalApiKey && !!apiKey ? [{
					iconPath: new ThemeIcon('gear'),
					tooltip: `Reconfigure ${registry.name} API Key`
				}] : []
			});
		}

		// Use manual quick pick creation for item button handling
		const quickPick = window.createQuickPick<ProviderQuickPickItem>();
		quickPick.title = 'Manage Models - Preview';
		quickPick.ignoreFocusOut = false;
		quickPick.placeholder = 'Select a provider';
		quickPick.items = quickPickItems;
		let didCancel = true;

		const providerResult = await new Promise<{ providerName: string; apiKey?: string } | undefined>(resolve => {
			// Handle button clicks for API key reconfiguration
			quickPick.onDidTriggerItemButton(async event => {
				didCancel = false;
				const item = event.item;
				const providerName = item.providerName;
				const authType = item.authType;

				// Force update API key
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

		// Store provider selection results in state
		state.providerName = providerResult.providerName;
		state.selectedProviderRegistry = this._modelRegistries.find(r => r.name === providerResult.providerName);
		state.modelApiKey = providerResult.apiKey || ''; // Use reconfigured key if provided

		if (!state.selectedProviderRegistry) {
			// Should not happen if providerResult is valid
			throw new Error('Selected provider registry not found.');
		}

		// Set appropriate defaults for Custom OpenAI models to enable Edit mode
		if (state.selectedProviderRegistry.name === 'Custom') {
			state.toolCalling = true; // Enable tool calling by default for custom OpenAI models
			state.vision = false; // Default to no vision support (user can change in advanced config)
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

			// If no models (neither available nor registered), handle appropriately
			if (availableModels.size === 0) {
				const isCustomProvider = state.selectedProviderRegistry.name === 'Custom';

				quickPick.hide();

				if (state.navigatingBack) {
					// If we're navigating back and there are no models, go back to provider selection
					return { nextStep: ConfigurationStep.ProviderSelection };
				}

				if (isCustomProvider) {
					// For custom providers with no models, go directly to custom model flow
					// since they need to configure their endpoint first anyway
					const nextStep = state.selectedProviderRegistry.authType === BYOKAuthType.PerModelDeployment ?
						ConfigurationStep.DeploymentUrl : ConfigurationStep.ModelId;
					return { nextStep: nextStep };
				} else {
					// For non-custom providers, go to model ID entry
					return { nextStep: ConfigurationStep.ModelId };
				}
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
				// Move to custom model flow
				// For custom OpenAI providers, always go to DeploymentUrl to collect API URL first
				// For other PerModelDeployment providers (like Azure), also go to DeploymentUrl
				// For others (like OpenRouter), go to ModelId
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
		const isCustomOpenAI = state.selectedProviderRegistry.name === 'Custom';

		let prompt: string;
		let placeHolder: string;

		if (isAzure) {
			prompt = 'Enter the Azure OpenAI deployment endpoint URL';
			placeHolder = 'e.g., https://YOUR_RESOURCE_NAME.openai.azure.com/';
		} else if (isCustomOpenAI) {
			prompt = 'Enter the API endpoint URL (without /chat/completions)\n\nSupported providers: OpenAI and other OpenAI-compatible APIs';
			placeHolder = 'e.g., https://api.openai.com/v1 or https://your-api-endpoint/v1';
		} else {
			prompt = 'Enter the deployment URL';
			placeHolder = 'Enter deployment URL';
		}

		const urlResult = await createInputBoxWithBackButton({
			title: `Custom Model - ${state.providerName}`,
			ignoreFocusOut: true,
			placeHolder: placeHolder,
			prompt: prompt,
			validateInput: (value) => {
				if (value.trim().length === 0) {
					return 'Deployment URL cannot be empty';
				}
				if (isCustomOpenAI) {
					try {
						const url = new URL(value.trim());
						if (!url.protocol.startsWith('http')) {
							return 'URL must use HTTP or HTTPS protocol';
						}
						if (value.trim().endsWith('/chat/completions')) {
							return 'Please enter the base URL without /chat/completions (it will be added automatically)';
						}
						// Additional validation for common endpoints
						if (url.hostname === 'localhost' || url.hostname.startsWith('127.') || url.hostname.startsWith('192.168.') || url.hostname.startsWith('10.')) {
							// Allow local endpoints but show warning in placeholder
							return null;
						}
						// Validate common API endpoint patterns
						if (!url.pathname || url.pathname === '/') {
							return 'API endpoint should include a version path (e.g., /v1)';
						}
					} catch {
						return 'Please enter a valid URL (e.g., https://api.example.com/v1)';
					}
				}
				return null;
			}
		});

		if (!urlResult) { return undefined; } // Cancelled
		if (isBackButtonClick(urlResult)) { return { back: true }; }

		if (isAzure) {
			state.deploymentUrl = resolveAzureUrl(state.modelId!, urlResult);
		} else if (isCustomOpenAI) {
			// Ensure the URL doesn't end with a slash for consistency
			state.deploymentUrl = urlResult.trim().replace(/\/$/, '');
		} else {
			state.deploymentUrl = urlResult;
		}

		// Always need an API key for per-model deployments (unless already provided e.g. via reconfigure)
		if (!state.modelApiKey) {
			state.modelApiKey = await this.promptForAPIKey(state.modelId || state.providerName); // Use modelId if available for prompt
			if (!state.modelApiKey) {
				// User cancelled API key prompt, go back
				return { back: true };
			}
			// Note: We don't store per-model keys globally here, they are part of the final ModelConfig
		}

		// For custom OpenAI providers, try to fetch available models
		if (isCustomOpenAI) {
			return { nextStep: ConfigurationStep.ApiModelSelection };
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
			// Set reasonable defaults for custom OpenAI models when advanced config is skipped
			// This ensures Edit mode works properly
			const isCustomOpenAI = state.selectedProviderRegistry?.name === 'Custom';
			if (isCustomOpenAI) {
				state.maxInputTokens = 100000; // Default input tokens for custom models
				state.maxOutputTokens = 8192; // Default output tokens for custom models
				state.toolCalling = true; // Enable tool calling by default for custom OpenAI models
				state.vision = false; // Default to no vision support
				state.modelCapabilities = {
					name: state.modelId!,
					maxInputTokens: state.maxInputTokens,
					maxOutputTokens: state.maxOutputTokens,
					toolCalling: state.toolCalling,
					vision: state.vision
				};
			}
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

		const isCustomOpenAI = state.selectedProviderRegistry?.name === 'Custom';
		const items = [
			{ label: 'Yes', value: true },
			{ label: 'No', value: false }
		];

		const toolCallingResult = await createQuickPickWithBackButton(
			items,
			{
				title: `Advanced Configuration - ${state.modelId}`,
				placeholder: isCustomOpenAI ?
					'Does this model support tool calling? (Required for Edit mode)' :
					'Does this model support tool calling?',
				includeBackButton: true,
				ignoreFocusOut: true,
				// Pre-select "Yes" for Custom OpenAI models since most OpenAI-compatible models support tool calling
				selectedItems: isCustomOpenAI ? [items[0]] : undefined
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

	private async promptForAPIKey(contextName: string, reconfigure: boolean = false): Promise<string | undefined> {
		const isCustomProvider = contextName.includes('Custom');

		let prompt = reconfigure ? `Enter new ${contextName} API Key or leave blank to delete saved key` : `Enter ${contextName} API Key`;
		let placeHolder = `${contextName} API Key`;

		// Enhanced prompts for custom providers
		if (isCustomProvider) {
			prompt = reconfigure ?
				`Enter new API Key for your custom endpoint or leave blank to delete saved key` :
				`Enter API Key for your custom endpoint\n\nThis will be securely stored and used only for this model configuration.`;
			placeHolder = 'API Key (e.g., sk-... for OpenAI-compatible APIs)';
		}

		const title = reconfigure ? `Reconfigure ${contextName} API Key - Preview` : `Enter ${contextName} API Key - Preview`;

		const result = await createInputBoxWithBackButton({
			prompt: prompt,
			title: title,
			placeHolder: placeHolder,
			ignoreFocusOut: true,
			password: true,
			validateInput: (value) => {
				// Allow empty input only when reconfiguring (to delete the key)
				if (!value.trim() && !reconfigure) {
					return 'API Key cannot be empty';
				}

				// Enhanced validation for custom providers
				if (value.trim() && isCustomProvider) {
					if (value.trim().length < 10) {
						return 'API Key appears to be too short. Please verify you\'ve entered the complete key.';
					}

					// Check for common placeholder values
					const placeholders = ['your-api-key', 'api-key-here', 'replace-me', 'example-key'];
					if (placeholders.some(placeholder => value.toLowerCase().includes(placeholder))) {
						return 'Please replace the placeholder with your actual API key.';
					}
				}

				return null;
			}
		});

		if (isBackButtonClick(result)) {
			return undefined;
		}

		return result;
	}

	private async _handleApiModelSelection(state: StateData): Promise<StateResult> {
		if (!state.selectedProviderRegistry || !state.deploymentUrl || !state.modelApiKey) {
			throw new Error('Provider, deployment URL, or API key information is missing.');
		}

		const quickPick = window.createQuickPick();
		quickPick.title = `Select Model - ${state.providerName}`;
		quickPick.placeholder = 'Loading available models...';
		quickPick.enabled = false;
		quickPick.busy = true;
		quickPick.buttons = [QuickInputButtons.Back];
		quickPick.ignoreFocusOut = true;
		quickPick.show();

		try {
			// Fetch available models from the API
			const availableModels = await this._fetchModelsFromAPI(state.deploymentUrl, state.modelApiKey);

			if (availableModels.length === 0) {
				// No models available, fall back to manual entry
				quickPick.hide();
				return { nextStep: ConfigurationStep.ModelId };
			}

			// Create quick pick items for available models
			const modelItems = availableModels.map(model => ({
				label: model.name || model.id,
				description: model.id !== model.name ? model.id : undefined,
				detail: `Available model from ${state.providerName}`,
				modelId: model.id
			}));

			quickPick.items = modelItems;
			quickPick.placeholder = 'Select a model or go back to enter manually';
			quickPick.enabled = true;
			quickPick.busy = false;

			// Add manual entry option
			const manualEntryItem = {
				label: '$(add) Enter model ID manually',
				description: 'Custom model ID',
				detail: 'Enter a custom model ID if not listed above',
				modelId: '__manual__'
			};
			quickPick.items = [...modelItems, manualEntryItem];

			return new Promise<StateResult>((resolve) => {
				quickPick.onDidTriggerButton(button => {
					if (button === QuickInputButtons.Back) {
						quickPick.hide();
						resolve({ back: true });
					}
				});

				quickPick.onDidAccept(() => {
					const selected = quickPick.selectedItems[0];
					if (!selected) {
						quickPick.hide();
						resolve(undefined);
						return;
					} const selectedModelId = (selected as any).modelId;

					if (selectedModelId === '__manual__') {
						// User wants to enter manually
						quickPick.hide();
						resolve({ nextStep: ConfigurationStep.ModelId });
					} else {
						// User selected a model
						state.modelId = selectedModelId;
						quickPick.hide();
						resolve({ nextStep: ConfigurationStep.AdvancedConfig });
					}
				});

				quickPick.onDidHide(() => {
					resolve(undefined);
				});
			});

		} catch (error) {
			// If fetching models fails, fall back to manual entry
			quickPick.hide();

			// Show error message but continue with manual entry
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			window.showWarningMessage(
				`Could not fetch available models: ${errorMessage}. You can still enter a model ID manually.`
			);

			return { nextStep: ConfigurationStep.ModelId };
		}
	}

	/**
	 * Fetches available models from the API endpoint
	 */
	private async _fetchModelsFromAPI(deploymentUrl: string, apiKey: string): Promise<{ id: string; name: string }[]> {
		// Use the registry to fetch models if it's a custom provider
		const customProvider = this._modelRegistries.find(registry => registry.name === 'Custom');

		if (customProvider && (customProvider as any).fetchModelsFromEndpoint) {
			return await (customProvider as any).fetchModelsFromEndpoint(deploymentUrl, apiKey);
		}

		// This should not happen in our case, but provide a fallback
		throw new Error('Custom provider not found or does not support model fetching');
	}
}