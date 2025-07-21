/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AiDeploymentStatus } from '@sap-ai-sdk/ai-api';
import { OrchestrationClient, OrchestrationModuleConfig, Prompt, ChatCompletionTool, MessageToolCall } from "@sap-ai-sdk/orchestration";

import { CancellationToken, ChatResponseFragment2, ChatResponseProviderMetadata, Disposable, LanguageModelChatMessage, LanguageModelChatMessageRole, LanguageModelChatProvider, LanguageModelChatRequestOptions, LanguageModelChatTool, LanguageModelTextPart, LanguageModelToolCallPart, Progress, lm } from "vscode";
import { ILogService } from "../../../platform/log/common/logService";
import { RecordedProgress } from "../../../util/common/progressRecorder";
import { IInstantiationService } from "../../../util/vs/platform/instantiation/common/instantiation";
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities, BYOKModelConfig, BYOKModelRegistry, chatModelInfoToProviderMetadata, isNoAuthConfig, resolveModelInfo } from "../common/byokProvider";
import { ensureAiCoreEnv, getDeployments, sanitizeToolName } from './sapaicoreUtils';

const DEFAULT_MODEL = "gpt-4o";

// --- Utility Functions ---
function flattenSystemMessages(messages: LanguageModelChatMessage[]): string {
	return messages
		.filter(m => m.role === LanguageModelChatMessageRole.System)
		.map(m =>
			Array.isArray(m.content)
				? m.content.map((p: any) => p.value ?? "").join(" ")
				: (typeof m.content === "string" ? m.content : "")
		)
		.join(" ");
}

// --- Registry ---

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
			ensureAiCoreEnv();
			const deployments = await getDeployments('default', 'RUNNING' as AiDeploymentStatus);
			const names = new Set<string>();
			for (const dep of deployments.resources ?? []) {
				const name = dep.details?.resources?.backendDetails?.model?.name
					|| dep.details?.resources?.backend_details?.model?.name;
				if (name && !name.toLowerCase().includes("embedding")) { names.add(name); }
			}
			const models = Array.from(names).map(name => ({ id: name, name }));
			return models.length ? models : [{ id: DEFAULT_MODEL, name: `${DEFAULT_MODEL} (SAP AI Core)` }];
		} catch (error) {
			this._logService.logger.error(error, `Error fetching available ${this.name} models`);
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	updateKnownModelsList(knownModels: BYOKKnownModels | undefined): void {
		this._knownModels = knownModels;
	}

	async registerModel(config: BYOKModelConfig): Promise<Disposable> {
		if (!isNoAuthConfig(config)) { throw new Error('Incorrect configuration for SAP AI Core provider'); }

		const defaultCaps: BYOKModelCapabilities = {
			name: `${config.modelId} (SAP AI Core)`,
			maxInputTokens: 100_000,
			maxOutputTokens: 8192,
			toolCalling: true,
			vision: false
		};
		const capabilities = config.capabilities || defaultCaps;
		const info = resolveModelInfo(config.modelId, this.name, this._knownModels, capabilities);
		const meta = chatModelInfoToProviderMetadata(info);
		const provider = this._instantiationService.createInstance(SAPAICoreProvider, config.modelId, meta);

		return lm.registerChatModelProvider(
			`${this.name}-${config.modelId}`,
			provider,
			meta
		);
	}
}

// --- Provider ---

export class SAPAICoreProvider implements LanguageModelChatProvider {
	constructor(
		private readonly modelId: string,
		private readonly _modelMetadata: ChatResponseProviderMetadata,
		@ILogService private readonly _logService: ILogService,
	) {
		console.log(`SAPAICoreProvider initialized for model: ${this.modelId} (${this._modelMetadata.name})`);
	}

	private static extractToolMessage(msg: any): { callId: string; content: string } | undefined {
		// Detect tool call result in VSCode Copilot format
		if (Array.isArray(msg.c) && msg.c[0]?.callId) {
			const callId = msg.c[0].callId;
			const content = (msg.c[0].content || []).map((p: any) => p.value ?? "").join("");
			return { callId, content };
		}
		return undefined;
	}

	private static toolCallPartsFromContent(parts: any[]): any[] {
		return parts
			.filter((p: any) => p instanceof LanguageModelToolCallPart)
			.map((p: LanguageModelToolCallPart) => ({
				id: p.callId,
				type: "function",
				function: {
					name: p.name,
					arguments: JSON.stringify(p.input)
				}
			}));
	}

