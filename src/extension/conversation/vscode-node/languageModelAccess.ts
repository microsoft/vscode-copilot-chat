/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Raw } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { CopilotToken } from '../../../platform/authentication/common/copilotToken';
import { IBlockedExtensionService } from '../../../platform/chat/common/blockedExtensionService';
import { ChatFetchResponseType, ChatLocation, getErrorDetailsFromChatFetchError } from '../../../platform/chat/common/commonTypes';
import { getTextPart } from '../../../platform/chat/common/globalStringUtils';
import { EmbeddingType, getWellKnownEmbeddingTypeInfo, IEmbeddingsComputer } from '../../../platform/embeddings/common/embeddingsComputer';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { CustomDataPartMimeTypes } from '../../../platform/endpoint/common/endpointTypes';
import { ModelAliasRegistry } from '../../../platform/endpoint/common/modelAliasRegistry';
import { encodeStatefulMarker } from '../../../platform/endpoint/common/statefulMarkerContainer';
import { AutoChatEndpoint } from '../../../platform/endpoint/node/autoChatEndpoint';
import { IAutomodeService } from '../../../platform/endpoint/node/automodeService';
import { IEnvService, isScenarioAutomation } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OpenAiFunctionTool, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IChatEndpoint, IEndpoint } from '../../../platform/networking/common/networking';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { isEncryptedThinkingDelta } from '../../../platform/thinking/common/thinking';
import { BaseTokensPerCompletion } from '../../../platform/tokenizer/node/tokenizer';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable, MutableDisposable } from '../../../util/vs/base/common/lifecycle';
import { isBoolean, isDefined, isNumber, isString, isStringArray } from '../../../util/vs/base/common/types';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtensionMode } from '../../../vscodeTypes';
import type { LMResponsePart } from '../../byok/common/byokProvider';
import { IExtensionContribution } from '../../common/contributions';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { isImageDataPart } from '../common/languageModelChatMessageHelpers';
import { LanguageModelAccessPrompt } from './languageModelAccessPrompt';

const MODEL_NAME_OVERRIDES_KEY = 'copilot.modelNameOverrides';

export class LanguageModelAccess extends Disposable implements IExtensionContribution {

	readonly id = 'languageModelAccess';

	readonly activationBlocker?: Promise<void>;

