/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Delayer } from '../../../util/vs/base/common/async';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Disposable, IDisposable, MutableDisposable } from '../../../util/vs/base/common/lifecycle';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { PromptTags } from '../../xtab/common/tags';

const MIN_INPUT_LENGTH = 3;

const MAX_COMPLETION_LENGTH = 80;

const MAX_COMPLETION_WORDS = 8;

export namespace ChatInputPromptTags {
	export const CURRENT_INPUT = PromptTags.createTag('current_input');
	export const OPENED_FILES = PromptTags.createTag('opened_files');
	export const CUSTOM_INSTRUCTIONS = PromptTags.createTag('custom_instructions');
	export const ACTIVE_SELECTION = PromptTags.createTag('active_selection');
}

const enum TelemetryEvent {
	Request = 'chatInlineCompletions/request',
	Suggestion = 'chatInlineCompletions/suggestion',
	Error = 'chatInlineCompletions/error',
}

/**
 * Provider that supplies inline completion suggestions for chat input.
 * Uses AI to predict what the developer will type next in their prompt to Copilot.
 */
export class ChatInputCompletionProvider implements vscode.ChatInlineCompletionItemProvider, IDisposable {
	private readonly delayer: Delayer<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined>;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICustomInstructionsService private readonly customInstructionsService: ICustomInstructionsService,
		@ITabsAndEditorsService private readonly tabsAndEditorsService: ITabsAndEditorsService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		const debounceMs = this.configurationService.getConfig(ConfigKey.TeamInternal.ChatInlineCompletionsDebounceMs);
		this.delayer = new Delayer(debounceMs);
	}

	async provideChatInlineCompletionItems(
		input: string,
		position: number,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
		// Only provide suggestions when there's some input and we're at the end
		if (!input || input.length === 0 || position !== input.length) {
			return undefined;
		}

		if (input.trim().length < MIN_INPUT_LENGTH) {
			return undefined;
		}

		// Use debouncing to avoid excessive API calls during rapid typing
		try {
			return await this.delayer.trigger(async () => {
				if (token.isCancellationRequested) {
					return undefined;
				}
				return this.doProvideCompletions(input, token);
			});
		} catch (error) {
			if (error instanceof CancellationError) {
				return undefined;
			}
			throw error;
		}
	}

	private async doProvideCompletions(
		input: string,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
		const stopWatch = StopWatch.create();

		try {
			const modelFamily = this.configurationService.getConfig(ConfigKey.TeamInternal.ChatInlineCompletionsModelFamily);

			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: modelFamily
			});

			if (models.length === 0) {
				this.logService.warn('[ChatInlineCompletions] No suitable chat models available.');
				return undefined;
			}

			const model = models[0];

			const [instructionsContent, openedFilesContent, selectionContent] = await Promise.all([
				this.getCustomInstructionsContent(),
				this.getOpenedFilesContent(),
				this.getActiveSelectionContent(),
			]);

			const systemPrompt = this.buildSystemPrompt();
			const userPrompt = this.buildUserPrompt(input, instructionsContent, openedFilesContent, selectionContent);

			const messages = [
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, systemPrompt),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, userPrompt)
			];

			this.telemetryService.sendInternalMSFTTelemetryEvent(TelemetryEvent.Request, {
				inputLength: String(input.length),
				modelFamily,
				hasInstructions: String(!!instructionsContent),
				hasOpenedFiles: String(!!openedFilesContent),
				hasSelection: String(!!selectionContent),
			});

			const response = await model.sendRequest(messages, {
				justification: l10n.t('Providing inline chat input completion suggestions')
			}, token);

			const completionText = await this.collectAndCleanResponse(response.stream, token);

			if (!completionText) {
				return undefined;
			}

			const latencyMs = stopWatch.elapsed();
			this.logService.trace(`[ChatInlineCompletions] Suggesting: "${completionText}" (${latencyMs}ms)`);

			this.telemetryService.sendInternalMSFTTelemetryEvent(TelemetryEvent.Suggestion, {
				completionLength: String(completionText.length),
			}, {
				latencyMs,
			});

			const suggestion = new vscode.InlineCompletionItem(completionText);
			return [suggestion];
		} catch (error) {
			const latencyMs = stopWatch.elapsed();
			this.logService.error('[ChatInlineCompletions] Error generating suggestion:', error);

			this.telemetryService.sendInternalMSFTTelemetryEvent(TelemetryEvent.Error, {
				errorMessage: error instanceof Error ? error.message : String(error),
			}, {
				latencyMs,
			});

			return undefined;
		}
	}

	private buildSystemPrompt(): string {
		return `Predict what a developer will type next in their GitHub Copilot Chat prompt, following Microsoft content policies and avoiding copyright violations. If a request may breach guidelines, reply: "Sorry, I can't assist with that."

Your task is to complete the developer's thought with 1-${MAX_COMPLETION_WORDS} words that naturally continue their request.

CRITICAL RULES:
1. Be CONCISE - suggest only 1-${MAX_COMPLETION_WORDS} words max
2. Do NOT repeat context that is always provided via "custom_instructions", e.g. test frameworks, coding style

Good examples:
- "write unit" → " tests for Calculator class"
- "refactor this" → " to use async/await"
- "explain how" → " authentication works"
- "add error" → " handling to login"
- "fix the" → " null pointer bug"

Return ONLY the completion text - no quotes, no explanations, no meta-commentary.`;
	}

	private buildUserPrompt(
		input: string,
		instructionsContent: string | undefined,
		openedFilesContent: string | undefined,
		selectionContent: string | undefined
	): string {
		const instructionsSection = instructionsContent
			? `${ChatInputPromptTags.CUSTOM_INSTRUCTIONS.start}
${instructionsContent}
${ChatInputPromptTags.CUSTOM_INSTRUCTIONS.end}

`
			: '';

		const openedFilesSection = openedFilesContent
			? `${ChatInputPromptTags.OPENED_FILES.start}
${openedFilesContent}
${ChatInputPromptTags.OPENED_FILES.end}

`
			: '';

		const selectionSection = selectionContent
			? `${ChatInputPromptTags.ACTIVE_SELECTION.start}
${selectionContent}
${ChatInputPromptTags.ACTIVE_SELECTION.end}

`
			: '';

		return `The developer is typing a prompt in GitHub Copilot Chat.

${instructionsSection}${openedFilesSection}${selectionSection}${ChatInputPromptTags.CURRENT_INPUT.start}
${input}${PromptTags.CURSOR}
${ChatInputPromptTags.CURRENT_INPUT.end}
`;
	}

	private async getCustomInstructionsContent(): Promise<string | undefined> {
		try {
			const instructionUris = await this.customInstructionsService.getAgentInstructions();
			if (instructionUris.length === 0) {
				return undefined;
			}

			const allInstructions: string[] = [];
			const hasSeen = new Set<string>();

			for (const instructionUri of instructionUris) {
				const uriString = instructionUri.toString();
				if (hasSeen.has(uriString)) {
					continue;
				}
				hasSeen.add(uriString);

				const instructions = await this.customInstructionsService.fetchInstructionsFromFile(instructionUri);
				if (instructions && instructions.content.length > 0) {
					const instructionText = instructions.content
						.map(inst => inst.instruction)
						.join('\n')
						.trim();
					if (instructionText) {
						allInstructions.push(instructionText);
					}
				}
			}

			return allInstructions.length > 0 ? allInstructions.join('\n\n') : undefined;
		} catch (error) {
			this.logService.trace(`[ChatInlineCompletions] Failed to load custom instructions: ${error}`);
			return undefined;
		}
	}

	/**
	 * Gets the active text selection from the current editor.
	 */
	private async getActiveSelectionContent(): Promise<string | undefined> {
		try {
			const activeEditor = this.tabsAndEditorsService.activeTextEditor;

			if (!activeEditor) {
				return undefined;
			}

			const selection = activeEditor.selection;

			// Only include non-empty selections
			if (!selection || selection.isEmpty) {
				return undefined;
			}

			const doc = activeEditor.document;
			const uri = URI.from(doc.uri);
			const filePath = this.workspaceService.asRelativePath(vscode.Uri.from(uri), false);
			const languageId = doc.languageId;

			const selectedText = doc.getText(selection);

			if (!selectedText.trim()) {
				return undefined;
			}

			// Limit selection size to avoid overly long context
			const maxLines = 50;
			const lines = selectedText.split('\n');
			const truncated = lines.length > maxLines;
			const textToInclude = truncated ? lines.slice(0, maxLines).join('\n') : selectedText;

			const truncatedNote = truncated ? ' (truncated)' : '';
			const startLine = selection.start.line + 1;
			const endLine = selection.end.line + 1;

			return `active_selection_file_path: ${filePath} (${languageId})${truncatedNote}
lines ${startLine}-${endLine}:
${textToInclude}`;
		} catch (error) {
			this.logService.trace(`[ChatInlineCompletions] Failed to gather active selection: ${error}`);
			return undefined;
		}
	}

	/**
	 * Gets information about opened files using ITabsAndEditorsService.
	 * Formats snippets with workspace-relative paths, applies line limits.
	 */
	private async getOpenedFilesContent(): Promise<string | undefined> {
		try {
			const visibleEditors = this.tabsAndEditorsService.visibleTextEditors;

			if (visibleEditors.length === 0) {
				return undefined;
			}

			const maxFiles = 5;
			const maxLinesPerFile = 20; // Limit snippet size
			const editorsToInclude = visibleEditors.slice(0, maxFiles);

			const snippets: string[] = [];

			for (const editor of editorsToInclude) {
				const doc = editor.document;
				const uri = URI.from(doc.uri);
				const filePath = this.workspaceService.asRelativePath(vscode.Uri.from(uri), false);

				const languageId = doc.languageId;

				// Get visible content from editor
				const visibleRange = editor.visibleRanges[0];
				if (visibleRange) {
					const startLine = visibleRange.start.line;
					const endLine = Math.min(visibleRange.end.line, startLine + maxLinesPerFile);
					const snippet = doc.getText(new vscode.Range(startLine, 0, endLine, 0)).trim();

					if (snippet) {
						// Format similar to Xtab's formatCodeSnippet
						const truncated = doc.lineCount > maxLinesPerFile ? ' (truncated)' : '';
						snippets.push(`opened_file_path: ${filePath} (${languageId})${truncated}\n${snippet}`);
					}
				}
			}

			if (snippets.length === 0) {
				return undefined;
			}

			return snippets.join('\n\n');
		} catch (error) {
			this.logService.trace(`[ChatInlineCompletions] Failed to gather opened files context: ${error}`);
			return undefined;
		}
	}

	private async collectAndCleanResponse(
		stream: AsyncIterable<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | unknown>,
		token: vscode.CancellationToken
	): Promise<string | undefined> {
		let completionText = '';

		for await (const part of stream) {
			if (token.isCancellationRequested) {
				return undefined;
			}

			if (part instanceof vscode.LanguageModelTextPart) {
				completionText += part.value;
			}
		}

		return this.cleanupCompletionText(completionText);
	}

	/**
	 * Cleans up the completion text by removing quotes, trimming, and enforcing limits.
	 * Ensures completions are concise and ready for display.
	 */
	private cleanupCompletionText(text: string): string | undefined {
		text = text.trim();

		// Remove quotes if the model added them
		if (text.startsWith('"') && text.endsWith('"')) {
			text = text.slice(1, -1);
		}
		if (text.startsWith('\'') && text.endsWith('\'')) {
			text = text.slice(1, -1);
		}

		if (!text) {
			return undefined;
		}

		// Enforce word limit for concise suggestions
		const words = text.split(/\s+/);
		if (words.length > MAX_COMPLETION_WORDS) {
			text = words.slice(0, MAX_COMPLETION_WORDS).join(' ');
		}

		// Limit the completion length to keep it reasonable
		if (text.length > MAX_COMPLETION_LENGTH) {
			text = truncateAtWordBoundary(text, MAX_COMPLETION_LENGTH);
		}

		return text.length > 0 ? text : undefined; // Don't return an empty string
	}

	dispose(): void {
		this.delayer.dispose();
	}
}

