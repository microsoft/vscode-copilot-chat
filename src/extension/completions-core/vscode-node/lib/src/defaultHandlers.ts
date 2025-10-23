/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Context } from './context';
import { Logger, logger } from './logger';
import { isAbortError } from './networking';
import { StatusReporter } from './progress';

const oomCodes = new Set(['ERR_WORKER_OUT_OF_MEMORY', 'ENOMEM']);

function isOomError(error: NodeJS.ErrnoException) {
	return (
		oomCodes.has(error.code ?? '') ||
		// happens in loadWasmLanguage
		(error.name === 'RangeError' && error.message === 'WebAssembly.Memory(): could not allocate memory')
	);
}

export function handleException(ctx: Context, err: unknown, origin: string, _logger: Logger = logger): void {
	if (isAbortError(err)) {
		// ignore cancelled fetch requests
		return;
	}
	if (err instanceof Error) {
		const error = err as NodeJS.ErrnoException;
		if (isOomError(error)) {
			ctx.get(StatusReporter).setWarning('Out of memory');
		} else if (error.code === 'EMFILE' || error.code === 'ENFILE') {
			ctx.get(StatusReporter).setWarning('Too many open files');
		} else if (error.code === 'CopilotPromptLoadFailure') {
			ctx.get(StatusReporter).setWarning('Corrupted Copilot installation');
		} else if (`${error.code}`.startsWith('CopilotPromptWorkerExit')) {
			ctx.get(StatusReporter).setWarning('Worker unexpectedly exited');
		} else if (error.syscall === 'uv_cwd' && error.code === 'ENOENT') {
			ctx.get(StatusReporter).setWarning('Current working directory does not exist');
		}
	}
	_logger.exception(ctx, err, origin);
}
