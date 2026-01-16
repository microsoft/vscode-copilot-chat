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
		 * When true, the parent tree item becomes clickable and acts as the main entry.
		 * The main entry (identified by debugName starting with the token's label prefix) is
		 * excluded from the children list and its content is shown when clicking the parent.
		 */
		public readonly promoteMainEntry: boolean = false,
		/**
		 * Optional parent token for hierarchical grouping.
		 * Used to link subagent/child requests to their parent request,
		 * enabling proper grouping even when AsyncLocalStorage context is lost.
		 */
		public readonly parentToken?: CapturingToken,
	) { }

	/**
	 * Create a child token that references this token as its parent.
	 * Useful for subagent requests or other child operations that need
	 * to maintain the request hierarchy.
	 *
	 * @param label Label for the child token
	 * @param icon Optional icon for the child token
	 * @param flattenSingleChild Whether to flatten single children (default: false)
	 * @returns A new CapturingToken with this token as its parent
	 */
	createChild(label: string, icon?: string, flattenSingleChild: boolean = false): CapturingToken {
		return new CapturingToken(label, icon, flattenSingleChild, false, this);
	}

	/**
	 * Get the root token in the hierarchy.
	 * Traverses up the parentToken chain to find the topmost token.
	 */
	getRoot(): CapturingToken {
		let current: CapturingToken = this;
		while (current.parentToken) {
			current = current.parentToken;
		}
		return current;
	}

	/**
	 * Check if this token is a descendant of the given token.
	 */
	isDescendantOf(token: CapturingToken): boolean {
		let current: CapturingToken | undefined = this.parentToken;
		while (current) {
			if (current === token) {
				return true;
			}
			current = current.parentToken;
		}
		return false;
	}
}
