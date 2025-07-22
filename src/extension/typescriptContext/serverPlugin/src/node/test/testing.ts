/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';

import { type LanguageService } from 'typescript';

import { computeContext as _computeContext } from '../../common/api';
import { ContextResult, RequestContext, SingleLanguageServiceSession, TokenBudget, type ComputeContextSession } from '../../common/contextProvider';
import { CodeSnippet, ContextKind, type ContextItem, type FullContextItem, type PriorityTag, type Trait } from '../../common/protocol';
import { NullCancellationToken } from '../../common/typescripts';
import { NodeHost } from '../host';
import { LanguageServices } from './languageServices';

function normalize(value: string): string {
	return value.trim().replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\t+/g, ' ').replace(/\s+/g, ' ');
}

export type ExpectedCodeSnippet = {
	kind: ContextKind.Snippet;
	value: string;
	fileName: RegExp;
};

export type ExpectedTrait = {
	kind: ContextKind.Trait;
	name: string;
	value: string;
};

export type ExpectedContextItem = ExpectedCodeSnippet | ExpectedTrait;

const semverRegex = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+([\w.-]+))?$|^(\d+)\.(\d+)$|^(\d+)$/;
function assertCodeSnippet(actual: CodeSnippet, expected: ExpectedCodeSnippet): void {
	assert.strictEqual(actual.kind, expected.kind);
	assert.ok(actual.kind === ContextKind.Snippet, `Expected snippet, got ${actual.kind}`);
	assert.ok(expected.kind === ContextKind.Snippet, `Expected snippet, got ${expected.kind}`);
	assert.strictEqual(normalize(actual.value), normalize(expected.value));
	const source = actual.fileName;
	assert.ok(source.match(expected.fileName) !== null);
}

function assertTrait(actual: Trait, expected: ExpectedTrait): void {
	assert.strictEqual(actual.kind, expected.kind);
	assert.ok(actual.kind === ContextKind.Trait, `Expected trait, got ${actual.kind}`);
	assert.ok(expected.kind === ContextKind.Trait, `Expected trait, got ${expected.kind}`);
	assert.strictEqual(actual.name, expected.name);
	if (actual.name.startsWith('The TypeScript version used in this project is')) {
		assert.ok(semverRegex.test(actual.value), `Expected semver, got ${actual.value}`);
	} else {
		assert.strictEqual(actual.value, expected.value);
	}
}

export function assertContextItems(actual: (ContextItem & PriorityTag)[], expected: ExpectedContextItem[], mode: 'equals' | 'contains' = 'equals'): void {
	const actualSnippets: (CodeSnippet & PriorityTag)[] = [];
	const actualTraits: (Trait & PriorityTag)[] = [];
	for (const item of actual) {
		if (item.kind === ContextKind.Snippet) {
			actualSnippets.push(item);
		} else if (item.kind === ContextKind.Trait) {
			actualTraits.push(item);
		}
	}
	actualSnippets.sort((a, b) => {
		return a.priority < b.priority ? 1 : a.priority > b.priority ? -1 : 0;
	});

	const expectedSnippets: ExpectedCodeSnippet[] = [];
	const expectedTraits: Map<string, ExpectedTrait> = new Map();
	for (const item of expected) {
		if (item.kind === ContextKind.Snippet) {
			expectedSnippets.push(item);
		} else if (item.kind === ContextKind.Trait) {
			expectedTraits.set(item.name, item);
		}
	}

	if (mode === 'equals') {
		assert.strictEqual(actualSnippets.length, expectedSnippets.length);
		for (let i = 0; i < actualSnippets.length; i++) {
			assertCodeSnippet(actualSnippets[i], expectedSnippets[i]);
		}
		assert.strictEqual(actualTraits.length, expectedTraits.size);
	} else {
		assert.ok(actualSnippets.length >= expectedSnippets.length, `Expected ${expectedSnippets.length} snippets, got ${actualSnippets.length}`);
		const actualSnippetMap: Map<string, CodeSnippet> = new Map();
		for (const actualSnippet of actualSnippets) {
			actualSnippetMap.set(normalize(actualSnippet.value), actualSnippet);
		}
		for (const expectedSnippet of expectedSnippets) {
			const actualSnippet = actualSnippetMap.get(normalize(expectedSnippet.value));
			assert.ok(actualSnippet !== undefined, `Missing expected snippet ${expectedSnippet.value}`);
			assertCodeSnippet(actualSnippet, expectedSnippet);
		}
	}
	for (const actualTrait of actualTraits) {
		const expectedTrait = expectedTraits.get(actualTrait.name);
		assert.ok(expectedTrait !== undefined, `Missing expected trait ${actualTrait.name}`);
		expectedTraits.delete(actualTrait.name);
		assertTrait(actualTrait, expectedTrait);
	}
	assert.strictEqual(expectedTraits.size, 0);
}

export type TestSession = {
	service: LanguageService;
	session: ComputeContextSession;
};

export type ContextItemWithPriority = FullContextItem & PriorityTag;

export function computeContext(session: TestSession, document: string, position: { line: number; character: number }, contextKind: ContextKind): ContextItemWithPriority[] {
	const result: ContextResult = new ContextResult(new TokenBudget(7 * 1024), new RequestContext(session.session, [], new Map()));
	const program = session.service.getProgram();
	if (program === undefined) {
		return [];
	}
	const sourceFile = program.getSourceFile(document);
	if (sourceFile === undefined) {
		return [];
	}
	const pos = sourceFile.getPositionOfLineAndCharacter(position.line, position.character);
	_computeContext(result, session.session, session.service, document, pos, new NullCancellationToken());
	return result.items().filter((item) => item.kind === contextKind);
}

class LanguageServiceTestSession extends SingleLanguageServiceSession {
	constructor(service: LanguageService, host: NodeHost) {
		super(service, host);
	}

	public override enableBlueprintSearch(): boolean {
		return true;
	}
}

export function create(fileOrDirectory: string): TestSession {
	const service: LanguageService = LanguageServices.createLanguageService(fileOrDirectory);
	const session = new LanguageServiceTestSession(service, new NodeHost());
	return { service, session };
}
