/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AiDeploymentStatus } from '@sap-ai-sdk/ai-api';
import { OrchestrationClient, OrchestrationModuleConfig, Prompt } from "@sap-ai-sdk/orchestration";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CancellationToken, ChatResponseFragment2, ChatResponseProviderMetadata, Disposable, LanguageModelChatMessage, LanguageModelChatMessageRole, LanguageModelChatProvider, LanguageModelChatRequestOptions, LanguageModelTextPart, Progress, lm } from "vscode";
import { ILogService } from "../../../platform/log/common/logService";
import { APIUsage } from "../../../platform/networking/common/openai";
import { RecordedProgress } from "../../../util/common/progressRecorder";
import { toErrorMessage } from "../../../util/vs/base/common/errorMessage";
import { IInstantiationService } from "../../../util/vs/platform/instantiation/common/instantiation";
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities, BYOKModelConfig, BYOKModelRegistry, chatModelInfoToProviderMetadata, isNoAuthConfig, resolveModelInfo } from "../common/byokProvider";
import { getDeployments } from './sapaicoreUtils';

const AI_CORE_CREDS_FILENAME = "ai-core-creds.json";
const DEFAULT_MODEL = "gpt-4o";

/**
 * Loads AI Core credentials from the user's home directory
 * @returns The credentials as a JSON string or undefined if not found
 */
function loadAiCoreCredentials(): string | undefined {
	const credsFilePath = path.join(os.homedir(), AI_CORE_CREDS_FILENAME);
	if (!fs.existsSync(credsFilePath)) { return undefined; }
	const fileContents = fs.readFileSync(credsFilePath, "utf-8");
	try {
		const parsed = JSON.parse(fileContents);
		const missing = [];
		if (!parsed.clientid) { missing.push("clientid"); }
		if (!parsed.clientsecret) { missing.push("clientsecret"); }
		if (!parsed.url) { missing.push("url"); }
		if (!parsed.serviceurls || !parsed.serviceurls.AI_API_URL) { missing.push("serviceurls.AI_API_URL"); }
		if (missing.length > 0) { throw new Error(`Missing: ${missing.join(", ")}`); }
		return JSON.stringify(parsed);
	} catch (e) {
		throw new Error("Failed to parse ai core credentials file: " + (e as any));
	}
}

/**
 * Sets up the environment variable for AI Core credentials
 * @throws Error if credentials cannot be loaded
 */
function setupAiCoreEnv() {

	if (process.env["AICORE_SERVICE_KEY"]) {
		// Already set, no need to load again
		return;
	}

	let creds: string | undefined;
	try {
		creds = loadAiCoreCredentials();
	} catch (err) {
		throw new Error(`Failed to load AI Core credentials: ${err}`);
	}
	process.env["AICORE_SERVICE_KEY"] = creds;
}


export class SAPAICoreModelRegistry implements BYOKModelRegistry {
	public readonly authType = BYOKAuthType.None;
	public readonly name = "SAPAICore";
	private _knownModels: BYOKKnownModels | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) { }

	async getAllModels(): Promise<{ id: string; name: string }[]> {
		try {

			// Verify credentials can be loaded
			setupAiCoreEnv();

			const deployments = await getDeployments('default', 'RUNNING' as AiDeploymentStatus);
			const modelNames = new Set<string>();

			for (const dep of deployments.resources || []) {
				const name = dep.details?.resources?.backendDetails?.model?.name || dep.details?.resources?.backend_details?.model?.name;
				if (name && !name.toLowerCase().includes('embedding')) {
					modelNames.add(name);
				}
			}

			const models = Array.from(modelNames).map(name => ({
				id: name,
				name: `${name}`
			}));

			// Fallback to default if none found. Kept this in case we want to show static list of models later
			if (models.length === 0) {
				return [
					{ id: DEFAULT_MODEL, name: `${DEFAULT_MODEL} (SAP AI Core)` }
				];
			}
			return models;
		} catch (error) {
			this._logService.logger.error(error, `Error fetching available ${this.name} models`);
			throw new Error(error.message ? error.message : error);
		}
	}

	updateKnownModelsList(knownModels: BYOKKnownModels | undefined): void {
		this._knownModels = knownModels;
	}

	async registerModel(config: BYOKModelConfig): Promise<Disposable> {
		if (!isNoAuthConfig(config)) {
			throw new Error('Incorrect configuration passed to SAP AI Core provider');
		}

		try {
			// Verify credentials can be loaded
			setupAiCoreEnv();

			// Create default capabilities for SAP AI Core models if none provided
			const defaultCapabilities: BYOKModelCapabilities = {
				name: `${config.modelId} (SAP AI Core)`,
				maxInputTokens: 100000,
				maxOutputTokens: 8192,
				toolCalling: true, // Enable tool calling
				vision: false // SAP AI Core doesn't support vision yet
			};

			// Use provided capabilities or default ones
			const capabilities = config.capabilities || defaultCapabilities;
			const modelInfo = resolveModelInfo(config.modelId, this.name, this._knownModels, capabilities);
			const modelMetadata = chatModelInfoToProviderMetadata(modelInfo);

			const provider = this._instantiationService.createInstance(SAPAICoreProvider, config.modelId, modelMetadata);

			const disposable = lm.registerChatModelProvider(
				`${this.name}-${config.modelId}`,
				provider,
				modelMetadata
			);
			return disposable;
		} catch (e) {
			this._logService.logger.error(`Error registering ${this.name} model ${config.modelId}: ${e}`);
			throw e;
		}
	}
}

