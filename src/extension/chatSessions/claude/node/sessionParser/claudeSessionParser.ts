/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Claude Code Session Parser
 *
 * Parses JSONL session files using a 3-layer architecture:
 *
 * **Layer 1** — `extractSessionMetadata` / `extractSessionMetadataStreaming`
 * Lightweight metadata extraction for listing sessions. No chain building.
 *
 * **Layer 2** — `parseSessionFileContent`
 * Builds a linked list from JSONL. Every UUID-bearing entry becomes a ChainNode
 * in a single map. No classification into buckets — just chain metadata + raw JSON.
 *
 * **Layer 3** — `buildSessions`
 * Walks the linked list from leaf to root, validates visible entries, and
 * produces StoredMessage[] for display.
 */

import {
	AssistantMessageEntry,
	ChainNode,
	CustomTitleEntry,
	IClaudeCodeSession,
	IClaudeCodeSessionInfo,
	ISubagentSession,
	isUserRequest,
	StoredMessage,
	SummaryEntry,
	UserMessageEntry,
	vAssistantMessageEntry,
	vChainNodeFields,
	vCustomTitleEntry,
	vMessageEntry,
	vSummaryEntry,
	vUserMessageEntry,
} from './claudeSessionSchema';

// #region Types

/**
 * Detailed error for failed parsing.
 */
export interface ParseError {
	lineNumber: number;
	message: string;
	line: string;
	parsedType?: string;
}

/**
 * Result of parsing a session file (Layer 2 output).
 */
export interface LinkedListParseResult {
	/** All UUID-bearing entries indexed by UUID */
	readonly nodes: ReadonlyMap<string, ChainNode>;
	/** Summary entries indexed by leaf UUID */
	readonly summaries: ReadonlyMap<string, SummaryEntry>;
	/** Custom title entry from /rename command, if present */
	readonly customTitle: CustomTitleEntry | undefined;
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
	readonly chainNodes: number;
	readonly summaries: number;
	readonly customTitles: number;
	readonly queueOperations: number;
	readonly errors: number;
	readonly skippedEmpty: number;
}

/**
 * Result of building sessions from the linked list (Layer 3 output).
 */
export interface SessionBuildResult {
	readonly sessions: readonly IClaudeCodeSession[];
	readonly errors: readonly string[];
}

// #endregion

// #region Layer 2 — Linked List Parser

/**
 * Parse a session file's content into a linked list of chain nodes.
 *
 * This is Layer 2 of the parser architecture. Every JSONL line with a `uuid`
 * becomes a ChainNode in a single map. No classification into separate buckets.
 * The effective parent is `logicalParentUuid ?? parentUuid`, which handles
 * compact boundaries transparently.
 *
 * @param content The raw UTF-8 content of a .jsonl session file
 * @param fileIdentifier Optional identifier for error messages (e.g., file path)
 * @returns LinkedListParseResult with nodes, summaries, and errors
 */
