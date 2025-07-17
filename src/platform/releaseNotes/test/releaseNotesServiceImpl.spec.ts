import assert from 'assert';
import { suite, test } from 'vitest';
import { ReleaseNotesService } from '../vscode/releaseNotesServiceImpl';
import { IEnvService } from '../../env/common/envService';
import { IFetcherService, Response } from '../../networking/common/fetcherService';

class MockEnvService implements IEnvService {
    readonly _serviceBrand: undefined;
    constructor(private version: string) { }
    getEditorInfo() { return { version: this.version } as any; }
}

class MockFetcher implements IFetcherService {
    readonly _serviceBrand: undefined;
    lastUrl: string | undefined;
    getUserAgentLibrary(): string { return 'test'; }
    async fetch(url: string, _options: any): Promise<Response> { this.lastUrl = url; return new Response(200, 'ok', { get() { return null; } }, async () => '', async () => ({}), async () => null); }
    disconnectAll(): Promise<unknown> { return Promise.resolve(); }
    makeAbortController(): any { return { signal: {}, abort() { } }; }
    isAbortError(_e: any): boolean { return false; }
    isInternetDisconnectedError(_e: any): boolean { return false; }
    isFetcherError(_e: any): boolean { return false; }
    getUserMessageForFetcherError(_e: any): string { return ''; }
}

suite('ReleaseNotesService', () => {
    test('builds correct URL from version', async () => {
        const env = new MockEnvService('1.88.0');
        const fetcher = new MockFetcher();
        const svc = new ReleaseNotesService(env, fetcher);
        await svc.fetchLatestReleaseNotes();
        assert.strictEqual(fetcher.lastUrl?.includes('/v1_88.md'), true);
    });
});

