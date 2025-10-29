/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands } from 'vscode';
import { type ICompletionsContextService } from '../../lib/src/context';
import { handleException } from '../../lib/src/defaultHandlers';
import { Logger } from '../../lib/src/logger';
import { Extension } from './extensionContext';

function exception(ctx: ICompletionsContextService, error: unknown, origin: string, logger?: Logger) {
	if (error instanceof Error && error.name === 'Canceled') {
		// these are VS Code cancellations
		return;
	}
	if (error instanceof Error && error.name === 'CodeExpectedError') {
		// expected errors from VS Code
		return;
	}
	handleException(ctx, error, origin, logger);
}

// Wrapper that handles errors and cleans up the command on extension deactivation
export function registerCommandWrapper(ctx: ICompletionsContextService, command: string, fn: (...args: unknown[]) => unknown) {
	const disposable = commands.registerCommand(command, async (...args: unknown[]) => {
		try {
			await fn(...args);
		} catch (error) {
			// Pass in the command string as the origin
			exception(ctx, error, command);
		}
	});
	ctx.get(Extension).addSubscription(disposable);
}