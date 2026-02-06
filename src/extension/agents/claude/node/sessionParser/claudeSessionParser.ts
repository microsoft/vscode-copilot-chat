/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Claude Code Session Parser
 *
 * This module handles parsing JSONL session files with comprehensive error reporting.
 * It transforms raw session entries into a structured format for use in the extension.
 *
 * ## Key Features
 * - Type-safe validation of all entry types
 * - Detailed error reporting for schema mismatches
 * - Parent chain resolution for message threading
 * - Session deduplication for parallel branches
 *
 * ## Error Reporting
 * When encountering invalid data, the parser:
 * 1. Logs detailed error information including line number and content
 * 2. Continues parsing remaining lines (fault-tolerant)
 * 3. Aggregates all errors for debugging
 */

import {
	AssistantMessageEntry,
	ChainLinkEntry,
	IClaudeCodeSession,
	IClaudeCodeSessionInfo,
	isAssistantMessageEntry,
	isChainLinkEntry,
	isSummaryEntry,
	ISubagentSession,
	isUserMessageEntry,
	ParseError,
	parseSessionEntry,
	StoredMessage,
	SummaryEntry,
	UserMessageEntry,
	vMessageEntry,
	vSummaryEntry,
} from './claudeSessionSchema';

export { ParseError };

// #region Types

/**
 * Result of parsing a session file.
 */
export interface SessionFileParseResult {
	/** Successfully parsed messages indexed by UUID */
	readonly messages: ReadonlyMap<string, StoredMessage>;
	/** Summary entries indexed by leaf UUID */
	readonly summaries: ReadonlyMap<string, SummaryEntry>;
	/** Chain link entries indexed by UUID for parent resolution */
	readonly chainLinks: ReadonlyMap<string, ChainLinkEntry>;
	/** Errors encountered during parsing */
	readonly errors: readonly ParseError[];
	/** Statistics about the parse */
	readonly stats: ParseStats;
}

/**
 * Statistics from parsing a session file.
 */
export interface ParseStats {
	readonly totalLines: number;
	readonly userMessages: number;
	readonly assistantMessages: number;
	readonly summaries: number;
	readonly chainLinks: number;
	readonly queueOperations: number;
	readonly errors: number;
	readonly skippedEmpty: number;
}

/**
 * Result of building sessions from parsed messages.
 */
export interface SessionBuildResult {
	readonly sessions: readonly IClaudeCodeSession[];
	readonly errors: readonly string[];
}

// #endregion

// #region Session File Parser

/**
 * Parse a session file's content into structured data.
 *
 * @param content The raw UTF-8 content of a .jsonl session file
 * @param fileIdentifier Optional identifier for error messages (e.g., file path)
 * @returns ParseResult with messages, summaries, chain links, and errors
 */
export function parseSessionFileContent(
	content: string,
	fileIdentifier?: string
): SessionFileParseResult {
	const messages = new Map<string, StoredMessage>();
	const summaries = new Map<string, SummaryEntry>();
	const chainLinks = new Map<string, ChainLinkEntry>();
	const errors: ParseError[] = [];

	const stats: {
		totalLines: number;
		userMessages: number;
		assistantMessages: number;
		summaries: number;
		chainLinks: number;
		queueOperations: number;
		errors: number;
		skippedEmpty: number;
	} = {
		totalLines: 0,
		userMessages: 0,
		assistantMessages: 0,
		summaries: 0,
		chainLinks: 0,
		queueOperations: 0,
		errors: 0,
		skippedEmpty: 0,
	};

	// Split content into lines and parse each
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		stats.totalLines++;

		// Skip empty lines
		if (line.length === 0) {
			stats.skippedEmpty++;
			continue;
		}

		const lineNumber = i + 1;
		const result = parseSessionEntry(line, lineNumber);

		if (!result.success) {
			stats.errors++;
			errors.push({
				...result.error,
				message: fileIdentifier
					? `[${fileIdentifier}:${lineNumber}] ${result.error.message}`
					: result.error.message,
			});
			continue;
		}

		const entry = result.value;

		// Process based on entry type
		if (isUserMessageEntry(entry)) {
			stats.userMessages++;
			const stored = reviveUserMessage(entry);
			messages.set(entry.uuid, stored);
		} else if (isAssistantMessageEntry(entry)) {
			stats.assistantMessages++;
			const stored = reviveAssistantMessage(entry);
			messages.set(entry.uuid, stored);
		} else if (isSummaryEntry(entry)) {
			stats.summaries++;
			// Skip invalid summaries (API errors, etc.)
			const summary = entry.summary.toLowerCase();
			if (!summary.startsWith('api error:') && !summary.startsWith('invalid api key')) {
				summaries.set(entry.leafUuid, entry);
			}
		} else if (isChainLinkEntry(entry)) {
			stats.chainLinks++;
			chainLinks.set(entry.uuid, entry);
		} else {
			// Queue operations and other entries are tracked but not stored
			stats.queueOperations++;
		}
	}

	return {
		messages,
		summaries,
		chainLinks,
		errors,
		stats,
	};
}