	private apiMessagesToAICore(messages: LanguageModelChatMessage[]): { messages: any[]; system: string } {
		const aiCoreMessages: any[] = [];
		const system = flattenSystemMessages(messages);

		for (const msg of messages) {
			if (msg.role === LanguageModelChatMessageRole.System) { continue; }

			// Tool result detection
			const toolMsg = SAPAICoreProvider.extractToolMessage(msg);
			if (toolMsg) {
				aiCoreMessages.push({
					role: "tool",
					tool_call_id: toolMsg.callId,
					content: toolMsg.content
				});
				continue;
			}

			// User or Assistant
			const isAssistant = msg.role === LanguageModelChatMessageRole.Assistant;
			const base: any = {
				role: isAssistant ? "assistant" : "user",
				content: Array.isArray(msg.content)
					? msg.content.map((p: any) => p.value ?? "").join("")
					: (typeof msg.content === "string" ? msg.content : "")
			};

			if (isAssistant && Array.isArray(msg.content)) {
				const toolCalls = SAPAICoreProvider.toolCallPartsFromContent(msg.content);
				if (toolCalls.length) { base["tool_calls"] = toolCalls; }
			}
			aiCoreMessages.push(base);
		}
		return { messages: aiCoreMessages, system };
	}

	async provideLanguageModelResponse(
		messages: LanguageModelChatMessage[],
		options: LanguageModelChatRequestOptions,
		extensionId: string,
		progress: Progress<ChatResponseFragment2>,
		token: CancellationToken
	): Promise<void> {
		ensureAiCoreEnv();
		const wrappedProgress = new RecordedProgress(progress);

		const { messages: aiCoreMessages } = this.apiMessagesToAICore(messages);
		const tools = this.convertTools(options.tools);

		const maxTokens = (options as any).maxTokens || (options as any).modelOptions?.maxTokens || 4096;
		const config: OrchestrationModuleConfig = {
			llm: {
				model_name: this.modelId,
				model_params: { max_tokens: maxTokens }
			},
			templating: { tools }
		};
		const client = new OrchestrationClient(config);

		const prompt: Prompt = {
			messages: [aiCoreMessages[aiCoreMessages.length - 1]],
			messagesHistory: aiCoreMessages.slice(0, -1)
		};

		try {
			const response = await client.chatCompletion(prompt);
			const content = response.getContent() || "";
			if (content) { wrappedProgress.report({ index: 0, part: new LanguageModelTextPart(content) }); }

			const toolCalls = response.getToolCalls();
			if (toolCalls?.length) {
				for (const toolCall of this.parseToolsResponse(toolCalls)) {
					wrappedProgress.report({ index: 0, part: toolCall });
				}
			}
		} catch (e: any) {
			const msg = "SAP AI Core error: " + (e?.message || String(e));
			wrappedProgress.report({ index: 0, part: new LanguageModelTextPart(msg) });
			this._logService.logger.error(e, msg);
			throw e;
		}
	}

	private convertTools(tools?: LanguageModelChatTool[]): ChatCompletionTool[] {
		return (tools ?? []).map(tool => ({
			type: "function",
			function: {
				name: sanitizeToolName(tool.name),
				description: tool.description,
				parameters: tool.inputSchema || { type: "object", properties: {}, required: [] }
			}
		}));
	}

	private parseToolsResponse(toolCalls: MessageToolCall[]): LanguageModelToolCallPart[] {
		if (!toolCalls?.length) { return []; }
		return toolCalls.map(tool => {
			let parsedArguments: any = {};
			try {
				parsedArguments = typeof tool.function.arguments === "string"
					? JSON.parse(tool.function.arguments)
					: tool.function.arguments;
			} catch (e) {
				this._logService.logger.warn(`Failed to parse tool arguments: ${tool.function.arguments}`);
			}
			return new LanguageModelToolCallPart(tool.id, tool.function.name, parsedArguments);
		});
	}

	async provideTokenCount(message: string | LanguageModelChatMessage): Promise<number> {
		if (typeof message === "string") { return Math.ceil(message.length / 4); }
		const content = (message as any).content;
		if (Array.isArray(content)) {
			return content
				.map((part: any) => typeof part === "string" ? part.length : (typeof part.text === "string" ? part.text.length : 0))
				.reduce((a: number, b: number) => a + b, 0) / 4;
		}
		return 0;
	}
}