export function parseSessionFileContent(
	content: string,
	fileIdentifier?: string
): LinkedListParseResult {
	const nodes = new Map<string, ChainNode>();
	const summaries = new Map<string, SummaryEntry>();
	const errors: ParseError[] = [];
	let customTitle: CustomTitleEntry | undefined;

	const stats = {
		totalLines: 0,
		chainNodes: 0,
		summaries: 0,
		customTitles: 0,
		queueOperations: 0,
		errors: 0,
		skippedEmpty: 0,
	};

	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		stats.totalLines++;

		if (line.length === 0) {
			stats.skippedEmpty++;
			continue;
		}

		const lineNumber = i + 1;

		// Parse JSON
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (e) {
			stats.errors++;
			const message = e instanceof Error ? e.message : String(e);
			errors.push({
				lineNumber,
				message: fileIdentifier
					? `[${fileIdentifier}:${lineNumber}] JSON parse error: ${message}`
					: `JSON parse error: ${message}`,
				line: line.length > 100 ? line.substring(0, 100) + '...' : line,
			});
			continue;
		}

		if (typeof parsed !== 'object' || parsed === null) {
			stats.errors++;
			errors.push({
				lineNumber,
				message: fileIdentifier
					? `[${fileIdentifier}:${lineNumber}] Expected object, got ${typeof parsed}`
					: `Expected object, got ${typeof parsed}`,
				line: line.length > 100 ? line.substring(0, 100) + '...' : line,
			});
			continue;
		}

		const raw = parsed as Record<string, unknown>;

		// Try custom title entry (user-assigned session name via /rename)
		const customTitleResult = vCustomTitleEntry.validate(parsed);
		if (!customTitleResult.error) {
			stats.customTitles++;
			customTitle = customTitleResult.content;
			continue;
		}

		// Try summary entry first (has no uuid/parentUuid chain)
		const summaryResult = vSummaryEntry.validate(parsed);
		if (!summaryResult.error) {
			stats.summaries++;
			const summary = summaryResult.content.summary.toLowerCase();
			if (!summary.startsWith('api error:') && !summary.startsWith('invalid api key')) {
				summaries.set(summaryResult.content.leafUuid, summaryResult.content);
			}
			continue;
		}

		// Try extracting chain node fields (uuid + parent info)
		const chainResult = vChainNodeFields.validate(parsed);
		if (!chainResult.error) {
			stats.chainNodes++;
			const { uuid, logicalParentUuid, parentUuid } = chainResult.content;
			nodes.set(uuid, {
				uuid,
				parentUuid: logicalParentUuid ?? parentUuid ?? null,
				raw,
				lineNumber,
			});
			continue;
		}

		// No uuid — likely a queue-operation or other non-chain entry
		if ('type' in raw && raw.type === 'queue-operation') {
			stats.queueOperations++;
		} else {
			// Unknown entry — not a hard error, just skip
			stats.queueOperations++;
		}
	}

	return {
		nodes,
		summaries,
		customTitle,
		errors,
		stats,
	};
}

// #endregion

// #region Layer 3 — Session Building

/**
 * Check if a chain node represents a visible entry.
 *
 * The generalized rule: if the entry has displayable content (a `message`
 * field for user/assistant entries or a string `content` field for system
 * entries), it is visible — unless one of the hiding booleans is set.
 */
function isVisibleNode(raw: Record<string, unknown>): boolean {
	// Must have displayable content
	const hasMessage = 'message' in raw && (raw.type === 'user' || raw.type === 'assistant');
	const hasSystemContent = typeof raw.content === 'string' && (raw.content as string).length > 0 && raw.type !== 'user' && raw.type !== 'assistant';
	if (!hasMessage && !hasSystemContent) {
		return false;
	}
	// Compact summaries are synthetic and should not be rendered
	if (raw.isCompactSummary === true) {
		return false;
	}
	// Meta entries and transcript-only entries are not rendered
	if (raw.isVisibleInTranscriptOnly === true) {
		return false;
	}
	if (raw.isMeta === true) {
		return false;
	}
	return true;
}

/**
 * Validate a visible node's raw data and produce a StoredMessage.
 * Returns null if validation fails.
 */
function validateAndReviveNode(node: ChainNode): StoredMessage | null {
	const raw = node.raw;

	if (raw.type === 'user') {
		const result = vUserMessageEntry.validate(raw);
		if (result.error) {
			return null;
		}
		return reviveUserMessage(result.content);
	}

	if (raw.type === 'assistant') {
		const result = vAssistantMessageEntry.validate(raw);
		if (result.error) {
			return null;
		}
		return reviveAssistantMessage(result.content);
	}

	// System entries (e.g., compact_boundary) with string content
	if (typeof raw.content === 'string') {
		return reviveSystemMessage(node);
	}

	return null;
}

/**
 * Build sessions from the linked list (Layer 3).
 *
 * This walks the linked list from leaf nodes to root, validates visible entries,
 * and produces StoredMessage[] for each session.
 *
 * Leaf detection: A node is a leaf if no other node's parentUuid points to it.
 * Since all entries are in one map, progress entries at the end of a chain become
 * additional leaves. Deduplication by sessionId keeps the longest visible chain,
 * so these extra leaves don't cause problems.
 */
