/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../util/vs/base/common/uri';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';

export class DiagnosticData {
	constructor(
		public readonly documentUri: URI,
		public readonly message: string,
		public readonly severity: 'error' | 'warning',
		public readonly range: OffsetRange,
	) { }

	public toString(): string {
		return `${this.severity.toUpperCase()}: ${this.message} (${this.range})`;
	}
}
