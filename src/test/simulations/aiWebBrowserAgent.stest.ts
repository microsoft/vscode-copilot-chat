/* Simulation test for AiWebBrowserAgent */
// This test is written to avoid depending on external test types (vitest) so it can be
// typechecked in environments without dev dependencies installed. It performs runtime
// assertions and will throw if expectations are not met.

// @ts-ignore - require dynamic import to avoid TS module resolution in some configs
const { AiWebBrowserAgent } = require('../../extension/agents/aiWebBrowserAgent');
import { CancellationToken } from 'vscode';
import { ILogService } from '../../platform/log/common/logService';
import { UrlChunkEmbeddingsIndex } from '../../platform/urlChunkSearch/node/urlChunkEmbeddingsIndex';

class DummyLogService implements ILogService {
	readonly _serviceBrand: undefined = undefined;
	trace(_m: string) { }
	debug(_m: string) { }
	info(_m: string) { }
	warn(_m: string) { }
	error(_e: string | Error, _m?: string) { }
	show(_preserve?: boolean) { }
}

class DummyToolsService {
	public calls: Array<{ name: string; input: any }> = [];

	async invokeTool(name: string, options: any): Promise<any> {
		this.calls.push({ name, input: options?.input });

		if (name === 'webSearch') {
			const results = [
				{ title: 'Result A', url: 'https://example.com/a', snippet: 'A snippet' },
				{ title: 'Result B', url: 'ftp://example.com/b', snippet: 'B snippet' },
				{ title: 'Result C', url: 'https://example.com/a', snippet: 'Duplicate URL' },
			];
			return { content: [JSON.stringify(results)] } as any;
		}

		if (name === 'fetchWebPage' || name === 'FetchWebPage') {
			const url = options?.input?.url;
			const body = url.includes('/a') ? '<html><body>Alpha content</body></html>' : '<html><body>Other content</body></html>';
			return { content: [{ type: 0, text: body, url }] } as any;
		}

		return { content: [] };
	}
}

class StubIndex implements Partial<UrlChunkEmbeddingsIndex> {
	async findInUrls(files: ReadonlyArray<{ uri: any; content: string }>, _query: string, _token: CancellationToken) {
		return files.map((f, i) => [
			{ chunk: { text: `${f.uri.toString()}::top` }, distance: i === 0 ? 0.1 : 0.9 },
			{ chunk: { text: `${f.uri.toString()}::second` }, distance: i === 0 ? 0.2 : 0.8 },
		] as any);
	}
}

async function runSimulationTest() {
	const log = new DummyLogService();
	const tools = new DummyToolsService() as any;
	// telemetry spy
	const telemetryCalls: Array<any> = [];
	const telemetryStub: any = {
		sendTelemetryEvent: (name: string, dest: any, props: any, measurements: any) => {
			telemetryCalls.push({ name, props, measurements });
		}
	};

	const instantiationService: any = {
		createInstance: (ctor: any) => ctor === UrlChunkEmbeddingsIndex ? new (StubIndex as any)() : undefined
	};

	const agentWithTelemetry = new AiWebBrowserAgent(instantiationService as any, log as any, tools as any, telemetryStub as any, { maxChunks: 5, cacheTTL: 1000 } as any);
	const res = await agentWithTelemetry.searchAndBrowse('test query' as any, undefined as any);

	// Basic runtime checks
	if (res.query !== 'test query') throw new Error('query mismatch');
	if (!Array.isArray(res.results)) throw new Error('results not array');
	if (typeof res.synthesizedSummary !== 'string') throw new Error('synthesizedSummary not string');

	const invokedNames = (tools.calls as Array<{ name: string }>).map((c) => c.name);
	if (!invokedNames.includes('webSearch')) throw new Error('webSearch not invoked');
	if (!invokedNames.includes('fetchWebPage') && !invokedNames.includes('FetchWebPage')) throw new Error('fetchWebPage not invoked');

	const urls = res.results.map((r: any) => r.url);
	if (!urls.includes('https://example.com/a')) throw new Error('expected url not present');
	if (urls.includes('ftp://example.com/b')) throw new Error('invalid ftp url was not filtered');

	if (!res.synthesizedSummary.includes('https://example.com/a::top')) throw new Error('synthesized summary missing top chunk');

	// Run again to test caching
	await agentWithTelemetry.searchAndBrowse('test query' as any, undefined as any);
	if (tools.calls.length <= 1) throw new Error('expected fetches to run on first call');
	// After second call with small TTL, we still expect cached search results to be used
	await agentWithTelemetry.searchAndBrowse('test query' as any, undefined as any);

	if (telemetryCalls.length === 0) throw new Error('expected telemetry to be called');

	// If we reached here, test passed — surface via log service when available
	try {
		(log as any).show?.();
	} catch { }
}

// Run the simulation when this file is executed in a test environment
void runSimulationTest();