export function buildSessions(
	parseResult: LinkedListParseResult
): SessionBuildResult {
	const { nodes, summaries, customTitle } = parseResult;
	const errors: string[] = [];

	// Build referencedAsParent from ALL nodes
	const referencedAsParent = new Set<string>();
	for (const node of nodes.values()) {
		if (node.parentUuid !== null) {
			referencedAsParent.add(node.parentUuid);
		}
	}

	// Find leaf nodes
	const leafNodes: string[] = [];
	for (const uuid of nodes.keys()) {
		if (!referencedAsParent.has(uuid)) {
			leafNodes.push(uuid);
		}
	}

	// Build sessions from leaf nodes
	const sessions: IClaudeCodeSession[] = [];
	for (const leafUuid of leafNodes) {
		const result = buildSessionFromLeaf(leafUuid, nodes, summaries, customTitle);
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
 * Build a single session by walking the linked list from a leaf node.
 */
function buildSessionFromLeaf(
	leafUuid: string,
	nodes: ReadonlyMap<string, ChainNode>,
	summaries: ReadonlyMap<string, SummaryEntry>,
	customTitle: CustomTitleEntry | undefined
): { success: true; session: IClaudeCodeSession } | { success: false; error: string } {
	const messageChain: StoredMessage[] = [];
	const visited = new Set<string>();
	let currentUuid: string | null = leafUuid;
	let summaryEntry: SummaryEntry | undefined;
	let sessionId: string | undefined;

	// Walk from leaf to root, collecting visible messages
	while (currentUuid !== null) {
		if (visited.has(currentUuid)) {
			break; // Cycle detection
		}
		visited.add(currentUuid);

		// Check for summary at this point
		const summary = summaries.get(currentUuid);
		if (summary !== undefined) {
			summaryEntry = summary;
		}

		const node = nodes.get(currentUuid);
		if (node === undefined) {
			break; // Dead end
		}

		// Only validate and include visible message nodes
		if (isVisibleNode(node.raw)) {
			const storedMessage = validateAndReviveNode(node);
			if (storedMessage !== null) {
				messageChain.unshift(storedMessage);
				if (sessionId === undefined) {
					sessionId = storedMessage.sessionId;
				}
			}
		}

		currentUuid = node.parentUuid;
	}

	if (messageChain.length === 0 || sessionId === undefined) {
		return {
			success: false,
			error: `No visible messages found for leaf UUID: ${leafUuid}`,
		};
	}

	// Collect parallel tool result siblings that branched off the main chain.
	// When parallel tool calls occur, each tool_use assistant message is chained
	// linearly, but results come back pointing to their respective tool_use message.
	// Only the last result is in the main chain; the others are orphaned siblings.
	const chainUuids = new Set(messageChain.map(m => m.uuid));
	const siblings: StoredMessage[] = [];
	for (const node of nodes.values()) {
		if (chainUuids.has(node.uuid)) {
			continue; // Already in chain
		}
		if (node.parentUuid === null || !chainUuids.has(node.parentUuid)) {
			continue; // Parent not in chain
		}
		if (!isVisibleNode(node.raw)) {
			continue;
		}
		// Only collect user messages whose parent is an assistant message
		const storedMessage = validateAndReviveNode(node);
		if (storedMessage === null || storedMessage.type !== 'user') {
			continue;
		}
		const parentMessage = messageChain.find(m => m.uuid === node.parentUuid);
		if (parentMessage !== undefined && parentMessage.type === 'assistant') {
			siblings.push(storedMessage);
		}
	}

	// Insert siblings into the chain right after their parent
	for (const sibling of siblings) {
		const parentIndex = messageChain.findIndex(m => m.uuid === sibling.parentUuid);
		if (parentIndex !== -1) {
			messageChain.splice(parentIndex + 1, 0, sibling);
			chainUuids.add(sibling.uuid);
		}
	}

	const session: IClaudeCodeSession = {
		id: sessionId,
		label: generateSessionLabel(customTitle, summaryEntry, messageChain),
		messages: messageChain,
		created: messageChain[0].timestamp.getTime(),
		lastRequestStarted: findLastRequestStartedTimestamp(messageChain),
		lastRequestEnded: messageChain[messageChain.length - 1].timestamp.getTime(),
		subagents: [],
	};

	return { success: true, session };
}

// #endregion

// #region Message Revival

/**
 * Convert a validated user message entry into a StoredMessage.
 */
function reviveUserMessage(entry: UserMessageEntry): StoredMessage {
	let toolUseResultAgentId: string | undefined;
	if (entry.toolUseResult && typeof entry.toolUseResult === 'object' && 'agentId' in entry.toolUseResult && typeof entry.toolUseResult.agentId === 'string') {
		toolUseResultAgentId = entry.toolUseResult.agentId;
	}

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
		toolUseResultAgentId,
	};
}

/**
 * Convert a validated assistant message entry into a StoredMessage.
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

/**
 * Convert a system chain node into a StoredMessage.
 * System entries (e.g., compact_boundary) carry a plain string `content` field.
 */
function reviveSystemMessage(node: ChainNode): StoredMessage | null {
	const raw = node.raw;
	const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
	const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : undefined;
	const content = typeof raw.content === 'string' ? raw.content : undefined;

	if (!sessionId || !timestamp || !content) {
		return null;
	}

	return {
		uuid: node.uuid,
		sessionId,
		timestamp: new Date(timestamp),
		parentUuid: node.parentUuid,
		type: 'system',
		message: { role: 'system', content },
		version: typeof raw.version === 'string' ? raw.version : undefined,
	};
}

// #endregion

// #region Session Helpers

/**
 * Generate a display label for a session.
 * Priority: custom title > summary > first user message > fallback.
 */
function generateSessionLabel(
	customTitle: CustomTitleEntry | undefined,
	summaryEntry: SummaryEntry | undefined,
	messages: readonly StoredMessage[]
): string {
	if (customTitle && customTitle.customTitle.length > 0) {
		return customTitle.customTitle;
	}

	if (summaryEntry && summaryEntry.summary.length > 0) {
		return summaryEntry.summary;
	}

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
			const firstLine = getFirstNonEmptyLine(text);
			return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
		}
	}

	return 'Claude Session';
}