	private readonly _onDidChange = this._register(new Emitter<void>());
	private _currentModels: vscode.LanguageModelChatInformation[] = []; // Store current models for reference
	private _chatEndpoints: IChatEndpoint[] = [];
	private _lmWrapper: CopilotLanguageModelWrapper;
	private _promptBaseCountCache: LanguageModelAccessPromptBaseCountCache;
	private _modelNameOverrides: Record<string, string> = {};

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
		@IVSCodeExtensionContext private readonly _vsCodeExtensionContext: IVSCodeExtensionContext,
		@IAutomodeService private readonly _automodeService: IAutomodeService,
		@IExperimentationService private readonly _expService: IExperimentationService,
	) {
		super();

		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
		this._promptBaseCountCache = this._instantiationService.createInstance(LanguageModelAccessPromptBaseCountCache);

		if (this._vsCodeExtensionContext.extensionMode === ExtensionMode.Test && !isScenarioAutomation) {
			this._logService.warn('[LanguageModelAccess] LanguageModels and Embeddings are NOT AVAILABLE in test mode.');
			return;
		}

		// Load model name overrides from storage
		this._loadModelNameOverrides();

		// Register manage models command
		this._register(vscode.commands.registerCommand('github.copilot.chat.manageModels', () => this._manageModels()));

		// initial
		this.activationBlocker = Promise.all([
			this._registerChatProvider(),
			this._registerEmbeddings(),
		]).then(() => { });
	}

	override dispose(): void {
		super.dispose();
	}

	get currentModels(): vscode.LanguageModelChatInformation[] {
		return this._currentModels;
	}

	private async _registerChatProvider(): Promise<void> {
		const provider: vscode.LanguageModelChatProvider = {
			onDidChangeLanguageModelChatInformation: this._onDidChange.event,
			provideLanguageModelChatInformation: this._provideLanguageModelChatInfo.bind(this),
			provideLanguageModelChatResponse: this._provideLanguageModelChatResponse.bind(this),
			provideTokenCount: this._provideTokenCount.bind(this)
		};
		this._register(vscode.lm.registerLanguageModelChatProvider('copilot', provider));
		this._register(this._authenticationService.onDidAuthenticationChange(() => {
			// Auth changed which means models could've changed. Fire the event
			this._onDidChange.fire();
		}));
	}

	private _loadModelNameOverrides(): void {
		const overrides = this._vsCodeExtensionContext.globalState.get<Record<string, string>>(MODEL_NAME_OVERRIDES_KEY);
		this._modelNameOverrides = overrides ?? {};
	}

	private async _saveModelNameOverrides(): Promise<void> {
		await this._vsCodeExtensionContext.globalState.update(MODEL_NAME_OVERRIDES_KEY, this._modelNameOverrides);
	}

	private async _manageModels(): Promise<void> {
		// Only allow internal users to rename models
		if (!this._authenticationService.copilotToken?.isInternal) {
			vscode.window.showInformationMessage('Model management is only available for internal users.');
			return;
		}

		const models = this._currentModels.filter(m => m.isUserSelectable);
		if (models.length === 0) {
			vscode.window.showInformationMessage('No models available to manage.');
			return;
		}

		interface ModelQuickPickItem extends vscode.QuickPickItem {
			modelId: string;
			action: 'rename' | 'reset';
		}

		const items: ModelQuickPickItem[] = [];

		// Add rename options for each model
		for (const model of models) {
			const hasOverride = this._modelNameOverrides[model.id];
			items.push({
				label: `$(edit) Rename "${model.name}"`,
				description: hasOverride ? `(overridden from "${this._getOriginalModelName(model.id)}")` : undefined,
				modelId: model.id,
				action: 'rename'
			});
		}

		// Add separator and reset options if there are any overrides
		const overrideCount = Object.keys(this._modelNameOverrides).length;
		if (overrideCount > 0) {
			items.push({
				label: '',
				kind: vscode.QuickPickItemKind.Separator,
				modelId: '',
				action: 'reset'
			});
			items.push({
				label: '$(trash) Reset all model name overrides',
				description: `(${overrideCount} override${overrideCount > 1 ? 's' : ''})`,
				modelId: '',
				action: 'reset'
			});
		}

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a model to rename',
			title: 'Manage Copilot Models (Internal Only)'
		});

		if (!selected) {
			return;
		}

		if (selected.action === 'reset') {
			const confirm = await vscode.window.showWarningMessage(
				'Are you sure you want to reset all model name overrides?',
				{ modal: true },
				'Reset'
			);
			if (confirm === 'Reset') {
				this._modelNameOverrides = {};
				await this._saveModelNameOverrides();
				this._onDidChange.fire();
				vscode.window.showInformationMessage('All model name overrides have been reset.');
			}
			return;
		}

		// Handle rename
		const model = models.find(m => m.id === selected.modelId);
		if (!model) {
			return;
		}

		const currentName = model.name;
		const originalName = this._getOriginalModelName(selected.modelId);
		const newName = await vscode.window.showInputBox({
			prompt: `Enter new display name for "${currentName}"`,
			value: currentName,
			title: 'Rename Model',
			validateInput: (value) => {
				if (!value || value.trim().length === 0) {
					return 'Name cannot be empty';
				}
				return undefined;
			}
		});

		if (newName) {
			const trimmedName = newName.trim();
			if (trimmedName === originalName) {
				// User entered the original name, remove override
				delete this._modelNameOverrides[selected.modelId];
				await this._saveModelNameOverrides();
				this._onDidChange.fire();
				vscode.window.showInformationMessage(`Model name reset to "${originalName}".`);
			} else if (trimmedName !== currentName) {
				// Store the trimmed name as the override
				this._modelNameOverrides[selected.modelId] = trimmedName;
				await this._saveModelNameOverrides();
				this._onDidChange.fire();
				vscode.window.showInformationMessage(`Model renamed to "${trimmedName}".`);
			}
		}
	}

	private _getOriginalModelName(modelId: string): string {
		const endpoint = this._chatEndpoints.find(e =>
			(e instanceof AutoChatEndpoint ? AutoChatEndpoint.pseudoModelId : e.model) === modelId
		);
		if (endpoint instanceof AutoChatEndpoint) {
			return 'Auto';
		}
		return endpoint?.name ?? modelId;
	}

	private _getModelDisplayName(modelId: string, originalName: string): string {
		return this._modelNameOverrides[modelId] ?? originalName;
	}

	private async _provideLanguageModelChatInfo(options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		const session = await this._getToken();
		if (!session) {
			this._currentModels = [];
			return [];
		}

		const models: vscode.LanguageModelChatInformation[] = [];
		const chatEndpoints = (await this._endpointProvider.getAllChatEndpoints()).filter(e => e.showInModelPicker || e.model === 'gpt-4o-mini');
		const autoEndpoint = await this._automodeService.resolveAutoModeEndpoint(undefined, chatEndpoints);
		chatEndpoints.push(autoEndpoint);
		let defaultChatEndpoint: IChatEndpoint | undefined;
		const defaultExpModel = this._expService.getTreatmentVariable<string>('chat.defaultLanguageModel')?.replace('copilot/', '');
		if (this._authenticationService.copilotToken?.isNoAuthUser) {
			// No Auth users always get Auto as the default model
			defaultChatEndpoint = autoEndpoint;
		} else if (defaultExpModel === AutoChatEndpoint.pseudoModelId) {
			// Auto is a fake model id so force map it
			defaultChatEndpoint = autoEndpoint;
		} else if (defaultExpModel) {
			// Find exp default
			defaultChatEndpoint = chatEndpoints.find(e => e.model === defaultExpModel);
		}
		if (!defaultChatEndpoint) {
			// Find a default set by CAPI
			defaultChatEndpoint = chatEndpoints.find(e => e.isDefault) ?? chatEndpoints.find(e => e.showInModelPicker) ?? chatEndpoints[0];
		}
		const seenFamilies = new Set<string>();

		for (const endpoint of chatEndpoints) {
			if (seenFamilies.has(endpoint.family) && !endpoint.showInModelPicker) {
				continue;
			}
			seenFamilies.add(endpoint.family);

			const sanitizedModelName = endpoint.name.replace(/\(Preview\)/g, '').trim();
			let modelDescription: string | undefined;
			if (endpoint.degradationReason) {
				modelDescription = endpoint.degradationReason;
			} else if (endpoint instanceof AutoChatEndpoint) {
				if (this._authenticationService.copilotToken?.isNoAuthUser || (endpoint.discountRange.low === 0 && endpoint.discountRange.high === 0)) {
					modelDescription = vscode.l10n.t('Auto selects the best model for your request based on capacity and performance.');
				} else if (endpoint.discountRange.low === endpoint.discountRange.high) {
					modelDescription = vscode.l10n.t('Auto selects the best model for your request based on capacity and performance. Auto is given a {0}% discount.', endpoint.discountRange.low * 100);
				} else {
					modelDescription = vscode.l10n.t('Auto selects the best model for your request based on capacity and performance. Auto is given a {0}% to {1}% discount.', endpoint.discountRange.low * 100, endpoint.discountRange.high * 100);
				}
			} else if (endpoint.multiplier) {
				modelDescription = vscode.l10n.t('{0} ({1}) is counted at a {2}x rate.', sanitizedModelName, endpoint.version, endpoint.multiplier);
			} else if (endpoint.isFallback && endpoint.multiplier === 0) {
				modelDescription = vscode.l10n.t('{0} ({1}) does not count towards your premium request limit. This model may be slowed during times of high congestion.', sanitizedModelName, endpoint.version);
			} else {
				modelDescription = `${sanitizedModelName} (${endpoint.version})`;
			}

			let modelCategory: { label: string; order: number } | undefined;
			if (endpoint instanceof AutoChatEndpoint) {
				modelCategory = { label: '', order: Number.MIN_SAFE_INTEGER };
			} else if (endpoint.isPremium === undefined || this._authenticationService.copilotToken?.isFreeUser) {
				modelCategory = { label: vscode.l10n.t("Copilot Models"), order: 0 };
			} else if (endpoint.isPremium) {
				modelCategory = { label: vscode.l10n.t("Premium Models"), order: 1 };
			} else {
				modelCategory = { label: vscode.l10n.t("Standard Models"), order: 0 };
			}

			// Counting tokens requires instantiating the tokenizers, which makes this process use a lot of memory.
			// Let's cache the results across extension activations
			const baseCount = await this._promptBaseCountCache.getBaseCount(endpoint);
			let modelDetail = endpoint.multiplier !== undefined ? `${endpoint.multiplier}x` : undefined;

			if (endpoint instanceof AutoChatEndpoint) {
				if (endpoint.discountRange.high === endpoint.discountRange.low && endpoint.discountRange.low !== 0) {
					modelDetail = `${endpoint.discountRange.low * 100}% discount`;
				} else if (endpoint.discountRange.high !== endpoint.discountRange.low) {
					modelDetail = `${endpoint.discountRange.low * 100}% to ${endpoint.discountRange.high * 100}% discount`;
				}
			}
			if (endpoint.customModel) {
				const customModel = endpoint.customModel;
				modelDetail = customModel.owner_name;
				modelDescription = `${endpoint.name} is contributed by ${customModel.owner_name} using ${customModel.key_name}`;
				modelCategory = { label: vscode.l10n.t("Custom Models"), order: 2 };
			}

			const session = this._authenticationService.anyGitHubSession;

			const modelId = endpoint instanceof AutoChatEndpoint ? AutoChatEndpoint.pseudoModelId : endpoint.model;
			const originalName = endpoint instanceof AutoChatEndpoint ? 'Auto' : endpoint.name;
			const displayName = this._getModelDisplayName(modelId, originalName);

			const model: vscode.LanguageModelChatInformation = {
				id: modelId,
				name: displayName,
				family: endpoint.family,
				tooltip: modelDescription,
				detail: modelDetail,
				category: modelCategory,
				statusIcon: endpoint.degradationReason ? new vscode.ThemeIcon('warning') : undefined,
				version: endpoint.version,
				maxInputTokens: endpoint.modelMaxPromptTokens - baseCount - BaseTokensPerCompletion,
				maxOutputTokens: endpoint.maxOutputTokens,
				requiresAuthorization: session && { label: session.account.label },
				isDefault: endpoint === defaultChatEndpoint,
				isUserSelectable: endpoint.showInModelPicker,
				capabilities: {
					imageInput: endpoint.supportsVision,
					toolCalling: endpoint.supportsToolCalls,
				}
			};

			models.push(model);

			// Register aliases for this model
			const aliases = ModelAliasRegistry.getAliases(model.id);
			for (const alias of aliases) {
				models.push({
					...model,
					id: alias,
					family: alias,
					isUserSelectable: false,
				});
			}
		}

		this._currentModels = models;
		this._chatEndpoints = chatEndpoints;
		return models;
	}

	private async _provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>,
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken
	): Promise<void> {
		const endpoint = this._chatEndpoints.find(e => e.model === ModelAliasRegistry.resolveAlias(model.id));
		if (!endpoint) {
			throw new Error(`Endpoint not found for model ${model.id}`);
		}

		return this._lmWrapper.provideLanguageModelResponse(endpoint, messages, {
			...options,
			modelOptions: options.modelOptions
		}, options.requestInitiator, progress, token);
	}

	private async _provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2,
		token: vscode.CancellationToken
	): Promise<number> {
		const endpoint = this._chatEndpoints.find(e => e.model === ModelAliasRegistry.resolveAlias(model.id));
		if (!endpoint) {
			throw new Error(`Endpoint not found for model ${model.id}`);
		}

		return this._lmWrapper.provideTokenCount(endpoint, text);
	}

	private async _registerEmbeddings(): Promise<void> {

		const dispo = this._register(new MutableDisposable());


		const update = async () => {

			if (!await this._getToken()) {
				dispo.clear();
				return;
			}

			const embeddingsComputer = this._embeddingsComputer;
			const embeddingType = EmbeddingType.text3small_512;
			const model = getWellKnownEmbeddingTypeInfo(embeddingType)?.model;
			if (!model) {
				throw new Error(`No model found for embedding type ${embeddingType.id}`);
			}

			dispo.clear();
			dispo.value = vscode.lm.registerEmbeddingsProvider(`copilot.${model}`, new class implements vscode.EmbeddingsProvider {
				async provideEmbeddings(input: string[], token: vscode.CancellationToken): Promise<vscode.Embedding[]> {
					const result = await embeddingsComputer.computeEmbeddings(embeddingType, input, {}, new TelemetryCorrelationId('EmbeddingsProvider::provideEmbeddings'), token);
					return result.values.map(embedding => ({ values: embedding.value.slice(0) }));
				}
			});
		};

		this._register(this._authenticationService.onDidAuthenticationChange(() => update()));
		await update();
	}

	private async _getToken(): Promise<CopilotToken | undefined> {
		try {
			const copilotToken = await this._authenticationService.getCopilotToken();
			return copilotToken;
		} catch (e) {
			this._logService.warn('[LanguageModelAccess] LanguageModel/Embeddings are not available without auth token');
			this._logService.error(e);
			return undefined;
		}
	}
}

