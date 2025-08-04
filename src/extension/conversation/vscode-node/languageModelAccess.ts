/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Raw } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IBlockedExtensionService } from '../../../platform/chat/common/blockedExtensionService';
import { ChatFetchResponseType, ChatLocation, getErrorDetailsFromChatFetchError } from '../../../platform/chat/common/commonTypes';
import { getTextPart } from '../../../platform/chat/common/globalStringUtils';
import { EmbeddingType, getWellKnownEmbeddingTypeInfo, IEmbeddingsComputer } from '../../../platform/embeddings/common/embeddingsComputer';
import { AutoChatEndpoint, isAutoModeEnabled } from '../../../platform/endpoint/common/autoChatEndpoint';
import { IAutomodeService } from '../../../platform/endpoint/common/automodeService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OpenAiFunctionTool, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IChatEndpoint, IEndpoint } from '../../../platform/networking/common/networking';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { BaseTokensPerCompletion } from '../../../platform/tokenizer/node/tokenizer';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable, MutableDisposable } from '../../../util/vs/base/common/lifecycle';
import { isDefined, isNumber, isString, isStringArray } from '../../../util/vs/base/common/types';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { localize } from '../../../util/vs/nls';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtensionMode } from '../../../vscodeTypes';
import { IExtensionContribution } from '../../common/contributions';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { isImageDataPart } from '../common/languageModelChatMessageHelpers';
import { LanguageModelAccessPrompt } from './languageModelAccessPrompt';

export class LanguageModelAccess extends Disposable implements IExtensionContribution {

	readonly id = 'languageModelAccess';

	readonly activationBlocker?: Promise<any>;

