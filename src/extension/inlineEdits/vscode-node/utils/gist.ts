/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { authentication } from 'vscode';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import * as errors from '../../../../util/common/errors';
import { Result } from '../../../../util/common/result';
import { assert } from '../../../../util/vs/base/common/assert';

export namespace GistResponse {
	/**
	 * Incomplete, see https://docs.github.com/en/rest/gists/gists?apiVersion=2022-11-28
	 */
	export type t = {
		html_url: string;
		files: { [filename: string]: { raw_url: string } };
	}

	export function is(obj: unknown): obj is t {
		return typeof obj === 'object' && obj !== null && 'html_url' in obj && 'files' in obj;
	}
}

/**
 * Creates a private gist with the provided name and files.
 * Returns the URL of the created gist or an error if the creation failed.
 */
export async function createPrivateGist(fetcherService: IFetcherService, name: string, files: { [filename: string]: { content: string } }): Promise<Result<GistResponse.t, Error>> {
	try {
		const session = await authentication.getSession('github', ['gist'], { createIfNone: true });

		const response = await fetcherService.fetch('https://api.github.com/gists', {
			method: 'POST',
			headers: {
				'Authorization': `token ${session.accessToken}`,
				'Content-Type': 'application/json',
				'User-Agent': 'VSCode-Copilot-Chat'
			},
			body: JSON.stringify({
				description: name,
				public: false,
				files,
			})
		});

		if (!response.ok) {
			return Result.fromString(`Fetch failed: ${response.status} ${response.statusText}`);
		}

		const gist = await response.json();
		assert(GistResponse.is(gist), 'Expected GistResponse.t type');

		// could also return gist.files[filename].raw_url if needed
		return Result.ok(gist);
	} catch (error: unknown) {
		return Result.error(errors.fromUnknown(error));
	}
}