class LanguageModelAccessPromptBaseCountCache {
	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEnvService private readonly _envService: IEnvService
	) { }

	public async getBaseCount(endpoint: IChatEndpoint): Promise<number> {
		const key = `lmBaseCount/${endpoint.model}`;
		const cached = this._extensionContext.globalState.get<{ extensionVersion: string; baseCount: number }>(key);
		if (cached && cached.extensionVersion === this._envService.getVersion() && typeof cached.baseCount === 'number') {
			return cached.baseCount;
		}

		const baseCount = await this._computeBaseCount(endpoint);
		// Store the computed value along with the extension version so we can
		// invalidate the cache when the extension is updated.
		try {
			await this._extensionContext.globalState.update(key, { extensionVersion: this._envService.getVersion(), baseCount });
		} catch (err) {
			// Best-effort cache update — don't fail the caller if persisting the
			// cache entry fails for any reason.
		}

		return baseCount;
	}

	private async _computeBaseCount(endpoint: IChatEndpoint): Promise<number> {
		const baseCount = await PromptRenderer.create(this._instantiationService, endpoint, LanguageModelAccessPrompt, { noSafety: false, messages: [] }).countTokens();
		return baseCount;
	}

}

/**
 * Exported for test
 */
export class CopilotLanguageModelWrapper extends Disposable {

