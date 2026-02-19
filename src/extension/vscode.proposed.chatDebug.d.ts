/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 1

declare module 'vscode' {
	/**
	 * The severity level of a chat debug log event.
	 */
	export enum ChatDebugLogLevel {
		Trace = 0,
		Info = 1,
		Warning = 2,
		Error = 3
	}

	/**
	 * A single event in the chat debug log.
	 */
	export interface ChatDebugLogEvent {
		/**
		 * A unique identifier for this event.
		 */
		readonly id?: string;

		/**
		 * The timestamp when the event was created.
		 */
		readonly created: Date;

		/**
		 * A short name describing the event (e.g., "Resolved skills (start)").
		 */
		readonly name: string;

		/**
		 * Optional details of the event.
		 */
		readonly details?: string;

		/**
		 * The severity level of the event.
		 */
		readonly level: ChatDebugLogLevel;

		/**
		 * The category classifying the kind of event.
		 */
		readonly category?: string;

		/**
		 * The id of a parent event, used to build a hierarchical tree
		 * (e.g., tool calls nested under a subagent invocation).
		 */
		readonly parentEventId?: string;
	}

	/**
	 * A single metric displayed in the session overview.
	 */
	export interface ChatDebugSessionOverviewMetric {
		/**
		 * A short label for the metric (e.g., "Total Cost").
		 */
		readonly label: string;

		/**
		 * The value to display (e.g., "$11.11", "10,248").
		 */
		readonly value: string;
	}

	/**
	 * An action button displayed in the session overview.
	 * Each action appears in a named group (e.g., "Explore Trace Data", "Advanced").
	 */
	export interface ChatDebugSessionOverviewAction {
		/**
		 * The group this action belongs to (e.g., "Explore Trace Data").
		 */
		readonly group: string;

		/**
		 * The display label of the action button.
		 */
		readonly label: string;

		/**
		 * An optional command to run when the action is clicked.
		 */
		readonly commandId?: string;

		/**
		 * An optional arguments array for the command.
		 */
		readonly commandArgs?: unknown[];
	}

	/**
	 * Overview information for a chat debug session, shown on the
	 * session overview page of the debug editor.
	 */
	export interface ChatDebugSessionOverview {
		/**
		 * A short title or description of the session (e.g., the first
		 * user message).
		 */
		readonly sessionTitle?: string;

		/**
		 * Summary metrics displayed as cards (e.g., cost, tokens, fail rate).
		 */
		readonly metrics?: ChatDebugSessionOverviewMetric[];

		/**
		 * Action buttons grouped by section.
		 */
		readonly actions?: ChatDebugSessionOverviewAction[];
	}

	/**
	 * A provider that supplies debug log events for a chat session.
	 */
	export interface ChatDebugLogProvider {
		/**
		 * Called when the debug view is opened for a chat session.
		 * The provider should return initial log events and can use
		 * the progress callback to stream additional events over time.
		 *
		 * @param sessionId The ID of the chat session being debugged.
		 * @param progress A progress callback to stream log events.
		 * @param token A cancellation token.
		 * @returns Initial log events, if any.
		 */
		provideChatDebugLog(
			sessionId: string,
			progress: Progress<ChatDebugLogEvent>,
			token: CancellationToken
		): ProviderResult<ChatDebugLogEvent[]>;

		/**
		 * Optionally resolve the full contents of a log event by its id.
		 * Called when the user expands an event in the debug view, allowing
		 * the provider to defer expensive detail loading until needed.
		 *
		 * @param eventId The {@link ChatDebugLogEvent.id id} of the event to resolve.
		 * @param token A cancellation token.
		 * @returns The resolved event details to be displayed in the debug detail view.
		 */
		resolveChatDebugLogEvent?(
			eventId: string,
			token: CancellationToken
		): ProviderResult<string>;
	}

	/**
	 * A provider that supplies overview information for a chat debug session.
	 * This is a separate provider from {@link ChatDebugLogProvider} so that
	 * extensions can contribute just the overview without supplying log events.
	 */
	export interface ChatDebugSessionOverviewProvider {
		/**
		 * Provide overview information for a chat debug session.
		 * Called when the session overview page is displayed.
		 *
		 * @param sessionId The ID of the chat session.
		 * @param token A cancellation token.
		 * @returns Overview information for the session.
		 */
		provideChatDebugSessionOverview(
			sessionId: string,
			token: CancellationToken
		): ProviderResult<ChatDebugSessionOverview>;
	}

	export namespace chat {
		/**
		 * Register a provider that supplies debug log events for chat sessions.
		 * Only one provider can be registered at a time.
		 *
		 * @param provider The chat debug log provider.
		 * @returns A disposable that unregisters the provider.
		 */
		export function registerChatDebugLogProvider(provider: ChatDebugLogProvider): Disposable;

		/**
		 * Register a provider that supplies session overview information.
		 * Only one provider can be registered at a time.
		 *
		 * @param provider The session overview provider.
		 * @returns A disposable that unregisters the provider.
		 */
		export function registerChatDebugSessionOverviewProvider(provider: ChatDebugSessionOverviewProvider): Disposable;
	}
}
