/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Load env
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import { promises as fs } from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import { outdent } from 'outdent';
import { assert, describe, expect, it } from 'vitest';
import { DocumentId } from '../src/_internal/platform/inlineEdits/common/dataTypes/documentId';
import { MutableObservableWorkspace } from '../src/_internal/platform/inlineEdits/common/observableWorkspace';
import { FetchOptions, IAbortController, IHeaders, Response } from '../src/_internal/platform/networking/common/fetcherService';
import { IFetcher } from '../src/_internal/platform/networking/common/networking';
import { CancellationToken } from '../src/_internal/util/vs/base/common/cancellation';
import { URI } from '../src/_internal/util/vs/base/common/uri';
import { StringEdit } from '../src/_internal/util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../src/_internal/util/vs/editor/common/core/ranges/offsetRange';
import { createNESProvider } from '../src/main';
import { SimulationTestCopilotTokenManager } from '../src/_internal/platform/authentication/test/node/simulationTestCopilotTokenManager';


class TestFetcher implements IFetcher {
	constructor(private readonly responses: Record<string, string>) { }

	getUserAgentLibrary(): string {
		return 'test-fetcher';
	}

	async fetch(url: string, options: FetchOptions): Promise<Response> {
		const responseText = this.responses[url];

		const headers = new class implements IHeaders {
			get(name: string): string | null {
				return null;
			}
			*[Symbol.iterator](): Iterator<[string, string]> {
				// Empty headers for test
			}
		};

		const found = typeof responseText === 'string';
		return new Response(
			found ? 200 : 404,
			found ? 'OK' : 'Not Found',
			headers,
			async () => responseText || '',
			async () => JSON.parse(responseText || ''),
			async () => stream.Readable.from([responseText || ''])
		);
	}

	async disconnectAll(): Promise<unknown> {
		return Promise.resolve();
	}

	makeAbortController(): IAbortController {
		return new AbortController();
	}

	isAbortError(e: any): boolean {
		return e && e.name === 'AbortError';
	}

	isInternetDisconnectedError(e: any): boolean {
		return false;
	}

	isFetcherError(e: any): boolean {
		return false;
	}

	getUserMessageForFetcherError(err: any): string {
		return `Test fetcher error: ${err.message}`;
	}
}


describe('NESProvider Facade', () => {
	it('should handle getNextEdit call with a document URI', async () => {
		const obsWorkspace = new MutableObservableWorkspace();
		const doc = obsWorkspace.addDocument({
			id: DocumentId.create(URI.file('/test/test.ts').toString()),
			initialValue: outdent`
			class Point {
				constructor(
					private readonly x: number,
					private readonly y: number,
				) { }
				getDistance() {
					return Math.sqrt(this.x ** 2 + this.y ** 2);
				}
			}

			const myPoint = new Point(0, 1);`.trimStart()
		});
		doc.setSelection([new OffsetRange(1, 1)], undefined);
		const nextEditProvider = createNESProvider(
			obsWorkspace,
			new TestFetcher({ 'https://proxy.enterprise.githubcopilot.com/chat/completions': await fs.readFile(path.join(__dirname, 'nesProvider.reply.txt'), 'utf8') }),
			new SimulationTestCopilotTokenManager(),
		);

		doc.applyEdit(StringEdit.insert(11, '3D'));

		const result = await nextEditProvider.getNextEdit(doc.id.toUri(), CancellationToken.None);

		assert(result.result?.edit);

		doc.applyEdit(result.result.edit.toEdit());

		expect(doc.value.get().value).toMatchInlineSnapshot(`
			"class Point3D {
				constructor(
					private readonly x: number,
					private readonly y: number,
					private readonly z: number,
				) { }
				getDistance() {
					return Math.sqrt(this.x ** 2 + this.y ** 2);
				}
			}

			const myPoint = new Point(0, 1);"
		`);
	});
});