/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionState } from '../../completionState';
import { Context } from '../../context';
import {
	ComponentsCompletionsPromptFactory,
	PromptOrdering,
} from './componentsCompletionsPromptFactory';
import { WorkspaceContextPromptFactory } from './workspaceContextPromptFactory';
import { PromptResponse, _promptCancelled, _promptError, _promptTimeout } from '../prompt';
import { TelemetryWithExp } from '../../telemetry';
import { VirtualPrompt } from '../../../../prompt/src/components/virtualPrompt';
import { TokenizerName } from '../../../../prompt/src/tokenization';
import { CancellationToken, CancellationTokenSource } from 'vscode-languageserver-protocol';

export interface PromptOpts {
	data?: unknown;
	separateContext?: boolean;
	tokenizer?: TokenizerName;
}

export interface CompletionsPromptOptions {
	completionId: string;
	completionState: CompletionState;
	telemetryData: TelemetryWithExp;
	promptOpts?: PromptOpts;
}

export abstract class CompletionsPromptFactory {
	abstract prompt(opts: CompletionsPromptOptions, cancellationToken?: CancellationToken): Promise<PromptResponse>;
}

export function createCompletionsPromptFactory(
	ctx: Context,
	virtualPrompt?: VirtualPrompt,
	ordering?: PromptOrdering
): CompletionsPromptFactory {
	return new SequentialCompletionsPromptFactory(
		new TimeoutHandlingCompletionsPromptFactory(
			new ExperimentalCompletionsPromptFactory(
				ctx,
				// Timeout should wrap the real prompt factory
				new ComponentsCompletionsPromptFactory(ctx, virtualPrompt, ordering),
				new WorkspaceContextPromptFactory(ctx),
				workspaceContextEnabledAndActive
			)
		)
	);
}

// This class needs to extend CompletionsPromptFactory since it's set on the context.
class SequentialCompletionsPromptFactory extends CompletionsPromptFactory {
	private lastPromise?: Promise<PromptResponse>;

	constructor(private readonly delegate: CompletionsPromptFactory) {
		super();
	}

	async prompt(opts: CompletionsPromptOptions, cancellationToken?: CancellationToken): Promise<PromptResponse> {
		this.lastPromise = this.promptAsync(opts, cancellationToken);
		return this.lastPromise;
	}

	private async promptAsync(
		opts: CompletionsPromptOptions,
		cancellationToken?: CancellationToken
	): Promise<PromptResponse> {
		// Wait for previous request to complete
		await this.lastPromise;

		// Check if request was cancelled while waiting
		if (cancellationToken?.isCancellationRequested) {
			return _promptCancelled;
		}

		// Return prompt from delegate catching any errors
		try {
			return await this.delegate.prompt(opts, cancellationToken);
		} catch {
			return _promptError;
		}
	}
}

// 0.01% of prompt construction time is 1s+. Setting this to 1200ms should be safe.
export const DEFAULT_PROMPT_TIMEOUT = 1200;
class TimeoutHandlingCompletionsPromptFactory implements CompletionsPromptFactory {
	constructor(private readonly delegate: CompletionsPromptFactory) { }

	async prompt(opts: CompletionsPromptOptions, cancellationToken?: CancellationToken): Promise<PromptResponse> {
		const timeoutTokenSource = new CancellationTokenSource();
		const timeoutToken = timeoutTokenSource.token;
		cancellationToken?.onCancellationRequested(() => {
			timeoutTokenSource.cancel();
		});

		return await Promise.race([
			this.delegate.prompt(opts, timeoutToken),
			new Promise<PromptResponse>(resolve => {
				setTimeout(() => {
					// Cancel the token when timeout occurs
					timeoutTokenSource.cancel();
					resolve(_promptTimeout);
				}, DEFAULT_PROMPT_TIMEOUT);
			}),
		]);
	}
}

// Wrapper that chooses which factory to use depending on a feature flag
class ExperimentalCompletionsPromptFactory implements CompletionsPromptFactory {
	constructor(
		private readonly ctx: Context,
		private readonly defaultDelegate: CompletionsPromptFactory,
		private readonly experimentalDelegate: CompletionsPromptFactory,
		private readonly fn: (ctx: Context, t: TelemetryWithExp) => boolean
	) { }

	async prompt(opts: CompletionsPromptOptions, cancellationToken?: CancellationToken): Promise<PromptResponse> {
		if (this.fn(this.ctx, opts.telemetryData)) {
			return this.experimentalDelegate.prompt(opts, cancellationToken);
		}

		return this.defaultDelegate.prompt(opts, cancellationToken);
	}
}

function workspaceContextEnabledAndActive(ctx: Context, telemetryWithExp: TelemetryWithExp): boolean {
	return false;
}
