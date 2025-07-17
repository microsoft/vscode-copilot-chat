/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { URI } from '@vscode/prompt-tsx/dist/base/util/vs/common/uri';
import { IgnoredMetadata, IgnoreReason } from '../../../../platform/ignore/common/ignoreService';

export class IgnoredFiles extends PromptElement<BasePromptElementProps & { uris: URI | URI[]; reason: IgnoreReason }> {
	override render() {
		const uris = Array.isArray(this.props.uris) ? this.props.uris : [this.props.uris];
		if (this.props.reason === IgnoreReason.NotIgnored || !uris.length) {
			return;
		}

		return <>
			<ignoredFiles value={Array.isArray(this.props.uris) ? this.props.uris : [this.props.uris]} />
			<meta value={new IgnoredMetadata(this.props.reason, uris)} />
		</>;
	}
}
