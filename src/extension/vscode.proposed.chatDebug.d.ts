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
	 * The outcome of a tool call.
	 */
	export enum ChatDebugToolCallResult {
		Success = 0,
		Error = 1
	}

	/**
	 * A tool call event in the chat debug log, representing the invocation
	 * of a tool (e.g., file search, terminal command, code edit).
	 */
	export class ChatDebugToolCallEvent {
		/**
		 * A unique identifier for this event.
		 */
		id?: string;

		/**
		 * The timestamp when the event was created.
		 */
		created: Date;

		/**
		 * The id of a parent event, used to build a hierarchical tree
		 * (e.g., tool calls nested under a model turn).
		 */
		parentEventId?: string;

		/**
		 * The name of the tool that was called.
		 */
		toolName: string;

		/**
		 * An optional identifier for the tool call, as assigned by the model.
		 */
		toolCallId?: string;

		/**
		 * The serialized input (arguments) passed to the tool.
		 */
		input?: string;

		/**
		 * The serialized output (result) returned by the tool.
		 */
		output?: string;

		/**
		 * The outcome of the tool call.
		 */
		result?: ChatDebugToolCallResult;

		/**
		 * How long the tool call took to complete, in milliseconds.
		 */
		durationInMillis?: number;

		/**
		 * Create a new ChatDebugToolCallEvent.
		 * @param toolName The name of the tool that was called.
		 * @param created The timestamp when the event was created.
		 */
		constructor(toolName: string, created: Date);
	}

	/**
	 * A model turn event in the chat debug log, representing a single
	 * request/response exchange with a language model.
	 */
	export class ChatDebugModelTurnEvent {
		/**
		 * A unique identifier for this event.
		 */
		id?: string;

		/**
		 * The timestamp when the event was created.
		 */
		created: Date;

		/**
		 * The id of a parent event, used to build a hierarchical tree.
		 */
		parentEventId?: string;

		/**
		 * The identifier of the model used (e.g., "gpt-4o").
		 */
		model?: string;

		/**
		 * The number of tokens in the input/prompt.
		 */
		inputTokens?: number;

		/**
		 * The number of tokens in the model's output/completion.
		 */
		outputTokens?: number;

		/**
		 * The total number of tokens consumed (input + output).
		 */
		totalTokens?: number;

		/**
		 * The estimated cost of this model turn, in US dollars.
		 */
		cost?: number;

		/**
		 * How long the model turn took to complete, in milliseconds.
		 */
		durationInMillis?: number;

		/**
		 * Create a new ChatDebugModelTurnEvent.
		 * @param created The timestamp when the event was created.
		 */
		constructor(created: Date);
	}

	/**
	 * A generic log event in the chat debug log, for unstructured or
	 * miscellaneous messages that don't fit a more specific event type.
	 */
	export class ChatDebugGenericEvent {
		/**
		 * A unique identifier for this event.
		 */
		id?: string;

		/**
		 * The timestamp when the event was created.
		 */
		created: Date;

		/**
		 * The id of a parent event, used to build a hierarchical tree.
		 */
		parentEventId?: string;

		/**
		 * A short name describing the event (e.g., "Resolved skills (start)").
		 */
		name: string;

		/**
		 * Optional details of the event.
		 */
		details?: string;

		/**
		 * The severity level of the event.
		 */
		level: ChatDebugLogLevel;

		/**
		 * The category classifying the kind of event.
		 */
		category?: string;

		/**
		 * Create a new ChatDebugGenericEvent.
		 * @param name A short name describing the event.
		 * @param level The severity level.
		 * @param created The timestamp when the event was created.
		 */
		constructor(name: string, level: ChatDebugLogLevel, created: Date);
	}

	/**
	 * The status of a sub-agent invocation.
	 */
	export enum ChatDebugSubagentStatus {
		Running = 0,
		Completed = 1,
		Failed = 2
	}

	/**
	 * A subagent invocation event in the chat debug log, representing
	 * a spawned sub-agent within a chat session.
	 */
	export class ChatDebugSubagentInvocationEvent {
		/**
		 * A unique identifier for this event.
		 */
		id?: string;

		/**
		 * The timestamp when the event was created.
		 */
		created: Date;

		/**
		 * The id of a parent event, used to build a hierarchical tree.
		 */
		parentEventId?: string;

		/**
		 * The name of the sub-agent that was invoked.
		 */
		agentName: string;

		/**
		 * A short description of the task assigned to the sub-agent.
		 */
		description?: string;

		/**
		 * The current status of the sub-agent invocation.
		 */
		status?: ChatDebugSubagentStatus;

		/**
		 * How long the sub-agent took to complete, in milliseconds.
		 */
		durationInMillis?: number;

		/**
		 * The number of tool calls made by this sub-agent.
		 */
		toolCallCount?: number;

		/**
		 * The number of model turns within this sub-agent.
		 */
		modelTurnCount?: number;

		/**
		 * Create a new ChatDebugSubagentInvocationEvent.
		 * @param agentName The name of the sub-agent.
		 * @param created The timestamp when the event was created.
		 */
		constructor(agentName: string, created: Date);
	}

	/**
	 * Union of all chat debug event types. Each type is a class,
	 * following the same pattern as {@link ChatResponsePart}.
	 */
	export type ChatDebugEvent = ChatDebugToolCallEvent | ChatDebugModelTurnEvent | ChatDebugGenericEvent | ChatDebugSubagentInvocationEvent;

	/**
	 * A provider that supplies debug events for a chat session.
	 */
	export interface ChatDebugLogProvider {
		/**
		 * Called when the debug view is opened for a chat session.
		 * The provider should return initial events and can use
		 * the progress callback to stream additional events over time.
		 *
		 * @param sessionId The ID of the chat session being debugged.
		 * @param progress A progress callback to stream events.
		 * @param token A cancellation token.
		 * @returns Initial events, if any.
		 */
		provideChatDebugLog(
			sessionId: string,
			progress: Progress<ChatDebugEvent>,
			token: CancellationToken
		): ProviderResult<ChatDebugEvent[]>;

		/**
		 * Optionally resolve the full contents of a debug event by its id.
		 * Called when the user expands an event in the debug view, allowing
		 * the provider to defer expensive detail loading until needed.
		 *
		 * @param eventId The id of the event to resolve.
		 * @param token A cancellation token.
		 * @returns The resolved event details to be displayed in the debug detail view.
		 */
		resolveChatDebugLogEvent?(
			eventId: string,
			token: CancellationToken
		): ProviderResult<string>;
	}

	export namespace chat {
		/**
		 * Register a provider that supplies debug events for chat sessions.
		 * Only one provider can be registered at a time.
		 *
		 * @param provider The chat debug log provider.
		 * @returns A disposable that unregisters the provider.
		 */
		export function registerChatDebugLogProvider(provider: ChatDebugLogProvider): Disposable;
	}
}
