/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { join } from 'path';

const APP_DIRECTORY = join('.copilot', 'ide');
const SESSION_STATE_DIRECTORY = join('.copilot', 'session-state');

export function getCopilotCliStateDir(): string {
	const xdgHome = process.env.XDG_STATE_HOME;
	return xdgHome ? join(xdgHome, APP_DIRECTORY) : join(homedir(), APP_DIRECTORY);
}

export function getCopilotCLISessionStateDir(): string {
	const xdgHome = process.env.XDG_STATE_HOME;
	return xdgHome ? join(xdgHome, SESSION_STATE_DIRECTORY) : join(homedir(), SESSION_STATE_DIRECTORY);
}

export function getCopilotCLISessionDir(sessionId: string): string {
	return join(getCopilotCLISessionStateDir(), sessionId);
}

export function getCopilotCLISessionEventsFile(sessionId: string) {
	return join(getCopilotCLISessionDir(sessionId), 'events.jsonl');
}

export function getCopilotCLIWorkspaceFile(sessionId: string) {
	return join(getCopilotCLISessionDir(sessionId), 'workspace.yaml');
}