// #endregion

// #region Message Revival

/**
 * Convert a user message entry's timestamp from string to Date.
 */
function reviveUserMessage(entry: UserMessageEntry): StoredMessage {
	return {
		uuid: entry.uuid,
		sessionId: entry.sessionId,
		timestamp: new Date(entry.timestamp),
		parentUuid: entry.parentUuid ?? null,
		type: 'user',
		message: entry.message,
		isSidechain: entry.isSidechain,
		userType: entry.userType,
		cwd: entry.cwd,
		version: entry.version,
		gitBranch: entry.gitBranch,
		slug: entry.slug,
		agentId: entry.agentId,
	};
}

/**
 * Convert an assistant message entry's timestamp from string to Date.
 */
function reviveAssistantMessage(entry: AssistantMessageEntry): StoredMessage {
	return {
		uuid: entry.uuid,
		sessionId: entry.sessionId,
		timestamp: new Date(entry.timestamp),
		parentUuid: entry.parentUuid ?? null,
		type: 'assistant',
		message: entry.message,
		isSidechain: entry.isSidechain,
		userType: entry.userType,
		cwd: entry.cwd,
		version: entry.version,
		gitBranch: entry.gitBranch,
		slug: entry.slug,
		agentId: entry.agentId,
	};
}

// #endregion

// #region Session Building

/**
 * Minimal chain link interface for parent resolution.
 * Only uuid and parentUuid are needed for chain building.
 */
interface ChainLinkLike {
	readonly uuid: string;
	readonly parentUuid: string | null;
}

/**
 * Build sessions from parsed message maps.
 * This handles:
 * - Finding leaf nodes (messages not referenced as parents)
 * - Building message chains from leaf to root
 * - Resolving parent UUIDs through chain links
 * - Deduplicating sessions by ID
 */
export function buildSessions(
	messages: ReadonlyMap<string, StoredMessage>,
	summaries: ReadonlyMap<string, SummaryEntry>,
	chainLinks: ReadonlyMap<string, ChainLinkLike>
): SessionBuildResult {
	const errors: string[] = [];

	// Build a set of all UUIDs referenced as parents
	const referencedAsParent = new Set<string>();
	for (const message of messages.values()) {
		if (message.parentUuid !== null) {
			referencedAsParent.add(message.parentUuid);
		}
	}
	for (const chainLink of chainLinks.values()) {
		if (chainLink.parentUuid !== null) {
			referencedAsParent.add(chainLink.parentUuid);
		}
	}

	// Find leaf nodes (messages not referenced as parents)
	const leafNodes = new Set<string>();
	for (const uuid of messages.keys()) {
		if (!referencedAsParent.has(uuid)) {
			leafNodes.add(uuid);
		}
	}

	// Build sessions from leaf nodes
	const sessions: IClaudeCodeSession[] = [];
	for (const leafUuid of leafNodes) {
		const result = buildSessionFromLeaf(leafUuid, messages, summaries, chainLinks);
		if (result.success) {
			sessions.push(result.session);
		} else {
			errors.push(result.error);
		}
	}

	// Deduplicate sessions by ID, keeping the one with most messages
	const deduplicatedSessions = deduplicateSessions(sessions);

	return {
		sessions: deduplicatedSessions,
		errors,
	};
}

