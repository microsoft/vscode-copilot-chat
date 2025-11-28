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
		/**
		 * Whether clicking on the parent tree entry should open the primary entry.
		 * When true, the parent entry is clickable and the primary entry is not
		 * shown as a child (to avoid duplication).
		 */
		public readonly primaryClickOpensEntry: boolean = false,
	) { }
}
