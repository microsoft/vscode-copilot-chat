/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../util/vs/base/common/uri';
import { Location } from '../../../vscodeTypes';

type FileUriMetadata = {
	vscodeLinkType: 'skill';
	linkText: string;
};

export function formatUriForFileWidget(uriOrLocation: URI | Location, metadata?: FileUriMetadata): string {
	const uri = URI.isUri(uriOrLocation) ? uriOrLocation : uriOrLocation.uri;
	const rangePart = URI.isUri(uriOrLocation) ?
		'' :
		`#${uriOrLocation.range.start.line + 1}-${uriOrLocation.range.end.line + 1}`;

	if (metadata) {
		const uriWithQuery = uri.with({ query: `vscodeLinkType=${metadata.vscodeLinkType}` });
		return `[${metadata.linkText}](${uriWithQuery.toString()}${rangePart})`;
	}

	return `[](${uri.toString()}${rangePart})`;
}
