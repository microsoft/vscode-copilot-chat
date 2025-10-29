/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../../../lib/src/context';
import { asyncIterableMapFilter } from '../../../../lib/src/helpers/iterableHelpers';
import { Logger } from '../../../../lib/src/logger';
import { CopilotUiKind, OpenAIFetcher } from '../../../../lib/src/openai/fetch';
import { APIChoice } from '../../../../lib/src/openai/openai';
import { StatusReporter } from '../../../../lib/src/progress';
import { getNodeStartUtil } from '../../../../lib/src/prompt/parseBlock';
import { trimLastLine } from '../../../../lib/src/prompt/prompt';
import { postProcessChoiceInContext } from '../../../../lib/src/suggestions/suggestions';
import { LocationFactory } from '../../../../lib/src/textDocument';
import {
	generateSolutionsStream,
	reportSolutions,
	setupCompletionParams,
	setupPromptAndTelemetry,
	SolutionManager,
	trimChoices,
} from '../panelShared/common';
import { ISolutionHandler, SolutionsStream, UnformattedSolution } from '../panelShared/panelTypes';

const solutionsLogger = new Logger('solutions');

/**
 * Given an `ISolutionManager` with the context of a specific "Open Copilot" request,
 * initiate the generation of a stream of solutions for that request.
 */
export async function launchSolutions(ctx: Context, solutionManager: SolutionManager): Promise<SolutionsStream> {
	const position = solutionManager.targetPosition;
	const document = solutionManager.textDocument;

	// Setup prompt and telemetry using shared function
	const promptSetup = await setupPromptAndTelemetry(ctx, solutionManager, 'open copilot', solutionsLogger);
	if ('status' in promptSetup) {
		// This is a SolutionsStream indicating an error occurred
		return promptSetup;
	}

	const { prompt, trailingWs, telemetryData, repoInfo, ourRequestId } = promptSetup;

	// Setup completion parameters using shared function
	const { extra, postOptions, finishedCb, engineInfo } = setupCompletionParams(
		ctx,
		document,
		position,
		prompt,
		solutionManager,
		telemetryData
	);

	const cancellationToken = solutionManager.cancellationToken;

	const completionParams = {
		prompt,
		languageId: document.detectedLanguageId,
		repoInfo,
		ourRequestId,
		engineModelId: engineInfo.modelId,
		count: solutionManager.solutionCountTarget,
		uiKind: CopilotUiKind.Panel,
		postOptions,
		headers: engineInfo.headers,
		extra,
	};

	const res = await ctx
		.get(OpenAIFetcher)
		.fetchAndStreamCompletions(ctx, completionParams, telemetryData.extendedBy(), finishedCb, cancellationToken);

	if (res.type === 'failed' || res.type === 'canceled') {
		return { status: 'FinishedWithError', error: `${res.type}: ${res.reason}` };
	}

	let choices: AsyncIterable<APIChoice> = res.choices;
	choices = trimChoices(choices);
	choices = asyncIterableMapFilter(choices, choice =>
		postProcessChoiceInContext(ctx, document, position, choice, false, solutionsLogger)
	);

	const solutions = asyncIterableMapFilter(choices, async (apiChoice: APIChoice) => {
		let display = apiChoice.completionText;
		solutionsLogger.info(ctx, `Open Copilot completion: [${apiChoice.completionText}]`);

		// For completions that can happen in any location in the middle of the code we try to find the existing code
		// that should be displayed in the OpenCopilot panel so the code is nicely formatted/highlighted.
		// This is not needed for implement unknown function quick fix, as it will be
		// always "complete" standalone function in the location suggested by TS' extension.
		const displayStartPos =
			(await getNodeStartUtil(document, position, apiChoice.completionText)) ??
			LocationFactory.position(position.line, 0);
		const [displayBefore] = trimLastLine(document.getText(LocationFactory.range(displayStartPos, position)));

		display = displayBefore + display;
		let completionText = apiChoice.completionText;

		if (trailingWs.length > 0 && completionText.startsWith(trailingWs)) {
			completionText = completionText.substring(trailingWs.length);
		}

		const meanLogProb = apiChoice.meanLogProb;
		const meanProb: number = meanLogProb !== undefined ? Math.exp(meanLogProb) : 0;

		const solutionTelemetryData = telemetryData.extendedBy({
			choiceIndex: apiChoice.choiceIndex.toString(),
		});
		const solution: UnformattedSolution = {
			completionText,
			insertText: display,
			range: LocationFactory.range(displayStartPos, position),
			meanProb: meanProb,
			meanLogProb: meanLogProb || 0,
			requestId: apiChoice.requestId,
			choiceIndex: apiChoice.choiceIndex,
			telemetryData: solutionTelemetryData,
			copilotAnnotations: apiChoice.copilotAnnotations,
		};
		return solution;
	});
	// deliberately not awaiting so that we can return quickly
	const solutionsStream = generateSolutionsStream(cancellationToken, solutions[Symbol.asyncIterator]());
	return solutionsStream;
}

export async function runSolutions(
	ctx: Context,
	solutionManager: SolutionManager,
	solutionHandler: ISolutionHandler
): Promise<void> {
	const statusReporter = ctx.get(StatusReporter);
	return statusReporter.withProgress(async () => {
		const nextSolution = launchSolutions(ctx, solutionManager);
		return await reportSolutions(nextSolution, solutionHandler);
	});
}
