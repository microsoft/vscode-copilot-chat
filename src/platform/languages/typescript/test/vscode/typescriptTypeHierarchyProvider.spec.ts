/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
	class Position {
		constructor(public readonly line: number, public readonly character: number) { }
	}

	class Range {
		constructor(public readonly start: Position, public readonly end: Position) { }
	}

	class Uri {
		static file(fsPath: string): Uri {
			return new Uri(fsPath);
		}

		constructor(public readonly fsPath: string) { }

		toString(): string {
			return this.fsPath;
		}
	}

	const SymbolKind = {
		Class: 4,
		Interface: 10,
		Enum: 9,
		TypeParameter: 25
	};

	class TypeHierarchyItem {
		constructor(
			public readonly kind: number,
			public readonly name: string,
			public readonly detail: string,
			public readonly uri: Uri,
			public readonly range: Range,
			public readonly selectionRange: Range
		) { }
	}

	return {
		Position,
		Range,
		Uri,
		SymbolKind,
		TypeHierarchyItem
	};
});

import type * as vscodeTypes from 'vscode';
import { TypeScriptServiceHost } from '../../vscode/typescriptServiceHost';
import { TypeScriptTypeHierarchyProvider } from '../../vscode/typescriptTypeHierarchyProvider';

let vscode: typeof import('vscode');
let cancellationToken: vscodeTypes.CancellationToken;

beforeAll(async () => {
	vscode = await import('vscode');
});

beforeEach(() => {
	cancellationToken = createCancellationToken();
});

const createCancellationToken = (): vscodeTypes.CancellationToken => ({
	isCancellationRequested: false,
	onCancellationRequested: (() => ({ dispose() { /* noop */ } })) as unknown as vscodeTypes.Event<any>
});

describe('TypeScriptTypeHierarchyProvider', () => {

	it('prepares hierarchy for class declarations', async () => {
		const source = `
interface Mammal { warmBlooded: boolean; }
class Animal { }
class Dog extends Animal implements Mammal {
	warmBlooded = true;
}
`;

		const { provider, host, uri } = createProvider(source);
		const dogPosition = getPosition(source, 'class Dog');

		try {
			const result = await provider.prepare(uri, dogPosition, cancellationToken);

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Dog');
			expect(result[0].kind).toBe(vscode.SymbolKind.Class);
			expect(result[0].uri.fsPath).toBe(uri.fsPath);
		} finally {
			provider.dispose();
			host.dispose();
		}
	});

	it('computes supertypes using the type checker', async () => {
		const source = `
interface Mammal { warmBlooded: boolean; }
class Animal { }
class Dog extends Animal implements Mammal {
	warmBlooded = true;
}
`;

		const { provider, host, uri } = createProvider(source);
		const dogPosition = getPosition(source, 'class Dog');

		try {
			const [dogItem] = await provider.prepare(uri, dogPosition, cancellationToken);
			const supertypes = await provider.supertypes(dogItem, cancellationToken);
			const superNames = supertypes.map(item => item.name);

			expect(superNames).toContain('Animal');
			expect(superNames).toContain('Mammal');
		} finally {
			provider.dispose();
			host.dispose();
		}
	});

	it('discovers subtypes using language service implementations', async () => {
		const source = `
class Animal { }
class Dog extends Animal { }
class Labrador extends Dog { }
`;

		const { provider, host, uri } = createProvider(source);
		const animalPosition = getPosition(source, 'class Animal');

		try {
			const [animalItem] = await provider.prepare(uri, animalPosition, cancellationToken);
			const subtypes = await provider.subtypes(animalItem, cancellationToken);
			const subtypeNames = subtypes.map(item => item.name);

			expect(subtypeNames).toContain('Dog');
			expect(subtypeNames).toContain('Labrador');
		} finally {
			provider.dispose();
			host.dispose();
		}
	});
});

function createProvider(sourceText: string): { provider: TypeScriptTypeHierarchyProvider; host: TypeScriptServiceHost; uri: vscodeTypes.Uri } {
	const filePath = path.join(os.tmpdir(), `copilot-type-hierarchy-${Math.random().toString(16).slice(2)}.ts`);
	const normalized = path.normalize(filePath);
	const textByPath = new Map<string, string>([[normalized, sourceText]]);
	const host = new TypeScriptServiceHost({
		documentTextResolver: async (uri) => textByPath.get(path.normalize(uri.fsPath))
	});

	const provider = new TypeScriptTypeHierarchyProvider(host);
	const uri = vscode.Uri.file(normalized);
	return { provider, host, uri };
}

function getPosition(source: string, search: string): vscodeTypes.Position {
	const index = source.indexOf(search);
	if (index === -1) {
		throw new Error(`Search string "${search}" not found in source.`);
	}

	const prefix = source.slice(0, index);
	const lines = prefix.split(/\r?\n/);
	const line = lines.length - 1;
	const character = lines[lines.length - 1].length;
	return new vscode.Position(line, character);
}
