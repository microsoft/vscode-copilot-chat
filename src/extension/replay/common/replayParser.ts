/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import { ChatStep } from './chatReplayResponses';

export interface ReplayData {
	chatSteps: ChatStep[];
	filePath: string;
}

/**
 * Parses a replay file and returns the chat steps with line numbers
 * @param filePath The absolute path to the replay file
 * @returns The parsed replay data containing chat steps and file path
 */
export function parseReplayFromFile(filePath: string): ReplayData {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Replay file not found: ${filePath}`);
	}

	try {
		const content = fs.readFileSync(filePath, 'utf8');
		const chatSteps = parseReplayContent(content);
		return {
			chatSteps,
			filePath
		};
	} catch (error) {
		throw new Error(`Failed to parse replay file ${filePath}: ${error}`);
	}
}

/**
 * Parses a replay file from a session ID (base64 encoded file path)
 * @param sessionId The session ID (base64 encoded file path, optionally prefixed with 'debug:')
 * @returns The parsed replay data containing chat steps and file path
 */
export function parseReplayFromSessionId(sessionId: string): ReplayData {
	const filePath = getFilePathFromSessionId(sessionId);
	if (!filePath) {
		throw new Error(`Invalid session ID: ${sessionId}`);
	}
	return parseReplayFromFile(filePath);
}

/**
 * Converts a session ID to a file path
 * @param sessionId The session ID (base64 encoded file path, optionally prefixed with 'debug:')
 * @returns The decoded file path, or undefined if the session ID is invalid
 */
export function getFilePathFromSessionId(sessionId: string): string | undefined {
	try {
		// Handle debug session IDs by removing the debug prefix
		const actualSessionId = sessionId.startsWith('debug:') ? sessionId.substring(6) : sessionId;
		return Buffer.from(actualSessionId, 'base64').toString('utf8');
	} catch {
		return undefined;
	}
}

/**
 * Creates a session ID from a file path
 * @param filePath The absolute path to the replay file
 * @param isDebugSession Whether this is a debug session (adds 'debug:' prefix)
 * @returns The base64 encoded session ID
 */
export function createSessionIdFromFilePath(filePath: string): string {
	return Buffer.from(filePath).toString('base64');
}

/**
 * Parses the replay content and assigns line numbers to each step
 * @param content The raw replay file content
 * @returns Array of chat steps with line numbers
 */
function parseReplayContent(content: string): ChatStep[] {
	const parsed = JSON.parse(content);
	const prompts = (parsed.prompts && Array.isArray(parsed.prompts) ? parsed.prompts : [parsed]) as { [key: string]: any }[];

	if (prompts.filter(p => !p.prompt).length) {
		throw new Error('Invalid replay content: expected a prompt object or an array of prompts in the base JSON structure.');
	}

	const steps: ChatStep[] = [];
	for (const prompt of prompts) {
		steps.push(...parsePrompt(prompt));
	}

	// Assign line numbers based on content
	assignLineNumbers(steps, content);

	return steps;
}

/**
 * Parses a single prompt object into chat steps
 */
function parsePrompt(prompt: { [key: string]: any }): ChatStep[] {
	const steps: ChatStep[] = [];
	steps.push({
		kind: 'userQuery',
		query: prompt.prompt,
		line: 0,
	});

	for (const log of prompt.logs) {
		if (log.kind === 'toolCall') {
			steps.push({
				kind: 'toolCall',
				id: log.id,
				line: 0,
				toolName: log.tool,
				args: JSON.parse(log.args),
				edits: log.edits,
				results: log.response
			});
		} else if (log.kind === 'request') {
			steps.push({
				kind: 'request',
				id: log.id,
				line: 0,
				prompt: log.messages,
				result: log.response.message
			});
		}
	}

	return steps;
}

/**
 * Assigns line numbers to steps based on their location in the content
 */
function assignLineNumbers(steps: ChatStep[], content: string): void {
	let stepIx = 0;
	const lines = content.split('\n');

	lines.forEach((line, index) => {
		if (stepIx < steps.length) {
			const step = steps[stepIx];
			if (step.kind === 'userQuery') {
				const match = line.match(`"prompt": "${step.query.trim()}`);
				if (match) {
					step.line = index + 1;
					stepIx++;
				}
			} else {
				const match = line.match(`"id": "${step.id}"`);
				if (match) {
					step.line = index + 1;
					stepIx++;
				}
			}
		}
	});
}
