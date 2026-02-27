/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { join } from 'path';

const APP_DIRECTORY = '.copilot/ide';
const SESSION_STATE_DIRECTORY = '.copilot/session-state';

export function getCopilotCliStateDir(): string {
	const xdgHome = process.env.XDG_STATE_HOME;
	return xdgHome ? join(xdgHome, APP_DIRECTORY) : join(homedir(), APP_DIRECTORY);
}

export function getCopilotCLISessionStateDir(): string {
	const xdgHome = process.env.XDG_STATE_HOME;
	return xdgHome ? join(xdgHome, SESSION_STATE_DIRECTORY) : join(homedir(), SESSION_STATE_DIRECTORY);
}
