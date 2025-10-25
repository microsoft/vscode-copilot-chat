/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken, LanguageModelToolInvocationOptions, LanguageModelToolInvocationPrepareOptions, LanguageModelToolResult, lm, PreparedToolInvocation, ProviderResult } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { URI } from '../../../util/vs/base/common/uri';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

/**
 * Output contract for web search results
 */
export interface WebSearchResult {
	title: string;
	url: string;
	snippet?: string;
}

interface IWebSearchParams {
	query: string;
	maxResults?: number;
}

/**
 * A lightweight, extension-side Web Search tool. It delegates actual HTTP/search provider calls
 * to a configurable provider (not shipped here). For now it will attempt to call an internal LM tool
 * named `vscode_webSearch_internal` which the host or tests can implement. This keeps network logic
 * out of the extension host in production environments where the host provides secure network access.
 */
const internalToolName = 'vscode_webSearch_internal';

class WebSearchTool implements ICopilotTool<IWebSearchParams> {
	public static readonly toolName = ToolName.WebSearch;
	public static readonly exposedToolName = 'webSearch';

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	prepareInvocation(_options: LanguageModelToolInvocationPrepareOptions<IWebSearchParams>, _token: CancellationToken): ProviderResult<PreparedToolInvocation> {
		this._logService.trace('WebSearchTool: prepareInvocation');
		return { presentation: 'hidden' };
	}

	async invoke(options: LanguageModelToolInvocationOptions<IWebSearchParams>, token: CancellationToken): Promise<LanguageModelToolResult> {
		this._logService.trace('WebSearchTool: invoke');

		// If host provides an internal implementation, ask it to perform the search.
		try {
			const tool = lm.tools.find(t => t.name === internalToolName);
			if (tool) {
				const res = await lm.invokeTool(internalToolName, options, token);
				// Expect res.content to be array of simple objects { title, url, snippet }
				const content = (res as any).content ?? [];
				const results: WebSearchResult[] = [];
				for (const item of content) {
					if (item && typeof item.url === 'string') {
						const url = this.sanitizeUrl(item.url);
						if (url) {
							results.push({ title: item.title ?? '', url: url.toString(), snippet: item.snippet });
						}
					}
				}

				// Return as text part (tooling expects text or prompt parts)
				const text = JSON.stringify(results);
				return { content: [{ type: 0, text }] } as any;
			}

			// If internal tool not available, return empty.
			this._logService.warn('WebSearchTool: internal provider not found');
			return { content: [] };
		} catch (err) {
			this._logService.error('WebSearchTool: invoke failed: ' + String(err));
			return { content: [] };
		}
	}

	private sanitizeUrl(raw: string): URI | undefined {
		try {
			const uri = URI.parse(raw);
			// disallow file:, localhost and other internal schemes
			if (!uri.scheme || (uri.scheme !== 'http' && uri.scheme !== 'https')) {
				this._logService.warn(`WebSearchTool: rejecting non-http(s) url ${raw}`);
				return undefined;
			}
			if (uri.authority === 'localhost' || uri.authority.startsWith('127.') || uri.authority === '::1') {
				this._logService.warn(`WebSearchTool: rejecting localhost url ${raw}`);
				return undefined;
			}
			return uri;
		} catch (e) {
			this._logService.warn(`WebSearchTool: invalid url ${raw}`);
			return undefined;
		}
	}
}

// Register the web search tool so it becomes available via the ToolsService
ToolRegistry.registerTool(WebSearchTool as any);

export { WebSearchTool };

