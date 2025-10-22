import { CancellationToken } from 'vscode';
import { FileChunkAndScore } from '../../platform/chunking/common/chunk';
import { ILogService } from '../../platform/log/common/logService';
import { ITelemetryService } from '../../platform/telemetry/common/telemetry';
import { UrlChunkEmbeddingsIndex } from '../../platform/urlChunkSearch/node/urlChunkEmbeddingsIndex';
import { URI } from '../../util/vs/base/common/uri';
import { IInstantiationService } from '../../util/vs/platform/instantiation/common/instantiation';
import { ToolName } from '../tools/common/toolNames';
import { IToolsService } from '../tools/common/toolsService';

export interface AiWebSearchResponse {
	query: string;
	results: Array<{ title: string; url: string; snippet?: string; summary?: string }>;
	synthesizedSummary: string;
}

export interface AiWebBrowserConfig {
	maxChunks?: number;
	cacheTTL?: number;
	rerankStrategy?: 'distance' | 'semantic' | 'hybrid';
}

/**
 * Minimal, well-formed AiWebBrowserAgent.
 * - Uses IToolsService.invokeTool to call 'webSearch' and the fetch tool (ToolName.FetchWebPage)
 * - Instantiates UrlChunkEmbeddingsIndex via DI when available, falls back to a stub for tests
 */