/**
 * Strip <system-reminder> tags from text content.
 */
function stripSystemReminders(text: string): string {
	const openTag = '<system-reminder>';
	const closeTag = '</system-reminder>';
	let result = text;
	let startIdx: number;

	while ((startIdx = result.indexOf(openTag)) !== -1) {
		const endIdx = result.indexOf(closeTag, startIdx + openTag.length);
		if (endIdx === -1) {
			break;
		}
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
 * Find the timestamp of the last genuine user request in a message chain.
 */
function findLastRequestStartedTimestamp(messages: readonly StoredMessage[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.type === 'user' && msg.message.role === 'user' && isUserRequest(msg.message.content)) {
			return msg.timestamp.getTime();
		}
	}
	return undefined;
}

/**
 * Deduplicate sessions by ID, keeping the one with the most messages.
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

// #endregion

// #region Subagent Building

/**
 * Build an ISubagentSession from parsed file content.
 * Subagent files have the same JSONL format as main session files.
 */
export function buildSubagentSession(
	agentId: string,
	parseResult: LinkedListParseResult
): ISubagentSession | null {
	const { nodes } = parseResult;

	// Find leaf nodes
	const referencedAsParent = new Set<string>();
	for (const node of nodes.values()) {
		if (node.parentUuid !== null) {
			referencedAsParent.add(node.parentUuid);
		}
	}

	const leafUuids: string[] = [];
	for (const uuid of nodes.keys()) {
		if (!referencedAsParent.has(uuid)) {
			leafUuids.push(uuid);
		}
	}

	if (leafUuids.length === 0) {
		return null;
	}

	// Build chain from the leaf with the most visible messages
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

			const node = nodes.get(currentUuid);
			if (node === undefined) {
				break;
			}

			if (isVisibleNode(node.raw)) {
				const storedMessage = validateAndReviveNode(node);
				if (storedMessage !== null) {
					chain.unshift(storedMessage);
				}
			}

			currentUuid = node.parentUuid;
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

// #region Lightweight Metadata Extraction (Layer 1)

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
		customTitle: undefined as string | undefined,
		created: undefined as number | undefined,
		lastRequestEnded: undefined as number | undefined,
		lastRequestStartedTimestamp: undefined as number | undefined,
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
	customTitle: string | undefined;
	created: number | undefined;
	lastRequestEnded: number | undefined;
	lastRequestStartedTimestamp: number | undefined;
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
	const mightBeCustomTitle = trimmed.includes('"type":"custom-title"') || trimmed.includes('"type": "custom-title"');
	const mightBeMessage = (
		trimmed.includes('"type":"user"') || trimmed.includes('"type": "user"') ||
		trimmed.includes('"type":"assistant"') || trimmed.includes('"type": "assistant"')
	);

	if (!mightBeSummary && !mightBeMessage && !mightBeCustomTitle) {
		return { shouldContinue: true };
	}

	// Parse JSON and validate with schema validators
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { shouldContinue: true };
	}

	// Try custom title validation
	if (mightBeCustomTitle) {
		const customTitleResult = vCustomTitleEntry.validate(parsed);
		if (!customTitleResult.error) {
			state.customTitle = customTitleResult.content.customTitle;
		}
		return { shouldContinue: true };
	}

	// Try summary validation
	if (mightBeSummary) {
		const summaryResult = vSummaryEntry.validate(parsed);
		if (!summaryResult.error) {
			const summaryText = summaryResult.content.summary.toLowerCase();
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
			const messageTimestamp = new Date(entry.timestamp).getTime();

			// Track first message timestamp and content
			if (state.created === undefined) {
				state.foundSessionId = true;
				state.created = messageTimestamp;

				// Extract user message content for label fallback
				if (entry.type === 'user') {
					const msgContent = entry.message.content;
					if (typeof msgContent === 'string') {
						state.firstUserMessageContent = msgContent;
					} else if (Array.isArray(msgContent)) {
						const textParts: string[] = [];
						for (const block of msgContent) {
							if (block.type === 'text' && 'text' in block) {
								textParts.push(block.text);
							}
						}
						state.firstUserMessageContent = textParts.join('\n');
					}
				}
			}

			// Track last genuine user request timestamp
			if (entry.type === 'user' && isUserRequest(entry.message.content)) {
				state.lastRequestStartedTimestamp = messageTimestamp;
			}

			// Always update last message timestamp (messages are chronological in file)
			state.lastRequestEnded = messageTimestamp;
		}
	}

	// No early termination - we need to read all messages to get lastRequestEnded
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
	if (state.created === undefined || state.lastRequestEnded === undefined) {
		return null;
	}

	// Generate label — custom title takes highest priority
	let label = state.customTitle ?? state.summary;
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
		created: state.created,
		lastRequestStarted: state.lastRequestStartedTimestamp,
		lastRequestEnded: state.lastRequestEnded,
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
		customTitle: undefined,
		created: undefined,
		lastRequestEnded: undefined,
		lastRequestStartedTimestamp: undefined,
		firstUserMessageContent: undefined,
		foundSessionId: false,
	};

	return new Promise((resolve, reject) => {
		// Check for pre-aborted signal before opening any file handles
		if (signal?.aborted) {
			reject(new Error('Operation cancelled'));
			return;
		}

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
			signal.addEventListener('abort', onAbort, { once: true });
		}

		rl.on('line', (line) => {
			if (aborted) {
				return;
			}

			const trimmed = line.trim();
			const { shouldContinue } = processLineForMetadata(trimmed, state);

			if (!shouldContinue) {
				earlyTerminationResult = buildMetadataResult(sessionId, fileMtime, state);
				cleanup();
			}
		});

		rl.on('close', () => {
			if (aborted) {
				return;
			}
			signal?.removeEventListener('abort', onAbort);
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
