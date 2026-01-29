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
		 * Optional pre-assigned subAgentInvocationId as session id for trajectory tracking.
		 * When set, the trajectory will use this ID instead of generating a new one,
		 * enabling explicit linking between parent tool calls and subagent trajectories.
		 */
		public readonly subAgentInvocationId?: string,
		/**
		 * Optional name of the subagent being invoked.
		 * Used alongside subAgentInvocationId to identify the subagent in trajectory tracking.
		 */
		public readonly subAgentName?: string,
		/**
		 * Optional VS Code chat session ID for trajectory tracking.
		 * When set, this ID is used directly as the trajectory session ID for the main chat,
		 * providing a 1:1 mapping between chat sessions and trajectories.
		 */
		public readonly chatSessionId?: string,
	) { }
}