/**
 * Build a single session by following the parent chain from a leaf node.
 */
function buildSessionFromLeaf(
	leafUuid: string,
	messages: ReadonlyMap<string, StoredMessage>,
	summaries: ReadonlyMap<string, SummaryEntry>,
	chainLinks: ReadonlyMap<string, ChainLinkLike>
): { success: true; session: IClaudeCodeSession } | { success: false; error: string } {
	const messageChain: StoredMessage[] = [];
	const visited = new Set<string>();
	let currentUuid: string | null = leafUuid;
	let summaryEntry: SummaryEntry | undefined;

	// Follow parent chain to build complete message history
	while (currentUuid !== null) {
		// Cycle detection
		if (visited.has(currentUuid)) {
			break; // Stop at cycle but keep messages we've collected
		}
		visited.add(currentUuid);

		// Check for summary at this point
		const summary = summaries.get(currentUuid);
		if (summary !== undefined) {
			summaryEntry = summary;
		}

		// Try to get the message
		const message = messages.get(currentUuid);
		if (message !== undefined) {
			messageChain.unshift(message);
			currentUuid = resolveParentUuid(message.parentUuid, messages, chainLinks, visited);
		} else {
			// Message not found - try chain links
			const chainLink = chainLinks.get(currentUuid);
			if (chainLink !== undefined) {
				currentUuid = resolveParentUuid(chainLink.parentUuid, messages, chainLinks, visited);
			} else {
				// Dead end - couldn't find message or chain link
				break;
			}
		}
	}

	// Need at least one message to create a session
	if (messageChain.length === 0) {
		return {
			success: false,
			error: `No messages found for leaf UUID: ${leafUuid}`,
		};
	}

	const leafMessage = messages.get(leafUuid);
	if (leafMessage === undefined) {
		return {
			success: false,
			error: `Leaf message not found: ${leafUuid}`,
		};
	}

	const session: IClaudeCodeSession = {
		id: leafMessage.sessionId,
		label: generateSessionLabel(summaryEntry, messageChain),
		messages: messageChain,
		timestamp: messageChain[messageChain.length - 1].timestamp,
		subagents: [],
	};

	return { success: true, session };
}

/**
 * Resolve a parent UUID through chain links if needed.
 * Chain links are meta-entries that exist only for parent resolution.
 */
function resolveParentUuid(
	parentUuid: string | null,
	messages: ReadonlyMap<string, StoredMessage>,
	chainLinks: ReadonlyMap<string, ChainLinkLike>,
	visited: Set<string>
): string | null {
	let current = parentUuid;

	while (current !== null) {
		// Cycle detection
		if (visited.has(current)) {
			return current;
		}

		// If it's a real message, return it
		if (messages.has(current)) {
			return current;
		}

		// Try to resolve through chain link
		const chainLink = chainLinks.get(current);
		if (chainLink === undefined) {
			return current; // Dead end, return as-is
		}

		visited.add(current);
		current = chainLink.parentUuid;
	}

	return null;
}

/**
 * Generate a display label for a session.
 */
function generateSessionLabel(
	summaryEntry: SummaryEntry | undefined,
	messages: readonly StoredMessage[]
): string {
	// Use summary if available
	if (summaryEntry && summaryEntry.summary.length > 0) {
		return summaryEntry.summary;
	}

	// Find first user message to use as label
	for (const message of messages) {
		if (message.type !== 'user') {
			continue;
		}

		const userMessage = message.message;
		if (userMessage.role !== 'user') {
			continue;
		}

		const content = userMessage.content;
		let text: string | undefined;

		if (typeof content === 'string') {
			text = stripSystemReminders(content);
		} else if (Array.isArray(content)) {
			// Find first text block
			for (const block of content) {
				if (block.type === 'text' && 'text' in block) {
					text = stripSystemReminders(block.text);
					if (text.length > 0) {
						break;
					}
				}
			}
		}

		if (text !== undefined && text.length > 0) {
			// Return first line or first 50 characters
			const firstLine = getFirstNonEmptyLine(text);
			return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
		}
	}

	return 'Claude Session';
}