export class SAPAICoreProvider implements LanguageModelChatProvider {
	private modelId: string;

	constructor(
		modelId: string,
		private readonly _modelMetadata: ChatResponseProviderMetadata,
		@ILogService private readonly _logService: ILogService,
	) {
		// Ensure credentials are loaded
		setupAiCoreEnv();
		this.modelId = modelId;
		// Add log for model metadata
		this._logService.logger.info(`SAPAICoreProvider initialized for model ${modelId} with metadata: ${JSON.stringify(this._modelMetadata)}`);
	}

	async provideLanguageModelResponse(
		messages: LanguageModelChatMessage[],
		options: LanguageModelChatRequestOptions,
		extensionId: string,
		progress: Progress<ChatResponseFragment2>,
		token: CancellationToken
	): Promise<void> {
		// Convert VSCode messages to SAP AI Core format
		const aiCoreMessages = messages.map((msg) => {
			let role: "user" | "assistant" = "user";
			if (msg.role === LanguageModelChatMessageRole.Assistant) { role = "assistant"; }
			if (msg.role === LanguageModelChatMessageRole.User) { role = "user"; }

			let content = "";
			if (Array.isArray(msg.content)) {
				content = msg.content
					.map(part => {
						if (typeof part === "string") { return part; }
						if (typeof part === "object" && part !== null) {
							// Handle { value: string }
							if ("value" in part && typeof (part as any).value === "string") { return (part as any).value; }
							// Handle { text: string }
							if ("text" in part && typeof (part as any).text === "string") { return (part as any).text; }
						}
						return "";
					})
					.join("\n");
			} else if (typeof msg.content === "object" && msg.content !== null) {
				if ("value" in msg.content && typeof (msg.content as any).value === "string") {
					content = (msg.content as any).value;
				} else if ("text" in msg.content && typeof (msg.content as any).text === "string") {
					content = (msg.content as any).text;
				}
			} else if (typeof msg.content === "string") {
				content = msg.content;
			}
			return { role, content };
		});


		// No request logging for simplicity

		// Prepare prompt and config
		const prompt: Prompt = {
			messages: [aiCoreMessages[aiCoreMessages.length - 1]],
			messagesHistory: aiCoreMessages.slice(0, -1)
		};
		const maxTokens = (options as any).maxTokens || (options as any).modelOptions?.maxTokens || 4096;
		const config: OrchestrationModuleConfig = {
			llm: {
				model_name: this.modelId,
				model_params: { max_tokens: maxTokens }
			},
			templating: { tools: [] }
		};

		const wrappedProgress = new RecordedProgress(progress);

		try {
			const client = new OrchestrationClient(config);
			let response;

			try {
				response = await client.chatCompletion(prompt);
			} catch (e) {
				wrappedProgress.report({ index: 0, part: new LanguageModelTextPart("SAP AI Core error: " + (e as any).message) });
				throw e;
			}

			const content = response.getContent() || "";
			const textContent = typeof content === "string" ? content : JSON.stringify(content);
			wrappedProgress.report({ index: 0, part: new LanguageModelTextPart(textContent) });

			// Estimate token usage since SAP AI Core doesn't provide it
			const usage: APIUsage = {
				prompt_tokens: this._estimateTokenCount(aiCoreMessages.map(m => m.content).join(" ")),
				completion_tokens: this._estimateTokenCount(textContent),
				total_tokens: 0,
				prompt_tokens_details: {
					cached_tokens: 0
				}
			};
			usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

			// No request logging for simplicity
		} catch (err) {
			this._logService.logger.error(`SAP AI Core error: ${toErrorMessage(err, true)}`);
			throw err;
		}
	}

	async provideTokenCount(message: string | LanguageModelChatMessage): Promise<number> {
		return this._estimateTokenCount(message);
	}

	private _estimateTokenCount(message: string | LanguageModelChatMessage): number {
		if (typeof message === "string") { return Math.ceil(message.length / 4); }
		if (message && Array.isArray((message as any).content)) {
			const arr: any[] = Array.isArray((message as any).content) ? (message as any).content : [];
			if (arr.length === 0) { return 0; }
			return arr
				.map((part: any) => typeof part === "string" ? part.length : (typeof part.text === "string" ? part.text.length : 0))
				.reduce((a: number, b: number) => a + b, 0) / 4;
		}
		return 0;
	}
}
