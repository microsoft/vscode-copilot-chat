/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 4

declare module 'vscode' {

	export interface ChatWelcomeMessageContent {
		icon: ThemeIcon;
		title: string;
		message: MarkdownString;
	}

	export interface ChatRequesterInformation {
		name: string;

		/**
		 * A full URI for the icon of the request.
		 */
		icon?: Uri;
	}

	export interface ChatTitleProvider {
		/**
		 * TODO@API Should this take a ChatResult like the followup provider, or just take a new ChatContext that includes the current message as history?
		 */
		provideChatTitle(context: ChatContext, token: CancellationToken): ProviderResult<string>;
	}

	export interface ChatSummarizer {
		provideChatSummary(context: ChatContext, token: CancellationToken): ProviderResult<string>;
	}

	export interface ChatCodeExplanationProvider {
		/**
		 * Provide explanations for code diff hunks generated during chat editing.
		 * Each explanation will be displayed at the exact location of the corresponding diff hunk.
		 *
		 * @param context The current chat context including conversation history
		 * @param diffHunks Array of diff hunks to explain - simplified representation optimized for LLM consumption
		 * @param token A cancellation token
		 * @returns Array of explanations mapped to hunk IDs for precise location targeting
		 */
		provideCodeExplanation(context: ChatContext, diffHunks: ChatDiffHunk[], token: CancellationToken): ProviderResult<ChatDiffHunkExplanation[]>;
	}

	/**
	 * Simplified diff hunk representation optimized for:
	 * 1. Easy LLM consumption
	 * 2. Precise location mapping back to editor widgets
	 * 3. Minimal API surface for extension developers
	 */
	export interface ChatDiffHunk {
		/**
		 * The URI of the file containing this diff hunk
		 */
		uri: Uri;

		/**
		 * The programming language of the file
		 */
		language: string;

		/**
		 * The original code text (before changes)
		 */
		originalText: string;

		/**
		 * The modified code text (after changes)
		 */
		modifiedText: string;

		/**
		 * Line range in original file (1-based, inclusive)
		 */
		originalStartLine: number;
		originalEndLine: number;

		/**
		 * Line range in modified file (1-based, inclusive)
		 */
		modifiedStartLine: number;
		modifiedEndLine: number;

		/**
		 * Unique identifier mapping back to the specific diff widget in the editor
		 * This enables precise placement of explanation UI
		 */
		hunkId: string;
	}

	export interface ChatDiffHunkExplanation {
		/**
		 * The hunk ID this explanation corresponds to
		 */
		hunkId: string;

		/**
		 * The explanation for this specific diff hunk
		 */
		explanation: string | MarkdownString;

		/**
		 * Optional title for the explanation (displayed as a header)
		 */
		title?: string;

		/**
		 * Optional severity level for the change explanation
		 */
		severity?: 'info' | 'warning' | 'error';
	}

	export interface ChatParticipant {
		/**
		 * A string that will be added before the listing of chat participants in `/help`.
		 */
		helpTextPrefix?: string | MarkdownString;

		/**
		 * A string that will be appended after the listing of chat participants in `/help`.
		 */
		helpTextPostfix?: string | MarkdownString;

		additionalWelcomeMessage?: string | MarkdownString;
		titleProvider?: ChatTitleProvider;
		summarizer?: ChatSummarizer;
		codeExplanationProvider?: ChatCodeExplanationProvider;
		requester?: ChatRequesterInformation;
	}
}
