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
import { createNESProvider, ITelemetrySender } from '../src/main';
import { ICopilotTokenManager } from '../src/_internal/platform/authentication/common/copilotTokenManager';
import { Emitter } from '../src/_internal/util/vs/base/common/event';
import { CopilotToken } from '../src/_internal/platform/authentication/common/copilotToken';


class TestFetcher implements IFetcher {
	constructor(private readonly responses: Record<string, string>) { }

	getUserAgentLibrary(): string {
		return 'test-fetcher';
	}

	async fetch(url: string, options: FetchOptions): Promise<Response> {
		const uri = URI.parse(url);
		const responseText = this.responses[uri.path];

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

class TestCopilotTokenManager implements ICopilotTokenManager {
    _serviceBrand: undefined;

    onDidCopilotTokenRefresh = new Emitter<void>().event;

    async getCopilotToken(force?: boolean): Promise<CopilotToken> {
        return new CopilotToken({ token: 'fixedToken', expires_at: 0, refresh_in: 0, username: 'fixedTokenManager', isVscodeTeamMember: false, copilot_plan: 'unknown' });
    }

    resetCopilotToken(httpError?: number): void {
        // nothing
    }
}

class TestTelemetrySender implements ITelemetrySender {
	sendTelemetryEvent(eventName: string, properties?: Record<string, string | undefined>, measurements?: Record<string, number | undefined>): void {
		// No-op
	}
}

describe('NESProvider Facade', () => {
	it('should handle getNextEdit call with a document URI', async () => {
		const workspace = new MutableObservableWorkspace();
		const doc = workspace.addDocument({
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
		const nextEditProvider = createNESProvider({
			workspace,
			fetcher: new TestFetcher({ '/chat/completions': await fs.readFile(path.join(__dirname, 'nesProvider.reply.txt'), 'utf8') }),
			copilotTokenManager: new TestCopilotTokenManager(),
			telemetrySender: new TestTelemetrySender(),
		});

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