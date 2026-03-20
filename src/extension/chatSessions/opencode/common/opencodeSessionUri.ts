/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../util/vs/base/common/uri';

export namespace OpenCodeSessionUri {
	export const scheme = 'opencode';

	export function forSessionId(sessionId: string): URI {
		return URI.from({ scheme: OpenCodeSessionUri.scheme, path: '/' + sessionId });
	}

	export function getSessionId(resource: URI): string {
		if (resource.scheme !== OpenCodeSessionUri.scheme) {
			throw new Error('Invalid resource scheme for OpenCode session');
		}

		return resource.path.slice(1);
	}
}
