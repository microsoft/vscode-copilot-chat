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

/**
 * Result of prompt generation for a single recording.
 */
export interface IGeneratedPrompt {
	/** The system message */
	readonly system: string;
	/** The user message (the prompt) */
	readonly user: string;
	/** The full stringified prompt from logContext (system + user) */
	readonly rawPrompt: string;
}

/**
 * Parse the stringified prompt from InlineEditRequestLogContext into system and user parts.
 * The format is: "System\n------\n{system}\n==================\n\nUser\n------\n{user}\n=================="
 */
function parsePromptParts(rawPrompt: string): { system: string; user: string } {
	const separator = '==================';
	const parts = rawPrompt.split(separator);

	if (parts.length < 2) {
		return { system: '', user: rawPrompt };
	}

	// First part: "System\n------\n{systemContent}\n"
	const systemPart = parts[0].trim();
	const systemLines = systemPart.split('\n');
	// Skip "System" and "------" header lines
	const systemStartIdx = systemLines.findIndex(l => l.trim() === '------');
	const system = systemStartIdx >= 0
		? systemLines.slice(systemStartIdx + 1).join('\n').trim()
		: systemPart;

	// Second part: "\n\nUser\n------\n{userContent}\n"
	const userPart = parts[1].trim();
	const userLines = userPart.split('\n');
	const userStartIdx = userLines.findIndex(l => l.trim() === '------');
	const user = userStartIdx >= 0
		? userLines.slice(userStartIdx + 1).join('\n').trim()
		: userPart;

	return { system, user };
}

/**
 * Generate a prompt from a recording using the existing NES pipeline.
 *
 * Replicates InlineEditTester.runTestFromRecording() + _runTest() but only captures
 * the prompt, not the model response. MockChatMLFetcher in the DI services ensures
 * no real model call is made.
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

	// Step 1: Set up replayer and history providers (same as InlineEditTester.runTestFromRecording)
	const replayer = new ObservableWorkspaceRecordingReplayer(recordingInfo);
	const obsGit = instaService.createInstance(ObservableGit);
	const historyContextProvider = new NesHistoryContextProvider(replayer.workspace, obsGit);
	const nesXtabHistoryTracker = new NesXtabHistoryTracker(replayer.workspace, undefined, configService, expService);
	const debugRecorder = new DebugRecorder(replayer.workspace);

	try {
		const { lastDocId } = replayer.replay();

		// Step 2: Create NextEditProvider (same as InlineEditTester._runTest)
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

		// Step 3: Call getNextEdit — prompt is captured in logContext, model call is mocked
		try {
			await nextEditProvider.getNextEdit(
				activeDocument.docId, context, logContext,
				CancellationToken.None, telemetryBuilder.nesBuilder,
			);
		} finally {
			nextEditProvider.dispose();
			telemetryBuilder.dispose();
		}

		// Step 4: Extract the generated prompt
		const rawPrompt = logContext.prompt;
		if (!rawPrompt) {
			return { error: 'Prompt was not captured in logContext (pipeline returned early before prompt construction)' };
		}

		const { system, user } = parsePromptParts(rawPrompt);
		return { system, user, rawPrompt };

	} catch (e) {
		return { error: `Prompt generation failed: ${e instanceof Error ? e.message : String(e)}` };
	} finally {
		historyContextProvider.dispose();
		obsGit.dispose();
		replayer.dispose();
	}
}

/**
 * Generate prompts for all recordings, returning results and errors.
 */
export async function generateAllPrompts(
	accessor: ServicesAccessor,
	recordings: readonly IRecordingInformation[],
): Promise<{
	prompts: { index: number; prompt: IGeneratedPrompt }[];
	errors: { index: number; error: string }[];
}> {
	const prompts: { index: number; prompt: IGeneratedPrompt }[] = [];
	const errors: { index: number; error: string }[] = [];

	for (let i = 0; i < recordings.length; i++) {
		const result = await generatePromptFromRecording(accessor, recordings[i]);
		if ('error' in result) {
			errors.push({ index: i, error: result.error });
		} else {
			prompts.push({ index: i, prompt: result });
		}
	}

	return { prompts, errors };
}

/**
 * Print diagnostic summary of generated prompts.
 */
export function printPromptDiagnostics(
	prompts: readonly { index: number; prompt: IGeneratedPrompt }[],
	errors: readonly { index: number; error: string }[],
): void {
	console.log('\n=== Prompt Generation Results ===');
	console.log(`Successfully generated: ${prompts.length}`);
	console.log(`Errors: ${errors.length}`);

	if (errors.length > 0) {
		console.log('\n--- Prompt Errors ---');
		for (const err of errors) {
			console.log(`  Row ${err.index}: ${err.error}`);
		}
	}

	if (prompts.length > 0) {
		// For small sets (≤5), dump full prompts for visual verification
		const dumpAll = prompts.length <= 5;
		for (const { index, prompt } of prompts) {
			console.log(`\n--- Row ${index}: Generated Prompt ---`);
			console.log(`  System message: ${prompt.system.length} chars`);
			console.log(`  User message: ${prompt.user.length} chars`);
			if (dumpAll) {
				console.log(`\n  === SYSTEM ===\n${prompt.system}\n`);
				console.log(`  === USER ===\n${prompt.user}\n`);
			} else if (index === prompts[0].index) {
				console.log(`  System preview: ${prompt.system.substring(0, 200)}...`);
				console.log(`  User preview: ${prompt.user.substring(0, 300)}...`);
			}
		}
	}
}
