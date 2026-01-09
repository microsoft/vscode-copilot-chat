/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname } from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';
import { Location } from '../../../vscodeTypes';

type FileType = 'skill';

export interface FormatUriOptions {
	/** The type of file (e.g., 'skill') */
	fileType?: FileType;
}

// Overload for use with .map() and other array methods
export function formatUriForFileWidget(uriOrLocation: URI | Location): string;
export function formatUriForFileWidget(uriOrLocation: URI | Location, options: FormatUriOptions): string;
export function formatUriForFileWidget(uriOrLocation: URI | Location, options?: FormatUriOptions): string {
	const uri = URI.isUri(uriOrLocation) ? uriOrLocation : uriOrLocation.uri;
	const rangePart = URI.isUri(uriOrLocation) ?
		'' :
		`#${uriOrLocation.range.start.line + 1}-${uriOrLocation.range.end.line + 1}`;

	let resultUri = uri;
	if (options?.fileType === 'skill') {
		const query = uri.query ? JSON.parse(uri.query) : {};
		query.type = options.fileType;

		// Extract skill name from parent folder name
		const parentFolder = basename(dirname(uri.path));
		if (parentFolder) {
			query.name = parentFolder;
		}

		resultUri = uri.with({ query: JSON.stringify(query) });
	}

	// Empty link text -> rendered as file widget
	return `[](${resultUri.toString()}${rangePart})`;
}