/**
 * Strip <system-reminder> tags from text content.
 * Uses string-based approach instead of regex with non-greedy matching
 * to avoid backtracking overhead on large text blocks.
 */
function stripSystemReminders(text: string): string {
	const openTag = '<system-reminder>';
	const closeTag = '</system-reminder>';
	let result = text;
	let startIdx: number;

	while ((startIdx = result.indexOf(openTag)) !== -1) {
		const endIdx = result.indexOf(closeTag, startIdx + openTag.length);
		if (endIdx === -1) {
			// No closing tag found, stop processing
			break;
		}
		// Remove the tag and any trailing whitespace
		let removeEnd = endIdx + closeTag.length;
		while (removeEnd < result.length && (result[removeEnd] === ' ' || result[removeEnd] === '\n' || result[removeEnd] === '\r' || result[removeEnd] === '\t')) {
			removeEnd++;
		}
		result = result.substring(0, startIdx) + result.substring(removeEnd);
	}

	return result.trim();
}

/**
 * Get the first non-empty line from text without allocating an array for all lines.
 * More efficient than split('\n').find() for potentially large strings.
 */
function getFirstNonEmptyLine(text: string): string {
	let start = 0;
	while (start < text.length) {
		const end = text.indexOf('\n', start);
		const lineEnd = end === -1 ? text.length : end;
		const line = text.substring(start, lineEnd);
		if (line.trim().length > 0) {
			return line;
		}
		start = lineEnd + 1;
	}
	return '';
}

/**
 * Deduplicate sessions by ID, keeping the one with the most messages.
 * This handles orphaned branches from parallel tool calls.
 */
function deduplicateSessions(sessions: readonly IClaudeCodeSession[]): readonly IClaudeCodeSession[] {
	const sessionById = new Map<string, IClaudeCodeSession>();

	for (const session of sessions) {
		const existing = sessionById.get(session.id);
		if (existing === undefined || session.messages.length > existing.messages.length) {
			sessionById.set(session.id, session);
		}
	}

	return Array.from(sessionById.values());
}

/**
 * Build an ISubagentSession from parsed file content.
 * Subagent files have the same format as main session files.
 * The agentId is extracted from the filename or from the messages.
 */
export function buildSubagentSession(
	agentId: string,
	messages: ReadonlyMap<string, StoredMessage>,
	chainLinks: ReadonlyMap<string, ChainLinkLike>
): ISubagentSession | null {
	// Build message chain from scratch - subagent files are typically linear
	// Find leaf nodes (messages not referenced as parents)
	const referencedAsParent = new Set<string>();
	for (const message of messages.values()) {
		if (message.parentUuid !== null) {
			referencedAsParent.add(message.parentUuid);
		}
	}
	for (const chainLink of chainLinks.values()) {
		if (chainLink.parentUuid !== null) {
			referencedAsParent.add(chainLink.parentUuid);
		}
	}

	const leafUuids: string[] = [];
	for (const uuid of messages.keys()) {
		if (!referencedAsParent.has(uuid)) {
			leafUuids.push(uuid);
		}
	}

	if (leafUuids.length === 0) {
		return null;
	}

	// Build chain from the leaf with the most messages
	let bestChain: StoredMessage[] = [];

	for (const leafUuid of leafUuids) {
		const chain: StoredMessage[] = [];
		const visited = new Set<string>();
		let currentUuid: string | null = leafUuid;

		while (currentUuid !== null) {
			if (visited.has(currentUuid)) {
				break;
			}
			visited.add(currentUuid);

			const message = messages.get(currentUuid);
			if (message !== undefined) {
				chain.unshift(message);
				currentUuid = message.parentUuid;
			} else {
				const chainLink = chainLinks.get(currentUuid);
				if (chainLink !== undefined) {
					currentUuid = chainLink.parentUuid;
				} else {
					break;
				}
			}
		}

		if (chain.length > bestChain.length) {
			bestChain = chain;
		}
	}

	if (bestChain.length === 0) {
		return null;
	}

	return {
		agentId,
		messages: bestChain,
		timestamp: bestChain[bestChain.length - 1].timestamp,
	};
}

