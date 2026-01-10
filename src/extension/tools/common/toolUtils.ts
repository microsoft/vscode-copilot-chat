/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../util/vs/base/common/uri';
import { Location } from '../../../vscodeTypes';

type FileUriMetadata = {
	vscodeLinkType: 'file';
	fileName?: string;
};

export function formatUriForFileWidget(uriOrLocation: URI | Location, options?: { fileName?: string }): string {
	const uri = URI.isUri(uriOrLocation) ? uriOrLocation : uriOrLocation.uri;
	const rangePart = URI.isUri(uriOrLocation) ?
		'' :
		`#${uriOrLocation.range.start.line + 1}-${uriOrLocation.range.end.line + 1}`;

	// Empty link text -> rendered as file widget
	// Or, optionally provide metadata as a JSON string in the link text
	let metadata = '';
	if (options?.fileName) {
		const fileUriMetadata: FileUriMetadata = { vscodeLinkType: 'file', fileName: options.fileName };
		metadata = JSON.stringify(fileUriMetadata);
	}
	return `[${metadata}](${uri.toString()}${rangePart})`;
}