/**
 * Truncates text at a word boundary if possible, avoiding cutting words in half.
 * Falls back to hard truncation if no suitable word boundary is found in the first half.
 */
function truncateAtWordBoundary(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}

	const truncated = text.substring(0, maxLength);
	const lastSpace = truncated.lastIndexOf(' ');

	// Only truncate at word boundary if it's reasonably close to the max length
	// (more than halfway through), otherwise just do a hard truncate
	if (lastSpace > maxLength / 2) {
		return truncated.substring(0, lastSpace);
	}
	return truncated;
}

export class ChatInlineCompletionsContribution extends Disposable implements IExtensionContribution {
	readonly id = 'ChatInlineCompletions';

	private readonly providerDisposable = this._register(new MutableDisposable<vscode.Disposable>());

	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this.updateRegistration();

		// Support live toggling without requiring reload
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.ChatInlineCompletionsEnabled.fullyQualifiedId)) {
				this.updateRegistration();
			}
		}));
	}

	private updateRegistration(): void {
		const enabled = this.configurationService.getConfig(ConfigKey.ChatInlineCompletionsEnabled);

		if (enabled && !this.providerDisposable.value) {
			this.logService.info('[ChatInlineCompletions] Registering chat input completions provider');
			const provider = this.instantiationService.createInstance(ChatInputCompletionProvider);
			this.providerDisposable.value = vscode.chat.registerChatInlineCompletionItemProvider(provider);
		} else if (!enabled && this.providerDisposable.value) {
			this.logService.info('[ChatInlineCompletions] Unregistering chat input completions provider');
			this.providerDisposable.clear();
		}
	}
}
