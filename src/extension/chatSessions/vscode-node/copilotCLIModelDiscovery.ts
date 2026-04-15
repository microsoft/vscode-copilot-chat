/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';

export const COPILOT_CLI_CHAT_SESSION_TYPE = 'copilotcli';

const LOCAL_MODEL_VENDOR = 'local';
const LOCAL_MODEL_FAMILY_PREFIX = 'local-ollama';
const MODEL_SURFACE_MARKER = '::surface=';
const MODEL_SURFACE_CHAT = 'chat';

type SessionScopedLanguageModelChatSelector = vscode.LanguageModelChatSelector & { chatSessionType?: string };

export interface CopilotCLIExternalModelDiscoveryResult {
	readonly models: readonly vscode.LanguageModelChat[];
	readonly sessionScopedCount: number;
	readonly legacyLocalCount: number;
}

export async function discoverCopilotCLIExternalModels(logService: ILogService, selector: vscode.LanguageModelChatSelector = {}): Promise<CopilotCLIExternalModelDiscoveryResult> {
	const [sessionScopedModels, legacyLocalModels] = await Promise.all([
		selectSessionScopedCopilotCLIChatModels(logService, selector),
		selectLegacyLocalCopilotCLIChatModels(logService, selector),
	]);

	const sessionScopedIds = new Set(sessionScopedModels.map(model => model.id));
	const dedupedLegacyModels = legacyLocalModels.filter(model => {
		if (!sessionScopedIds.has(model.id)) {
			return true;
		}

		logService.debug(`[CopilotCLI] Filtered out legacy local model ${model.id} because the session-scoped query already returned it.`);
		return false;
	});

	const mergedModels = dedupeModels([...sessionScopedModels, ...dedupedLegacyModels], logService, 'external model discovery');
	logService.debug(`[CopilotCLI] External model discovery counts: sessionScoped=${sessionScopedModels.length}, legacyLocal=${dedupedLegacyModels.length}, merged=${mergedModels.length}.`);

	return {
		models: mergedModels,
		sessionScopedCount: sessionScopedModels.length,
		legacyLocalCount: dedupedLegacyModels.length,
	};
}

export async function resolveCopilotCLIExternalModel(logService: ILogService, modelId: string): Promise<vscode.LanguageModelChat | undefined> {
	const discovery = await discoverCopilotCLIExternalModels(logService, { id: modelId });
	const model = discovery.models.find(candidate => candidate.id === modelId);
	if (model) {
		return model;
	}

	await logMissingCopilotCLIModelReason(logService, modelId);
	return undefined;
}

export function toCopilotCLIModelOptionItem(model: vscode.LanguageModelChat): vscode.ChatSessionProviderOptionItem {
	return {
		id: model.id,
		name: model.name,
		description: model.vendor === LOCAL_MODEL_VENDOR ? l10n.t('Local model') : l10n.t('Contributed model')
	};
}

async function selectSessionScopedCopilotCLIChatModels(logService: ILogService, selector: vscode.LanguageModelChatSelector): Promise<readonly vscode.LanguageModelChat[]> {
	const scopedSelector: SessionScopedLanguageModelChatSelector = {
		...selector,
		chatSessionType: COPILOT_CLI_CHAT_SESSION_TYPE,
	};

	logService.debug(`[CopilotCLI] Querying session-scoped chat models with selector ${JSON.stringify(scopedSelector)}.`);

	try {
		const models = await vscode.lm.selectChatModels(scopedSelector as vscode.LanguageModelChatSelector);
		logService.debug(`[CopilotCLI] Session-scoped chat model query returned ${models.length} model(s).`);
		return dedupeModels(models, logService, 'session-scoped model query');
	} catch (error) {
		logService.debug(`[CopilotCLI] Session-scoped chat model query failed: ${error instanceof Error ? error.message : String(error)}.`);
		return [];
	}
}

async function selectLegacyLocalCopilotCLIChatModels(logService: ILogService, selector: vscode.LanguageModelChatSelector): Promise<readonly vscode.LanguageModelChat[]> {
	const localSelector: vscode.LanguageModelChatSelector = { ...selector, vendor: LOCAL_MODEL_VENDOR };

	try {
		let localModels = await vscode.lm.selectChatModels(localSelector);
		if (localModels.length === 0) {
			const allModels = await vscode.lm.selectChatModels(selector.id ? { id: selector.id } : undefined);
			localModels = allModels.filter(model => model.vendor === LOCAL_MODEL_VENDOR || model.family.startsWith(LOCAL_MODEL_FAMILY_PREFIX));
		}

		const cliVisibleModels = localModels.filter(model => {
			const markerIndex = model.family.lastIndexOf(MODEL_SURFACE_MARKER);
			if (markerIndex === -1) {
				return true;
			}

			const surface = model.family.slice(markerIndex + MODEL_SURFACE_MARKER.length).toLowerCase();
			const isVisible = surface !== MODEL_SURFACE_CHAT;
			if (!isVisible) {
				logService.debug(`[CopilotCLI] Filtered out legacy local model ${model.id} because it is marked chat-only.`);
			}
			return isVisible;
		});

		if (cliVisibleModels.length > 0) {
			logService.debug(`[CopilotCLI] Legacy local model discovery returned ${cliVisibleModels.length} model(s).`);
		}

		return dedupeModels(cliVisibleModels, logService, 'legacy local model discovery');
	} catch (error) {
		logService.debug(`[CopilotCLI] Legacy local model discovery failed: ${error instanceof Error ? error.message : String(error)}.`);
		return [];
	}
}

async function logMissingCopilotCLIModelReason(logService: ILogService, modelId: string): Promise<void> {
	try {
		const genericMatches = await vscode.lm.selectChatModels({ id: modelId });
		if (genericMatches.some(model => model.id === modelId)) {
			logService.debug(`[CopilotCLI] Filtered out model ${modelId} for the copilotcli session type because of policy, disabled state, or session mismatch.`);
			return;
		}
	} catch (error) {
		logService.debug(`[CopilotCLI] Failed to inspect generic model availability for ${modelId}: ${error instanceof Error ? error.message : String(error)}.`);
		return;
	}

	logService.debug(`[CopilotCLI] Model ${modelId} was not found in any VS Code language model source.`);
}

function dedupeModels<T extends { id: string }>(models: readonly T[], logService: ILogService, context: string): readonly T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];

	for (const model of models) {
		if (seen.has(model.id)) {
			logService.debug(`[CopilotCLI] Filtered out duplicate model ${model.id} during ${context}.`);
			continue;
		}

		seen.add(model.id);
		deduped.push(model);
	}

	return deduped;
}