// #endregion

// #region Lightweight Metadata Extraction

/**
 * Extract only metadata from a session file without full parsing.
 * This is faster than parseSessionFileContent because it:
 * - Only looks for summary entries and first message timestamp
 * - Doesn't build message chains or store full content
 * - Stops early once all needed data is found
 *
 * Uses validators for type safety while keeping string pre-filtering
 * for fast rejection of irrelevant lines.
 *
 * @param content The raw UTF-8 content of a .jsonl session file
 * @param sessionId Session ID (from filename)
 * @param fileMtime File modification time as fallback timestamp
 * @returns Lightweight session metadata
 */
export function extractSessionMetadata(
	content: string,
	sessionId: string,
	fileMtime: Date
): IClaudeCodeSessionInfo | null {
	const state = {
		summary: undefined as string | undefined,
		firstMessageTimestamp: undefined as Date | undefined,
		lastMessageTimestamp: undefined as Date | undefined,
		firstUserMessageContent: undefined as string | undefined,
		foundSessionId: false,
	};

	const lines = content.split('\n');

	for (const line of lines) {
		const trimmed = line.trim();
		const { shouldContinue } = processLineForMetadata(trimmed, state);
		if (!shouldContinue) {
			break;
		}
	}

	return buildMetadataResult(sessionId, fileMtime, state);
}

/**
 * State object for metadata extraction.
 */
interface MetadataExtractionState {
	summary: string | undefined;
	firstMessageTimestamp: Date | undefined;
	lastMessageTimestamp: Date | undefined;
	firstUserMessageContent: string | undefined;
	foundSessionId: boolean;
}

/**
 * Process a single line for metadata extraction.
 * Uses validators for type safety while keeping string pre-filtering for performance.
 *
 * @returns Whether to continue processing more lines
 */
function processLineForMetadata(
	trimmed: string,
	state: MetadataExtractionState
): { shouldContinue: boolean } {
	if (trimmed.length === 0) {
		return { shouldContinue: true };
	}

	// Fast string check before JSON.parse - skip lines that can't match
	const mightBeSummary = trimmed.includes('"type":"summary"') || trimmed.includes('"type": "summary"');
	const mightBeMessage = (
		trimmed.includes('"type":"user"') || trimmed.includes('"type": "user"') ||
		trimmed.includes('"type":"assistant"') || trimmed.includes('"type": "assistant"')
	);

	if (!mightBeSummary && !mightBeMessage) {
		return { shouldContinue: true };
	}

	// Parse JSON and validate with schema validators
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { shouldContinue: true };
	}

	// Try summary validation
	if (mightBeSummary) {
		const summaryResult = vSummaryEntry.validate(parsed);
		if (!summaryResult.error) {
			const summaryText = summaryResult.content.summary.toLowerCase();
			// Skip invalid summaries (API errors, etc.)
			if (!summaryText.startsWith('api error:') && !summaryText.startsWith('invalid api key')) {
				state.summary = summaryResult.content.summary;
			}
		}
		return { shouldContinue: true };
	}

	// Try message validation - always process to track both first and last timestamps
	if (mightBeMessage) {
		const messageResult = vMessageEntry.validate(parsed);
		if (!messageResult.error) {
			const entry = messageResult.content;
			const messageTimestamp = new Date(entry.timestamp);

			// Track first message timestamp and content
			if (state.firstMessageTimestamp === undefined) {
				state.foundSessionId = true;
				state.firstMessageTimestamp = messageTimestamp;

				// Extract user message content for label fallback
				if (entry.type === 'user') {
					const msgContent = entry.message.content;
					if (typeof msgContent === 'string') {
						state.firstUserMessageContent = msgContent;
					} else if (Array.isArray(msgContent)) {
						for (const block of msgContent) {
							if (block.type === 'text' && 'text' in block) {
								state.firstUserMessageContent = block.text;
								break;
							}
						}
					}
				}
			}

			// Always update last message timestamp (messages are chronological in file)
			state.lastMessageTimestamp = messageTimestamp;
		}
	}

	// No early termination - we need to read all messages to get lastMessageTimestamp
	return { shouldContinue: true };
}

