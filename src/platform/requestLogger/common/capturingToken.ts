/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A token that can be used to capture and group related requests together.
 */
export class CapturingToken {
	constructor(
		/**
		 * A label to display for the parent tree element.
		 */
		public readonly label: string,
		/**
		 * An optional icon to display alongside the label.
		 */
		public readonly icon: string | undefined,
		/**
		 * Whether to flatten a single child request under this token.
		 */
		public readonly flattenSingleChild: boolean,
	) { }
}
