/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRecordingInformation, ObservableWorkspaceRecordingReplayer } from '../../src/extension/inlineEdits/common/observableWorkspaceRecordingReplayer';
import { createNextEditProvider } from '../../src/extension/inlineEdits/node/createNextEditProvider';
import { DebugRecorder } from '../../src/extension/inlineEdits/node/debugRecorder';
import { NESInlineCompletionContext, NextEditProvider } from '../../src/extension/inlineEdits/node/nextEditProvider';
import { NextEditProviderTelemetryBuilder } from '../../src/extension/inlineEdits/node/nextEditProviderTelemetry';
import { ConfigKey, IConfigurationService } from '../../src/platform/configuration/common/configurationService';
import { IGitExtensionService } from '../../src/platform/git/common/gitExtensionService';
import { InlineEditRequestLogContext } from '../../src/platform/inlineEdits/common/inlineEditLogContext';
import { ObservableGit } from '../../src/platform/inlineEdits/common/observableGit';
import { INotebookService } from '../../src/platform/notebook/common/notebookService';
import { IExperimentationService } from '../../src/platform/telemetry/common/nullExperimentationService';
import { IWorkspaceService } from '../../src/platform/workspace/common/workspaceService';
import { CancellationToken } from '../../src/util/vs/base/common/cancellation';
import { generateUuid } from '../../src/util/vs/base/common/uuid';
import { IInstantiationService, ServicesAccessor } from '../../src/util/vs/platform/instantiation/common/instantiation';
import { NesHistoryContextProvider } from '../../src/platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { NesXtabHistoryTracker } from '../../src/platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';

export interface IGeneratedPrompt {
	readonly system: string;
	readonly user: string;
	readonly rawPrompt: string;
}

/**
 * Parse the stringified prompt from `InlineEditRequestLogContext` into system and user parts.
 * Expected format: `System\n------\n{system}\n==================\n\nUser\n------\n{user}\n==================`
 */
function parsePromptParts(rawPrompt: string): { system: string; user: string } {
	const separator = '==================';
	const parts = rawPrompt.split(separator);

	if (parts.length < 2) {
		return { system: '', user: rawPrompt };
	}

	const systemPart = parts[0].trim();
	const systemLines = systemPart.split('\n');
	const systemStartIdx = systemLines.findIndex(l => l.trim() === '------');
	const system = systemStartIdx >= 0
		? systemLines.slice(systemStartIdx + 1).join('\n').trim()
		: systemPart;

	const userPart = parts[1].trim();
	const userLines = userPart.split('\n');
	const userStartIdx = userLines.findIndex(l => l.trim() === '------');
	const user = userStartIdx >= 0
		? userLines.slice(userStartIdx + 1).join('\n').trim()
		: userPart;

	return { system, user };
}

/**
 * Generate a prompt from a recording using the NES pipeline.
 * Uses MockChatMLFetcher (via DI services) to capture the prompt without calling a real model.
 */
export async function generatePromptFromRecording(
	accessor: ServicesAccessor,
	recordingInfo: IRecordingInformation,
): Promise<IGeneratedPrompt | { error: string }> {
	const instaService = accessor.get(IInstantiationService);
	const configService = accessor.get(IConfigurationService);
	const expService = accessor.get(IExperimentationService);
	const gitExtensionService = accessor.get(IGitExtensionService);
	const notebookService = accessor.get(INotebookService);
	const workspaceService = accessor.get(IWorkspaceService);

	const replayer = new ObservableWorkspaceRecordingReplayer(recordingInfo);
	const obsGit = instaService.createInstance(ObservableGit);
	const historyContextProvider = new NesHistoryContextProvider(replayer.workspace, obsGit);
	const nesXtabHistoryTracker = new NesXtabHistoryTracker(replayer.workspace, undefined, configService, expService);
	const debugRecorder = new DebugRecorder(replayer.workspace);

	try {
		const { lastDocId } = replayer.replay();

		const nextEditProviderId = configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsProviderId, expService);
		const statelessNextEditProvider = createNextEditProvider(nextEditProviderId, instaService);
		const nextEditProvider = instaService.createInstance(
			NextEditProvider, replayer.workspace, statelessNextEditProvider,
			historyContextProvider, nesXtabHistoryTracker, debugRecorder,
		);

		const historyContext = historyContextProvider.getHistoryContext(lastDocId);
		if (!historyContext) {
			nextEditProvider.dispose();
			return { error: `No history context for document ${lastDocId}` };
		}

		const activeDocument = historyContext.getMostRecentDocument();
		const context: NESInlineCompletionContext = {
			triggerKind: 1,
			selectedCompletionInfo: undefined,
			requestUuid: generateUuid(),
			requestIssuedDateTime: Date.now(),
			earliestShownDateTime: Date.now() + 200,
			enforceCacheDelay: false,
		};
		const logContext = new InlineEditRequestLogContext(activeDocument.docId.toString(), 1, context);
		const telemetryBuilder = new NextEditProviderTelemetryBuilder(
			gitExtensionService, notebookService, workspaceService,
			nextEditProvider.ID, replayer.workspace.getDocument(activeDocument.docId),
		);

		// Prompt is captured in logContext; model call is mocked via DI
		try {
			await nextEditProvider.getNextEdit(
				activeDocument.docId, context, logContext,
				CancellationToken.None, telemetryBuilder.nesBuilder,
			);
		} finally {
			nextEditProvider.dispose();
			telemetryBuilder.dispose();
		}

		const rawPrompt = logContext.prompt;
		if (!rawPrompt) {
			return { error: 'Prompt was not captured in logContext (pipeline returned early before prompt construction)' };
		}

		const { system, user } = parsePromptParts(rawPrompt);
		return { system, user, rawPrompt };

	} catch (e) {
		const detail = e instanceof Error && e.stack
			? e.stack.split('\n').slice(0, 3).join(' | ')
			: (e instanceof Error ? e.message : String(e));
		return { error: `Prompt generation failed: ${detail}` };
	} finally {
		historyContextProvider.dispose();
		obsGit.dispose();
		replayer.dispose();
	}
}
