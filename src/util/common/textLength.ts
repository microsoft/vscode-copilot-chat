/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OffsetRange } from '../vs/editor/common/core/ranges/offsetRange';
import { TextLength } from '../vs/editor/common/core/text/textLength';

export function TextLengthOfSubstr(str: string, range: OffsetRange): TextLength {
	return TextLength.ofText(range.substring(str));
}

export function TextLengthSum<T>(fragments: readonly T[], getLength: (f: T) => TextLength): TextLength {
	return fragments.reduce((acc, f) => acc.add(getLength(f)), TextLength.zero);
}