/**
 * Build final metadata result from extraction state.
 */
function buildMetadataResult(
	sessionId: string,
	_fileMtime: Date,
	state: MetadataExtractionState
): IClaudeCodeSessionInfo | null {
	// Require at least one message for a valid session
	if (state.firstMessageTimestamp === undefined || state.lastMessageTimestamp === undefined) {
		return null;
	}

	// Generate label
	let label = state.summary;
	if (label === undefined && state.firstUserMessageContent !== undefined) {
		const stripped = stripSystemReminders(state.firstUserMessageContent);
		const firstLine = getFirstNonEmptyLine(stripped);
		label = firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
	}
	if (!label) {
		label = 'Claude Session';
	}

	return {
		id: sessionId,
		label,
		timestamp: state.firstMessageTimestamp,
		firstMessageTimestamp: state.firstMessageTimestamp,
		lastMessageTimestamp: state.lastMessageTimestamp,
	};
}

/**
 * Extract metadata from a session file using streaming to minimize memory usage.
 *
 * This is optimized for listing many sessions where we only need basic metadata.
 * It reads the file line-by-line to extract timestamps and labels without
 * loading entire large session files into memory.
 *
 * @param filePath The filesystem path to the .jsonl session file
 * @param sessionId Session ID (from filename)
 * @param fileMtime File modification time as fallback timestamp
 * @param signal Optional AbortSignal to cancel the operation
 * @returns Promise resolving to lightweight session metadata, or null if invalid
 */
export async function extractSessionMetadataStreaming(
	filePath: string,
	sessionId: string,
	fileMtime: Date,
	signal?: AbortSignal
): Promise<IClaudeCodeSessionInfo | null> {
	const fs = await import('fs');
	const readline = await import('readline');

	const state: MetadataExtractionState = {
		summary: undefined,
		firstMessageTimestamp: undefined,
		lastMessageTimestamp: undefined,
		firstUserMessageContent: undefined,
		foundSessionId: false,
	};

	return new Promise((resolve, reject) => {
		const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
		const rl = readline.createInterface({
			input: stream,
			crlfDelay: Infinity,
		});

		let aborted = false;
		let earlyTerminationResult: IClaudeCodeSessionInfo | null | undefined;

		const cleanup = () => {
			rl.close();
			stream.destroy();
		};

		const onAbort = () => {
			aborted = true;
			cleanup();
			reject(new Error('Operation cancelled'));
		};

		if (signal) {
			if (signal.aborted) {
				reject(new Error('Operation cancelled'));
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}

		rl.on('line', (line) => {
			if (aborted) {
				return;
			}

			const trimmed = line.trim();
			const { shouldContinue } = processLineForMetadata(trimmed, state);

			if (!shouldContinue) {
				// Mark for early termination - will resolve when 'close' fires
				earlyTerminationResult = buildMetadataResult(sessionId, fileMtime, state);
				cleanup();
			}
		});

		rl.on('close', () => {
			if (aborted) {
				return;
			}
			signal?.removeEventListener('abort', onAbort);
			// If we terminated early, use that result; otherwise compute from final state
			const result = earlyTerminationResult !== undefined
				? earlyTerminationResult
				: buildMetadataResult(sessionId, fileMtime, state);
			resolve(result);
		});

		rl.on('error', (err) => {
			signal?.removeEventListener('abort', onAbort);
			reject(err);
		});

		stream.on('error', (err) => {
			signal?.removeEventListener('abort', onAbort);
			reject(err);
		});
	});
}

// #endregion