	constructor(
		@IExperimentationService readonly _expService: IExperimentationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IBlockedExtensionService private readonly _blockedExtensionService: IBlockedExtensionService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IEnvService private readonly _envService: IEnvService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
	) {
		super();
	}

	private async _provideLanguageModelResponse(_endpoint: IChatEndpoint, _messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, _options: vscode.ProvideLanguageModelChatResponseOptions, extensionId: string, callback: FinishedCallback, token: vscode.CancellationToken): Promise<void> {

		const extensionInfo = extensionId === 'core' ? { packageJSON: { version: this._envService.vscodeVersion } } : vscode.extensions.getExtension(extensionId, true);
		if (!extensionInfo || typeof extensionInfo.packageJSON.version !== 'string') {
			throw new Error('Invalid extension information');
		}
		const extensionVersion = <string>extensionInfo.packageJSON.version;

		const blockedExtensionMessage = vscode.l10n.t('The extension has been temporarily blocked due to making too many requests. Please try again later.');
		if (this._blockedExtensionService.isExtensionBlocked(extensionId)) {
			throw vscode.LanguageModelError.Blocked(blockedExtensionMessage);
		}

		const toolTokenCount = _options.tools ? await this.countToolTokens(_endpoint, _options.tools) : 0;
		const baseCount = await PromptRenderer.create(this._instantiationService, _endpoint, LanguageModelAccessPrompt, { noSafety: false, messages: [] }).countTokens();
		const tokenLimit = _endpoint.modelMaxPromptTokens - baseCount - BaseTokensPerCompletion - toolTokenCount;

		this.validateRequest(_messages);
		if (_options.tools) {
			this.validateTools(_options.tools);
		}
		// Add safety rules to the prompt if it originates from outside the Copilot Chat extension, otherwise they already exist in the prompt.
		const { messages, tokenCount } = await PromptRenderer.create(this._instantiationService, {
			..._endpoint,
			modelMaxPromptTokens: tokenLimit
		}, LanguageModelAccessPrompt, { noSafety: extensionId === this._envService.extensionId, messages: _messages }).render();

		/* __GDPR__
			"languagemodelrequest" : {
				"owner": "jrieken",
				"comment": "Data about extensions using the language model",
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that is being used" },
				"extensionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The extension identifier for which we make the request" },
				"extensionVersion": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The extension version for which we make the request" },
				"tokenCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of tokens" },
				"tokenLimit": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of tokens that can be used" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent(
			'languagemodelrequest',
			{
				extensionId,
				extensionVersion,
				model: _endpoint.model
			},
			{
				tokenCount,
				tokenLimit
			}
		);

		// If no messages they got rendered out due to token limit
		if (messages.length === 0 || tokenCount > tokenLimit) {
			throw new Error('Message exceeds token limit.');
		}

		if (_options.tools && _options.tools.length > 128) {
			throw new Error('Cannot have more than 128 tools per request.');
		}

		const endpoint: IChatEndpoint = new Proxy(_endpoint, {
			get: function (target, prop, receiver) {
				if (prop === 'getExtraHeaders') {
					return function () {
						const extraHeaders = target.getExtraHeaders?.() ?? {};
						if (extensionId === 'core') {
							return extraHeaders;
						}
						return {
							...extraHeaders,
							'x-onbehalf-extension-id': `${extensionId}/${extensionVersion}`,
						};
					};
				}
				if (prop === 'acquireTokenizer') {
					return target.acquireTokenizer.bind(target);
				}
				return Reflect.get(target, prop, receiver);
			}
		});


		const options: OptionalChatRequestParams = LanguageModelOptions.Default.convert(_options.modelOptions ?? {});
		const telemetryProperties = { messageSource: `api.${extensionId}` };

		options.tools = _options.tools?.map((tool): OpenAiFunctionTool => {
			return {
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.inputSchema && Object.keys(tool.inputSchema).length ? tool.inputSchema : undefined
				}
			};
		});
		if (_options.toolMode === vscode.LanguageModelChatToolMode.Required && _options.tools?.length && _options.tools.length > 1) {
			throw new Error('LanguageModelChatToolMode.Required is not supported with more than one tool');
		}

		options.tool_choice = _options.toolMode === vscode.LanguageModelChatToolMode.Required && _options.tools?.length ?
			{ type: 'function', function: { name: _options.tools[0].name } } :
			undefined;

		const result = await endpoint.makeChatRequest('copilotLanguageModelWrapper', messages, callback, token, ChatLocation.Other, { extensionId }, options, extensionId !== 'core', telemetryProperties);

		if (result.type !== ChatFetchResponseType.Success) {
			if (result.type === ChatFetchResponseType.ExtensionBlocked) {
				this._blockedExtensionService.reportBlockedExtension(extensionId, result.retryAfter);
				throw vscode.LanguageModelError.Blocked(blockedExtensionMessage);
			} else if (result.type === ChatFetchResponseType.QuotaExceeded) {
				const details = getErrorDetailsFromChatFetchError(result, await this._endpointProvider.getChatEndpoint('copilot-base'), (await this._authenticationService.getCopilotToken()).copilotPlan);
				const err = new vscode.LanguageModelError(details.message);
				err.name = 'ChatQuotaExceeded';
				throw err;
			} else if (result.type === ChatFetchResponseType.RateLimited) {
				const err = new Error(result.reason);
				err.name = 'ChatRateLimited';
				throw err;
			}

			throw new Error(result.reason);
		}

		this._telemetryService.sendInternalMSFTTelemetryEvent(
			'languagemodelrequest',
			{
				extensionId,
				extensionVersion,
				requestid: result.requestId,
				query: getTextPart(messages[messages.length - 1].content),
				model: _endpoint.model
			},
			{
				tokenCount,
				tokenLimit
			}
		);
	}

	async provideLanguageModelResponse(endpoint: IChatEndpoint, messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, options: vscode.ProvideLanguageModelChatResponseOptions, extensionId: string, progress: vscode.Progress<LMResponsePart>, token: vscode.CancellationToken): Promise<void> {
		let thinkingActive = false;
		const finishCallback: FinishedCallback = async (_text, index, delta): Promise<undefined> => {
			if (delta.thinking) {
				// Show thinking progress for unencrypted thinking deltas
				if (!isEncryptedThinkingDelta(delta.thinking)) {
					const text = delta.thinking.text ?? '';
					progress.report(new vscode.LanguageModelThinkingPart(text, delta.thinking.id, delta.thinking.metadata));
					thinkingActive = true;
				}
			} else if (thinkingActive) {
				progress.report(new vscode.LanguageModelThinkingPart('', '', { vscode_reasoning_done: true }));
				thinkingActive = false;
			}
			if (delta.text) {
				progress.report(new vscode.LanguageModelTextPart(delta.text));
			}
			if (delta.copilotToolCalls) {
				for (const call of delta.copilotToolCalls) {
					try {
						// Anthropic models send "" (empty string) for tools with no parameters.
						const parameters = JSON.parse(call.arguments || '{}');
						progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parameters));
					} catch (err) {
						this._logService.error(err, `Got invalid JSON for tool call: ${call.arguments}`);
						throw new Error('Invalid JSON for tool call');
					}
				}
			}

			if (delta.statefulMarker) {
				progress.report(
					new vscode.LanguageModelDataPart(encodeStatefulMarker(endpoint.model, delta.statefulMarker), CustomDataPartMimeTypes.StatefulMarker)
				);
			}

			return undefined;
		};
		return this._provideLanguageModelResponse(endpoint, messages, options, extensionId, finishCallback, token);
	}

	async provideTokenCount(endpoint: IEndpoint, message: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2): Promise<number> {
		if (typeof message === 'string') {
			return endpoint.acquireTokenizer().tokenLength(message);
		} else {
			let raw: Raw.ChatMessage;

			const content = message.content.map((part): Raw.ChatCompletionContentPart | undefined => {
				if (part instanceof vscode.LanguageModelTextPart) {
					return { type: Raw.ChatCompletionContentPartKind.Text, text: part.value };
				} else if (isImageDataPart(part)) {
					return { type: Raw.ChatCompletionContentPartKind.Image, imageUrl: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64url')}` } };
				} else {
					return undefined;
				}
			}).filter(isDefined);
			switch (message.role) {
				case vscode.LanguageModelChatMessageRole.User:
					raw = { role: Raw.ChatRole.User, content, name: message.name };
					break;
				case vscode.LanguageModelChatMessageRole.System:
					raw = { role: Raw.ChatRole.Assistant, content, name: message.name };
					break;
				case vscode.LanguageModelChatMessageRole.Assistant:
					raw = {
						role: Raw.ChatRole.Assistant,
						content,
						name: message.name,
						toolCalls: message.content
							.filter(part => part instanceof vscode.LanguageModelToolCallPart)
							.map(part => part as vscode.LanguageModelToolCallPart)
							.map(part => ({ function: { name: part.name, arguments: JSON.stringify(part.input) }, id: part.callId, type: 'function' })),
					};
					break;
				default:
					return 0;
			}

			return endpoint.acquireTokenizer().countMessageTokens(raw);
		}
	}

	private validateTools(tools: readonly vscode.LanguageModelChatTool[]): void {
		for (const tool of tools) {
			if (!tool.name.match(/^[\w-]+$/)) {
				throw new Error(`Invalid tool name "${tool.name}": only alphanumeric characters, hyphens, and underscores are allowed.`);
			}
		}
	}

	private async countToolTokens(endpoint: IChatEndpoint, tools: readonly vscode.LanguageModelChatTool[]): Promise<number> {
		return await endpoint.acquireTokenizer().countToolTokens(tools);
	}

	private validateRequest(_messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>): void {
		const lastMessage = _messages.at(-1);
		if (!lastMessage) {
			throw new Error('Invalid request: no messages.');
		}

		_messages.forEach((message, i) => {
			if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
				// Filter out DataPart since it does not share the same value type and does not have callId, function, etc.
				const filteredContent = message.content.filter(part => part instanceof vscode.LanguageModelDataPart);
				const toolCallIds = new Set(filteredContent
					.filter(part => part instanceof vscode.LanguageModelToolCallPart)
					.map(part => part.callId));
				let nextMessageIdx = i + 1;
				const errMsg = 'Invalid request: Tool call part must be followed by a User message with a LanguageModelToolResultPart with a matching callId.';
				while (toolCallIds.size > 0) {
					const nextMessage = _messages.at(nextMessageIdx++);
					if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
						throw new Error(errMsg);
					}

					nextMessage.content.forEach(part => {
						if (!(part instanceof vscode.LanguageModelToolResultPart2 || part instanceof vscode.LanguageModelToolResultPart)) {
							throw new Error(errMsg);
						}

						toolCallIds.delete(part.callId);
					});
				}
			}
		});
	}
}


function or(...checks: ((value: unknown) => boolean)[]): (value: unknown) => boolean {
	return (value) => checks.some(check => check(value));
}

class LanguageModelOptions {

	private static _defaultDesc: Record<string, (value: unknown) => boolean> = {
		stop: or(isStringArray, isString),
		temperature: isNumber,
		max_tokens: isNumber,
		frequency_penalty: isNumber,
		presence_penalty: isNumber,
	};

	static Default = new LanguageModelOptions({ ...this._defaultDesc });

	constructor(private _description: Record<string, (value: unknown) => boolean>) { }

	convert(options: { [name: string]: unknown }): Record<string, number | boolean | string> {
		const result: Record<string, number | boolean | string> = {};
		for (const key in this._description) {
			const isValid = this._description[key];
			const value = options[key];
			if (value !== null && value !== undefined && isValid(value)) {
				// Type guards ensure we only add values of the correct type
				if (isNumber(value) || isBoolean(value) || isString(value)) {
					result[key] = value;
				}
			}
		}
		return result;
	}
}
