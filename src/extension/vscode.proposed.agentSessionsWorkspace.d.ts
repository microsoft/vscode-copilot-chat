/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	export namespace workspace {
		/**
		 * Indicates whether the current workspace is an agent sessions workspace.
		 *
		 * When this is `true`, session providers should return all sessions
		 * irrespective of the currently opened workspace folders. This is used
		 * for dedicated agent sessions views that want to show all available
		 * sessions across all workspaces.
		 */
		export const isAgentSessionsWorkspace: boolean;
	}
}
