/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EXTENSION_ID } from '../../common/constants';

const GHPR_EXTENSION_ID = 'GitHub.vscode-pull-request-github';
export enum UriHandlerPaths {
	OpenSessionPullRequest = '/open-session-pull-request',
	External_OpenPullRequestWebview = '/open-pull-request-webview',
}

export const UriHandlers = {
	[UriHandlerPaths.OpenSessionPullRequest]: EXTENSION_ID,
	[UriHandlerPaths.External_OpenPullRequestWebview]: GHPR_EXTENSION_ID
};