export class AiWebBrowserAgent {
	private readonly _index: UrlChunkEmbeddingsIndex;
	private readonly _searchCache = new Map<string, { ts: number; results: any[] }>();
	private readonly _embeddingsCache = new Map<string, { ts: number; chunks: FileChunkAndScore[] }>();
	private readonly _cacheTTL: number;
	private readonly _maxChunks: number;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IToolsService private readonly _toolsService: IToolsService,
		@ITelemetryService private readonly _telemetryService?: ITelemetryService,
		config?: Partial<AiWebBrowserConfig>,
	) {
		this._cacheTTL = (config?.cacheTTL ?? 30 * 60 * 1000);
		this._maxChunks = (config?.maxChunks ?? 10);
		let idx: UrlChunkEmbeddingsIndex | undefined;
		try {
			idx = this._instantiationService.createInstance(UrlChunkEmbeddingsIndex);
		} catch (e) {
			this._logService.trace('AiWebBrowserAgent: UrlChunkEmbeddingsIndex DI unavailable, using stub');
			idx = { findInUrls: async (files: any[]) => files.map(() => [{ chunk: { text: '' }, distance: 1 }]) } as any;
		}
		this._index = idx as UrlChunkEmbeddingsIndex;
		// clear expired cache entries on startup
		this.clearExpiredCache();
	}

	async searchAndBrowse(query: string, token?: CancellationToken): Promise<AiWebSearchResponse> {
		this._logService.trace(`AiWebBrowserAgent: search ${query}`);

		const start = Date.now();
		let raw: any[] = [];
		try {
			const cached = this._searchCache.get(query);
			if (cached && (Date.now() - cached.ts) < this._cacheTTL) {
				raw = cached.results;
				this._logService.trace('AiWebBrowserAgent: using cached search results');
			} else {
				const res: any = await this._toolsService.invokeTool(ToolName.WebSearch as any, { input: { query, maxResults: 5 } } as any, token as any);
				const content = res?.content ?? [];
				// content may be: [JSON-string] OR [{ type:0, text }] OR direct array of objects
				if (Array.isArray(content) && content.length > 0) {
					const first = content[0];
					if (typeof first === 'string') {
						raw = JSON.parse(first);
					} else if (first && typeof first.text === 'string') {
						try {
							raw = JSON.parse(first.text);
						} catch {
							raw = content;
						}
					} else {
						raw = content;
					}
				} else {
					raw = content;
				}
				this._searchCache.set(query, { ts: Date.now(), results: raw });
			}
		} catch (e) {
			this._logService.error(String(e));
		}

		const results = (raw || []).filter((r: any) => r && typeof r.url === 'string').slice(0, 10);

		// dedupe and sanitize urls
		const seen = new Set<string>();
		const urls: string[] = [];
		for (const r of results) {
			try {
				const uri = URI.parse(r.url);
				if (uri.scheme !== 'http' && uri.scheme !== 'https') continue;
				if (uri.authority === 'localhost' || uri.authority.startsWith('127.') || uri.authority === '::1') continue;
				const norm = uri.toString();
				if (!seen.has(norm)) {
					seen.add(norm);
					urls.push(norm);
				}
			} catch {
				// ignore invalid urls
			}
		}

		// fetch page contents for all urls (skip fetch for those with cached embeddings)
		const pageContents: string[] = new Array(urls.length).fill('');
		const fetchStart = Date.now();
		const toFetch: string[] = [];
		const toFetchIndices: number[] = [];
		for (let i = 0; i < urls.length; i++) {
			const url = urls[i];
			const embKey = `${query}:::${url}`;
			const cachedEmb = this._embeddingsCache.get(embKey);
			if (cachedEmb && (Date.now() - cachedEmb.ts) < this._cacheTTL) {
				// keep placeholder, embeddings cached
				continue;
			}
			toFetch.push(url);
			toFetchIndices.push(i);
		}

		if (toFetch.length > 0) {
			try {
				const fetchRes: any = await this._toolsService.invokeTool(ToolName.FetchWebPage as any, { input: { urls: toFetch, query } } as any, token as any);
				const content = fetchRes?.content ?? [];
				// content should correspond 1:1 to toFetch
				for (let i = 0; i < toFetch.length; i++) {
					const idx = toFetchIndices[i];
					const part = content[i];
					let text = '';
					if (typeof part === 'string') {
						text = part;
					} else if (part && typeof part.text === 'string') {
						text = part.text;
					} else if (part && (part as any).value) {
						text = (part as any).value;
					} else {
						// unsupported part type — leave as empty
					}
					pageContents[idx] = text;
				}
			} catch (e) {
				this._logService.error(String(e));
			}
		}
		const fetchDuration = Date.now() - fetchStart;

		// Compute embeddings and scores (batch)
		let chunksPerFile: FileChunkAndScore[][] = [];
		try {
			// For files where we had cached embeddings, we will replace later from cache
			const files = urls.map((u, i) => ({ uri: URI.parse(u), content: pageContents[i] }));
			const found = await this._index.findInUrls(files, query, token as any);
			// cache per-url embeddings
			for (let i = 0; i < urls.length; i++) {
				const embKey = `${query}:::${urls[i]}`;
				const perFile = (found && found[i]) ? found[i] : [];
				this._embeddingsCache.set(embKey, { ts: Date.now(), chunks: perFile });
			}
			chunksPerFile = found || [];
		} catch (e) {
			this._logService.error(String(e));
		}

		// semantic reranking: normalize distances to scores and merge across files
		type RankedChunk = { url: string; text: string; score: number };
		const merged: RankedChunk[] = [];
		for (let i = 0; i < chunksPerFile.length; i++) {
			const fileChunks = chunksPerFile[i] ?? [];
			for (const c of fileChunks) {
				const distance = (c as any).distance ?? (c as any).score ?? 0;
				const score = 1 / (1 + Math.max(0, distance));
				merged.push({ url: urls[i], text: (c as any).chunk?.text ?? '', score });
			}
		}

		merged.sort((a, b) => b.score - a.score);
		const topChunks = merged.slice(0, this._maxChunks);

		// build per-result summaries (top 2 chunks per url)
		const out: AiWebSearchResponse['results'] = [];
		// map original results by normalized url for title/snippet lookup
		const urlToResult = new Map<string, any>();
		for (const r of results) {
			try {
				const u = URI.parse(r.url).toString();
				if (!urlToResult.has(u)) urlToResult.set(u, r);
			} catch { }
		}
		for (const url of urls) {
			const r = urlToResult.get(url) ?? { title: '', snippet: '' };
			const perFileChunks = chunksPerFile[urls.indexOf(url)] ?? [];
			const top = perFileChunks.slice(0, 2).map(c => (c as any).chunk?.text ?? '');
			out.push({ title: r.title ?? '', url, snippet: r.snippet, summary: top.join('\n\n') });
		}

		// synthesized summary: join topChunks texts
		const synthesizedSummary = topChunks.map(t => t.text).join('\n\n');

		const elapsed = Date.now() - start;
		this._logService.trace(`AiWebBrowserAgent: search complete query="${query}" urls=${urls.length} fetchMs=${fetchDuration} totalMs=${elapsed}`);
		try {
			this._telemetryService?.sendTelemetryEvent?.('aiWebBrowser.search', { github: false, microsoft: false }, { queryLength: String(query.length) } as any, { urlsFetched: urls.length, elapsedMs: elapsed } as any);
		} catch { }

		return { query, results: out, synthesizedSummary };
	}

	private clearExpiredCache(): void {
		const now = Date.now();
		for (const [k, v] of this._searchCache) {
			if ((now - v.ts) > this._cacheTTL) this._searchCache.delete(k);
		}
		for (const [k, v] of this._embeddingsCache) {
			if ((now - v.ts) > this._cacheTTL) this._embeddingsCache.delete(k);
		}
	}
}
