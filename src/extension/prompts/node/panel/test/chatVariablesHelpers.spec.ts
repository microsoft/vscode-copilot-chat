/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { URI } from '../../../../../util/vs/base/common/uri';
import { PromptVariable } from '../../../../prompt/common/chatVariablesCollection';
import { buildSlashCommandUserMessage, getPromptFileSlashCommandId, PromptFileSlashCommandId } from '../chatVariables';

function makePromptVariable(name: string, value: PromptVariable['value']): PromptVariable {
	return {
		reference: { id: name, name, value },
		originalName: name,
		uniqueName: name,
		value,
		isMarkedReadonly: undefined,
	};
}

describe('getPromptFileSlashCommandId', () => {
	test('prompt file uses filename without .prompt.md extension', () => {
		expect(getPromptFileSlashCommandId(
			makePromptVariable('prompt:yell-foo.prompt.md', URI.file('/workspace/.github/prompts/yell-foo.prompt.md'))
		)).toEqual({ name: 'prompt:yell-foo.prompt.md', id: 'yell-foo' });
	});

	test('skill file uses parent folder name', () => {
		expect(getPromptFileSlashCommandId(
			makePromptVariable('code-review', URI.file('/workspace/.github/skills/code-review/SKILL.md'))
		)).toEqual({ name: 'code-review', id: 'code-review' });
	});

	test('skill file is case-insensitive for SKILL.md', () => {
		expect(getPromptFileSlashCommandId(
			makePromptVariable('my-skill', URI.file('/workspace/.github/skills/my-skill/skill.md'))
		)).toEqual({ name: 'my-skill', id: 'my-skill' });
	});

	test('non-prompt, non-skill file falls back to reference name', () => {
		expect(getPromptFileSlashCommandId(
			makePromptVariable('some-instructions.instructions.md', URI.file('/workspace/.github/instructions/some-instructions.instructions.md'))
		)).toEqual({ name: 'some-instructions.instructions.md', id: 'some-instructions.instructions.md' });
	});

	test('non-URI value falls back to reference name', () => {
		expect(getPromptFileSlashCommandId(
			makePromptVariable('inline-ref', 'some string value')
		)).toEqual({ name: 'inline-ref', id: 'inline-ref' });
	});

	test('prompt file with nested path', () => {
		expect(getPromptFileSlashCommandId(
			makePromptVariable('prompt:deeply-nested.prompt.md', URI.file('/a/b/c/d/deeply-nested.prompt.md'))
		)).toEqual({ name: 'prompt:deeply-nested.prompt.md', id: 'deeply-nested' });
	});
});

describe('buildSlashCommandUserMessage', () => {
	const promptFileIds: PromptFileSlashCommandId[] = [
		{ name: 'prompt:code-review.prompt.md', id: 'code-review' },
		{ name: 'my-skill', id: 'my-skill' },
	];

	test('returns follow instruction for matching slash command without args', () => {
		expect(buildSlashCommandUserMessage('/code-review', promptFileIds))
			.toBe('Follow instructions in #prompt:code-review.prompt.md');
	});

	test('returns follow instruction with arguments when provided', () => {
		expect(buildSlashCommandUserMessage('/code-review some-file.ts', promptFileIds))
			.toBe('Follow instructions in #prompt:code-review.prompt.md with these arguments: some-file.ts');
	});

	test('passes multi-word arguments', () => {
		expect(buildSlashCommandUserMessage('/code-review file1.ts file2.ts --strict', promptFileIds))
			.toBe('Follow instructions in #prompt:code-review.prompt.md with these arguments: file1.ts file2.ts --strict');
	});

	test('matches skill slash commands', () => {
		expect(buildSlashCommandUserMessage('/my-skill do something', promptFileIds))
			.toBe('Follow instructions in #my-skill with these arguments: do something');
	});

	test('returns original query when no slash command', () => {
		expect(buildSlashCommandUserMessage('just a normal question', promptFileIds))
			.toBe('just a normal question');
	});

	test('returns original query when slash command does not match any prompt file', () => {
		expect(buildSlashCommandUserMessage('/unknown-command arg1', promptFileIds))
			.toBe('/unknown-command arg1');
	});

	test('handles leading whitespace in query', () => {
		expect(buildSlashCommandUserMessage('  /code-review', promptFileIds))
			.toBe('Follow instructions in #prompt:code-review.prompt.md');
	});

	test('trims trailing whitespace from arguments', () => {
		expect(buildSlashCommandUserMessage('/code-review  some-file.ts  ', promptFileIds))
			.toBe('Follow instructions in #prompt:code-review.prompt.md with these arguments: some-file.ts');
	});

	test('handles empty prompt file list', () => {
		expect(buildSlashCommandUserMessage('/code-review', []))
			.toBe('/code-review');
	});

	test('handles multiline arguments', () => {
		expect(buildSlashCommandUserMessage('/code-review line1\nline2', promptFileIds))
			.toBe('Follow instructions in #prompt:code-review.prompt.md with these arguments: line1\nline2');
	});
});
