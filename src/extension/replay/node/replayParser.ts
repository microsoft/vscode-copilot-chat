/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatStep } from '../common/chatReplayResponses';

export function parseReplay(content: string): ChatStep[] {
	const parsed = JSON.parse(content);
	const prompts = (parsed.prompts && Array.isArray(parsed.prompts) ? parsed.prompts : [parsed]) as { [key: string]: any }[];
	if (prompts.filter(p => !p.prompt).length) {
		throw new Error('Invalid replay content: expected a prompt object or an array of prompts in the base JSON structure.');
	}

	const steps: ChatStep[] = [];
	for (const prompt of prompts) {
		parsePrompt(prompt, steps);
	}

	let stepIx = 0;
	const lines = content.split('\n');
	lines.forEach((line, index) => {
		if (stepIx < steps.length) {
			const step = steps[stepIx];
			if (step.kind === 'userQuery') {
				// Re-encode the query to match JSON representation in the file and remove surrounding quotes
				const encodedQuery = JSON.stringify(step.query).slice(1, -1);
				if (line.indexOf(`"prompt": "${encodedQuery}`) !== -1) {
					step.line = index + 1;
					stepIx++;
				}
			} else {
				if (line.indexOf(`"id": "${step.id}"`) !== -1) {
					step.line = index + 1;
					stepIx++;
				}
			}

		}
	});
	return steps;
}

function parsePrompt(prompt: { [key: string]: any }, steps: ChatStep[]) {
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