	private readonly _onDidChange = this._register(new Emitter<void>());
	private _currentModels: vscode.LanguageModelChatInformation[] = []; // Store current models for reference
	private _chatEndpoints: IChatEndpoint[] = [];
	private _lmWrapper: CopilotLanguageModelWrapper;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
		@IVSCodeExtensionContext private readonly _vsCodeExtensionContext: IVSCodeExtensionContext,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IAutomodeService private readonly _automodeService: IAutomodeService,
		@IEnvService private readonly _envService: IEnvService
	) {
		super();

		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);

		if (this._vsCodeExtensionContext.extensionMode === ExtensionMode.Test) {
			this._logService.warn('[LanguageModelAccess] LanguageModels and Embeddings are NOT AVAILABLE in test mode.');
			return;
		}

		// initial
		this.activationBlocker = Promise.all([
			this._registerChatProvider(),
			this._registerEmbeddings(),
		]);
	}

	override dispose(): void {
		super.dispose();
	}

	get currentModels(): vscode.LanguageModelChatInformation[] {
		return this._currentModels;
	}

	private async _registerChatProvider(): Promise<void> {
		const provider: vscode.LanguageModelChatProvider2 = {
			onDidChange: this._onDidChange.event,
			prepareLanguageModelChat: this._prepareLanguageModelChat.bind(this),
			provideLanguageModelChatResponse: this._provideLanguageModelChatResponse.bind(this),
			provideTokenCount: this._provideTokenCount.bind(this)
		};
		this._register(vscode.lm.registerChatModelProvider('copilot', provider));
	}

	private async _prepareLanguageModelChat(options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		const session = await this._getAuthSession();
		if (!session) {
			this._currentModels = [];
			return [];
		}

		const models: vscode.LanguageModelChatInformation[] = [];
		const chatEndpoints = await this._endpointProvider.getAllChatEndpoints();

		const defaultChatEndpoint = chatEndpoints.find(e => e.isDefault) ?? await this._endpointProvider.getChatEndpoint('gpt-4.1') ?? chatEndpoints[0];
		if (isAutoModeEnabled(this._expService, this._envService)) {
			chatEndpoints.push(await this._automodeService.resolveAutoModeEndpoint(generateUuid(), chatEndpoints));
		}
		const seenFamilies = new Set<string>();

		for (const endpoint of chatEndpoints) {
			if (seenFamilies.has(endpoint.family) && !endpoint.showInModelPicker) {
				continue;
			}
			seenFamilies.add(endpoint.family);

			const sanitizedModelName = endpoint.name.replace(/\(Preview\)/g, '').trim();
			let modelDescription: string | undefined;
			if (endpoint.model === AutoChatEndpoint.id) {
				modelDescription = localize('languageModel.autoTooltip', 'Auto automatically selects the best model for your request based on current capacity. Auto is counted at a variable rate based on the model selected.');
			} else if (endpoint.multiplier) {
				modelDescription = localize('languageModel.costTooltip', '{0} ({1}) is counted at a {2}x rate.', sanitizedModelName, endpoint.version, endpoint.multiplier);
			} else if (endpoint.isFallback && endpoint.multiplier === 0) {
				modelDescription = localize('languageModel.baseTooltip', '{0} ({1}) does not count towards your premium request limit. This model may be slowed during times of high congestion.', sanitizedModelName, endpoint.version);
			} else {
				modelDescription = `${sanitizedModelName} (${endpoint.version})`;
			}

			let modelCategory: { label: string; order: number } | undefined;
			if (endpoint.model === AutoChatEndpoint.id) {
				modelCategory = { label: '', order: Number.MIN_SAFE_INTEGER };
			} else if (endpoint.isPremium === undefined || this._authenticationService.copilotToken?.isFreeUser) {
				modelCategory = { label: localize('languageModelHeader.copilot', "Copilot Models"), order: 0 };
			} else if (endpoint.isPremium) {
				modelCategory = { label: localize('languageModelHeader.premium', "Premium Models"), order: 1 };
			} else {
				modelCategory = { label: localize('languageModelHeader.standard', "Standard Models"), order: 0 };
			}

			const baseCount = await PromptRenderer.create(this._instantiationService, endpoint, LanguageModelAccessPrompt, { noSafety: false, messages: [] }).countTokens();
			let multiplierString = endpoint.multiplier !== undefined ? `${endpoint.multiplier}x` : undefined;
			if (endpoint.model === AutoChatEndpoint.id) {
				multiplierString = 'Variable';
			}

			const model: vscode.LanguageModelChatInformation = {
				id: endpoint.model,
				name: endpoint.model === AutoChatEndpoint.id ? 'Auto' : endpoint.name,
				family: endpoint.family,
				description: modelDescription,
				cost: multiplierString,
				category: modelCategory,
				version: endpoint.version,
				maxInputTokens: endpoint.modelMaxPromptTokens - baseCount - BaseTokensPerCompletion,
				maxOutputTokens: endpoint.maxOutputTokens,
				auth: session && { label: session.account.label },
				isDefault: endpoint === defaultChatEndpoint,
				isUserSelectable: endpoint.showInModelPicker,
				capabilities: {
					vision: endpoint.supportsVision,
					toolCalling: endpoint.supportsToolCalls,
				}
			};

			models.push(model);
		}

		this._currentModels = models;
		this._chatEndpoints = chatEndpoints;
		return models;
	}

	private async _provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>,
		options: vscode.LanguageModelChatRequestHandleOptions,
		progress: vscode.Progress<vscode.ChatResponseFragment2>,
		token: vscode.CancellationToken
	): Promise<any> {
		const endpoint = this._chatEndpoints.find(e => e.model === model.id);
		if (!endpoint) {
			throw new Error(`Endpoint not found for model ${model.id}`);
		}

		return this._lmWrapper.provideLanguageModelResponse(endpoint, messages, {
			...options,
			modelOptions: options.modelOptions
		}, options.extensionId, progress, token);
	}

	private async _provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2,
		token: vscode.CancellationToken
	): Promise<number> {
		const endpoint = this._chatEndpoints.find(e => e.model === model.id);
		if (!endpoint) {
			throw new Error(`Endpoint not found for model ${model.id}`);
		}

		return this._lmWrapper.provideTokenCount(endpoint, text);
	}

	private async _registerEmbeddings(): Promise<void> {

		const dispo = this._register(new MutableDisposable());


		const update = async () => {

			if (!await this._getAuthSession()) {
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
					const result = await embeddingsComputer.computeEmbeddings(embeddingType, input, { parallelism: 2 }, token);
					if (!result) {
						throw new Error('Failed to compute embeddings');
					}
					return result.values.map(embedding => ({ values: embedding.value.slice(0) }));
				}
			});
		};

		this._register(this._authenticationService.onDidAuthenticationChange(() => update()));
		await update();
	}

	private async _getAuthSession(): Promise<vscode.AuthenticationSession | undefined> {
		try {
			await this._authenticationService.getCopilotToken();
		} catch (e) {
			this._logService.warn('[LanguageModelAccess] LanguageModel/Embeddings are not available without auth token');
			this._logService.error(e);
			return undefined;
		}

		const session = this._authenticationService.anyGitHubSession;
		if (!session) {
			// At this point, we should have auth, but log just in case we don't so we have record of it
			this._logService.error('[LanguageModelAccess] Auth token not present when we expected it to be');
			return undefined;
		}

		return session;
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
		@IThinkingDataService private readonly _thinkingDataService: IThinkingDataService
	) {
		super();
	}

	private async _provideLanguageModelResponse(_endpoint: IChatEndpoint, _messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, _options: vscode.LanguageModelChatRequestOptions, extensionId: string, callback: FinishedCallback, token: vscode.CancellationToken): Promise<any> {

		const extensionInfo = vscode.extensions.getExtension(extensionId, true);
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

		const result = await endpoint.makeChatRequest('copilotLanguageModelWrapper', messages, callback, token, ChatLocation.Other, { extensionId }, options, true, telemetryProperties, { intent: true });

		if (result.type !== ChatFetchResponseType.Success) {
			if (result.type === ChatFetchResponseType.ExtensionBlocked) {
				this._blockedExtensionService.reportBlockedExtension(extensionId, result.retryAfter);
				throw vscode.LanguageModelError.Blocked(blockedExtensionMessage);
			} else if (result.type === ChatFetchResponseType.QuotaExceeded) {
				const details = getErrorDetailsFromChatFetchError(result, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const err = new vscode.LanguageModelError(details.message);
				err.name = 'ChatQuotaExceeded';
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

	async provideLanguageModelResponse(endpoint: IChatEndpoint, messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, options: vscode.LanguageModelChatRequestOptions, extensionId: string, progress: vscode.Progress<vscode.ChatResponseFragment2>, token: vscode.CancellationToken): Promise<any> {
		const finishCallback: FinishedCallback = async (_text, index, delta): Promise<undefined> => {
			if (delta.text) {
				progress.report({ index, part: new vscode.LanguageModelTextPart(delta.text) });
			}
			if (delta.copilotToolCalls) {
				for (const call of delta.copilotToolCalls) {
					try {
						const parameters = JSON.parse(call.arguments);
						progress.report({ index, part: new vscode.LanguageModelToolCallPart(call.id, call.name, parameters) });
					} catch (err) {
						this._logService.error(err, `Got invalid JSON for tool call: ${call.arguments}`);
						throw new Error('Invalid JSON for tool call');
					}
				}
			}
			if (delta.thinking) {
				// progress.report({ index, part: new vscode.LanguageModelThinkingPart(delta.thinking) });

				// @karthiknadig: remove this when LM API becomes available
				this._thinkingDataService.update(index, delta.thinking);
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

	private validateTools(tools: vscode.LanguageModelChatTool[]): void {
		for (const tool of tools) {
			if (!tool.name.match(/^[\w-]+$/)) {
				throw new Error(`Invalid tool name "${tool.name}": only alphanumeric characters, hyphens, and underscores are allowed.`);
			}
		}
	}

	private async countToolTokens(endpoint: IChatEndpoint, tools: vscode.LanguageModelChatTool[]): Promise<number> {
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


function or(...checks: ((value: any) => boolean)[]): (value: any) => boolean {
	return (value) => checks.some(check => check(value));
}

class LanguageModelOptions {

	private static _defaultDesc: Record<string, (value: any) => boolean> = {
		stop: or(isStringArray, isString),
		temperature: isNumber,
		max_tokens: isNumber,
		frequency_penalty: isNumber,
		presence_penalty: isNumber,
	};

	static Default = new LanguageModelOptions({ ...this._defaultDesc });

	constructor(private _description: Record<string, (value: any) => boolean>) { }

	convert(options: { [name: string]: any }): Record<string, number | boolean | string> {
		const result: Record<string, number | boolean | string> = {};
		for (const key in this._description) {
			const isValid = this._description[key];
			const value = options[key];
			if (value !== null && value !== undefined && isValid(value)) {
				result[key] = value;
			}
		}
		return result;
	}
}
