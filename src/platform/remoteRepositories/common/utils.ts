/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../util/vs/base/common/uri';

export function isGitHubRemoteRepository(uri: URI): boolean {
	if (uri.scheme !== 'vscode-vfs') {
		return false;
	}

	const authority = uri.authority.toLowerCase();
	const host = authority.includes('@') ? authority.split('@').pop() ?? '' : authority;
	const hostname = host.split(':')[0];

	return hostname === 'github' || hostname === 'github.com' || hostname === 'github.dev' || hostname.endsWith('.github.dev');
}
