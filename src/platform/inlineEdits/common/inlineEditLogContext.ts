/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { Diagnostic, InlineCompletionContext, Uri } from 'vscode';
import * as yaml from 'yaml';
import * as errors from '../../../util/common/errors';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { ThemeIcon } from '../../../util/vs/base/common/themables';
import { SerializedLineEdit } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { SerializedEdit } from './dataTypes/editUtils';
import { FetchCancellationError } from './dataTypes/fetchCancellationError';
import { LanguageContextResponse, SerializedContextResponse, SerializedDiagnostic, serializeFileDiagnostics, serializeLanguageContext } from './dataTypes/languageContext';
import { RootedLineEdit } from './dataTypes/rootedLineEdit';
import { DebugRecorderBookmark } from './debugRecorderBookmark';
import { ISerializedNextEditRequest, StatelessNextEditRequest } from './statelessNextEditProvider';
import { stringifyChatMessages } from './utils/stringifyChatMessages';
import { Icon, now } from './utils/utils';
import { HistoryContext } from './workspaceEditTracker/historyContextProvider';

export class InlineEditRequestLogContext {

	private static _id = 0;

	public readonly requestId = InlineEditRequestLogContext._id++;

	public readonly time = now();

	/** Tweaks visibility of this log element in the log tree */
	protected _isVisible: boolean = false;

	get includeInLogTree(): boolean {
		return this._isVisible;
	}

	constructor(
		public readonly filePath: string,
		public readonly version: number,
		private _context: InlineCompletionContext | undefined,
	) { }

	public recordingBookmark: DebugRecorderBookmark | undefined = undefined;

	toLogDocument(): string {
		const lines: string[] = [];
		lines.push('# ' + this.getMarkdownTitle() + ` (Request #${this.requestId})`);

		lines.push('💡 Tip: double-click anywhere to open this file as text to copy-paste content into an issue.\n');

		lines.push('<details><summary>Explanation for icons</summary>\n');
		lines.push(`- ${Icon.lightbulbFull.svg} - model had suggestions\n`);
		lines.push(`- ${Icon.circleSlash.svg} - model had NO suggestions\n`);
		lines.push(`- ${Icon.database.svg} - response is from cache\n`);
		lines.push(`- ${Icon.error.svg} - error happened\n`);
		lines.push(`- ${Icon.skipped.svg} - fetching started but got cancelled\n`);
		lines.push('</details>\n');

		lines.push(`Inline Edit Provider: ${this._statelessNextEditProviderId ?? '<NOT-SET>'}\n`);

		lines.push(`Chat Endpoint`);
		lines.push('```');
		lines.push(`Model name: ${this._endpointInfo?.modelName ?? '<NOT-SET>'}`);
		lines.push(`URL: ${this._endpointInfo?.url ?? '<NOT-SET>'}`);
		lines.push('```');

		lines.push(`Opportunity ID: ${this._context ? this._context.requestUuid : '<NOT-SET>'}`);

		const isCachedStr = this._logContextOfCachedEdit ? `(cached #${this._logContextOfCachedEdit.requestId})` : '(not cached)';

		if (this._nextEditRequest) {
			lines.push(`## Latest user edits ${isCachedStr}`);
			lines.push('<details open><summary>Edit</summary>\n');
			lines.push(this._nextEditRequest.toMarkdown());
			lines.push('\n</details>\n');
		}

		if (this._diagnosticsResultEdit) {
			lines.push(`## Proposed diagnostics suggestion ${this._nesTypePicked === 'diagnostics' ? '(Picked)' : '(Not Picked)'}`);
			lines.push('<details open><summary>Edit</summary>\n');
			lines.push('``` patch');
			lines.push(this._diagnosticsResultEdit.toString());
			lines.push('```');
			lines.push('\n</details>\n');
		}

		if (this._resultEdit) {
			lines.push(`## Proposed inline suggestion ${isCachedStr}`);
			lines.push('<details open><summary>Edit</summary>\n');
			lines.push('``` patch');
			lines.push(this._resultEdit.toString());
			lines.push('```');
			lines.push('\n</details>\n');
		}

		if (this.prompt) {
			lines.push(`## Prompt ${isCachedStr}`);
			lines.push('<details><summary>Click to view</summary>\n');
			const e = this.prompt;
			lines.push('````');
			lines.push(...e.split('\n'));
			lines.push('````');
			lines.push('\n</details>\n');
		}

		if (this.error) {
			lines.push(`## Error ${isCachedStr}`);
			lines.push('```');
			lines.push(errors.toString(errors.fromUnknown(this.error)));
			lines.push('```');
		}

		if (this.response) {
			lines.push(`## Response ${isCachedStr}`);
			lines.push('<details><summary>Click to view</summary>\n');
			lines.push('````');
			lines.push(this.response);
			lines.push('````');
			lines.push('\n</details>\n');
		}

		if (this._responseResults) {
			lines.push(`## Response Results ${isCachedStr}`);
			lines.push('<details><summary>Click to view</summary>\n');
			lines.push('```');
			lines.push(yaml.stringify(this._responseResults, null, '\t'));
			lines.push('```');
			lines.push('\n</details>\n');
		}

		if (this._isAccepted !== undefined) {
			lines.push(`## Accepted : ${this._isAccepted ? 'Yes' : 'No'}`);
		}

		if (this._logs.length > 0) {
			lines.push('## Logs');
			lines.push('<details open><summary>Logs</summary>\n');
			lines.push(...this._logs);
			lines.push('\n</details>\n');
		}

		if (this._trace.length > 0) {
			lines.push('## Trace');
			lines.push('<details open><summary>Trace</summary>\n');
			lines.push('```');
			lines.push(...this._trace);
			lines.push('```');
			lines.push('\n</details>\n');
		}

		lines.push(...this._renderTraceDiagram());

		return lines.join('\n');
	}

	toMinimalLog(): string {
		// Does not include the users files, but just the relevant edits
		const lines: string[] = [];

		if (this._nesTypePicked === 'diagnostics' && this._diagnosticsResultEdit) {
			lines.push(`## Result (Diagnostics):`);
			lines.push('``` patch');
			lines.push(this._diagnosticsResultEdit.toString());
			lines.push('```');
		} else if (this._nesTypePicked === 'llm' && this._resultEdit) {
			lines.push(`## Result:`);
			lines.push('``` patch');
			if (typeof this._resultEdit === 'string') {
				lines.push(this._resultEdit);
			} else {
				lines.push(this._resultEdit.toString());
			}
			lines.push('```');
		} else {
			lines.push(`## Result: <NOT-SET>`);
		}

		if (this.error) {
			lines.push(`## Error:`);
			lines.push('```');
			lines.push(errors.toString(errors.fromUnknown(this.error)));
			lines.push('```');
		}

		lines.push(`### Info:`);
		lines.push(`**From cache:** ${this._logContextOfCachedEdit ? `YES (Request: ${this._logContextOfCachedEdit.requestId})` : 'NO'}`);
		if (this._context) {
			lines.push(`**Trigger Kind:** ${this._context.triggerKind === 0 ? 'Manual' : 'Automatic'}`);
			lines.push(`**Request UUID:** ${this._context.requestUuid}`);
		}

		return lines.join('\n');
	}

	private _statelessNextEditProviderId: string | undefined = undefined;

	setStatelessNextEditProviderId(id: string) {
		this._statelessNextEditProviderId = id;
	}

	private _nextEditRequest: StatelessNextEditRequest | undefined = undefined;

	setRequestInput(nextEditRequest: StatelessNextEditRequest): void {
		this._isVisible = true;
		this._nextEditRequest = nextEditRequest;
	}

	private _resultEdit: RootedLineEdit | string | undefined = undefined;

	setResult(resultEditOrPatchString: RootedLineEdit | string) {
		this._isVisible = true;
		this._resultEdit = resultEditOrPatchString;
	}

	protected _diagnosticsResultEdit: RootedLineEdit | undefined = undefined;

	setDiagnosticsResult(resultEdit: RootedLineEdit) {
		this._isVisible = true;
		this._diagnosticsResultEdit = resultEdit;
	}

	private _nesTypePicked: 'llm' | 'diagnostics' | undefined;

	public setPickedNESType(nesTypePicked: 'llm' | 'diagnostics'): this {
		this._nesTypePicked = nesTypePicked;
		return this;
	}

	private _logContextOfCachedEdit: InlineEditRequestLogContext | undefined = undefined;

	setIsCachedResult(logContextOfCachedEdit: InlineEditRequestLogContext): void {

		this._logContextOfCachedEdit = logContextOfCachedEdit;

		{ // inherit stateless provider state from cached log context
			this.recordingBookmark = logContextOfCachedEdit.recordingBookmark;

			if (logContextOfCachedEdit._nextEditRequest) {
				this._nextEditRequest = logContextOfCachedEdit._nextEditRequest;

			}
			if (logContextOfCachedEdit._resultEdit) {
				this.setResult(logContextOfCachedEdit._resultEdit);
			}
			if (logContextOfCachedEdit._diagnosticsResultEdit) {
				this.setDiagnosticsResult(logContextOfCachedEdit._diagnosticsResultEdit);
			}
			if (logContextOfCachedEdit._endpointInfo) {
				this.setEndpointInfo(logContextOfCachedEdit._endpointInfo.url, logContextOfCachedEdit._endpointInfo.modelName);
			}
			if (logContextOfCachedEdit.prompt) {
				this.setPrompt(logContextOfCachedEdit.prompt);
			}
			if (logContextOfCachedEdit.response) {
				this.setResponse(logContextOfCachedEdit.response);
			}
			if (logContextOfCachedEdit.responseResults) {
				this.setResponseResults(logContextOfCachedEdit.responseResults);
			}
			if (logContextOfCachedEdit.fullResponsePromise) {
				this.setFullResponse(logContextOfCachedEdit.fullResponsePromise);
			}
			if (logContextOfCachedEdit.error) {
				this.setError(logContextOfCachedEdit.error);
			}
		}

		this._isVisible = true;
		this._icon = Icon.database;
	}

	private _endpointInfo: { url: string; modelName: string } | undefined;

	public setEndpointInfo(url: string, modelName: string): void {
		this._endpointInfo = { url, modelName };
	}

	public get endpointInfo(): { url: string; modelName: string } | undefined {
		return this._endpointInfo;
	}

	public _prompt: string | undefined = undefined;

	get prompt(): string | undefined {
		return this._prompt;
	}

	setPrompt(prompt: string | Raw.ChatMessage[]) {
		this._isVisible = true;
		if (typeof prompt === 'string') {
			this._prompt = prompt;
		} else {
			this._prompt = stringifyChatMessages(prompt);
		}
	}

	private _icon: Icon.t | undefined;

	getIcon(): ThemeIcon | undefined {
		return this._icon?.themeIcon;
	}

	public setIsSkipped() {
		this._isVisible = false;
		this._icon = Icon.skipped;
	}

	public markAsNoSuggestions() {
		this._isVisible = true;
		this._icon = Icon.circleSlash;
	}

	private error: unknown | undefined = undefined;
	setError(e: unknown): void {
		this._isVisible = true;
		this.error = e;

		if (this.error instanceof FetchCancellationError) {
			this._icon = Icon.skipped;
		} else if (isCancellationError(this.error)) {
			this._isVisible = false;
		} else {
			this._icon = Icon.error;
		}
	}

	/**
	 * Model Response
	 */
	private response: string | undefined = undefined;
	setResponse(v: string): void {
		this._isVisible = true;
		this.response = v;
	}

	private fullResponsePromise: Promise<string | undefined> | undefined = undefined;
	private fullResponse: string | undefined = undefined;
	setFullResponse(promise: Promise<string | undefined>): void {
		this.fullResponsePromise = promise;
		promise.then(response => this.fullResponse = response);
	}

	async allPromisesResolved(): Promise<void> {
		await this.fullResponsePromise;
	}

	private providerStartTime: number | undefined = undefined;
	setProviderStartTime(): void {
		this.providerStartTime = Date.now();
	}

	private providerEndTime: number | undefined = undefined;
	setProviderEndTime(): void {
		this.providerEndTime = Date.now();
	}

	private fetchStartTime: number | undefined = undefined;
	setFetchStartTime(): void {
		this.fetchStartTime = Date.now();
	}

	private fetchEndTime: number | undefined = undefined;
	setFetchEndTime(): void {
		this.fetchEndTime = Date.now();
	}

	/**
	 * Each of edit suggestions from model
	 */
	private _responseResults: readonly unknown[] | undefined = undefined;

	get responseResults(): readonly unknown[] | undefined {
		return this._responseResults;
	}

	setResponseResults(v: readonly unknown[]): void {
		this._isVisible = true;
		this._responseResults = v;
		this._icon = Icon.lightbulbFull;
	}

	getDebugName(): string {
		return `NES | ${basename(this.filePath)} (v${this.version})`;
	}

	getMarkdownTitle(): string {
		const icon: string = this._icon ? `${this._icon.svg} ` : '';
		return (icon) + this.getDebugName();
	}

	protected _recentEdit: HistoryContext | undefined = undefined;

	setRecentEdit(edit: HistoryContext): void {
		this._recentEdit = edit;
	}

	private _trace: string[] = [];
	trace(msg: string): void {
		this._trace.push(msg);
	}

	private _renderTraceDiagram(): string[] {
		if (this._trace.length === 0) {
			return [];
		}

		const lines: string[] = [];
		lines.push('## Trace Diagram');
		lines.push('<details open><summary>Trace Diagram</summary>\n');
		lines.push('```');

		// Parse trace lines into structured data
		const parsedTraces = this._trace.map(line => {
			const timeMatch = line.match(/^\[\s*(\d+)ms\]/);
			const timestamp = timeMatch ? parseInt(timeMatch[1], 10) : 0;

			// Extract the bracketed path segments and the message
			const afterTime = line.replace(/^\[\s*\d+ms\]\s*/, '');
			const segments: string[] = [];
			let remaining = afterTime;
			let bracketMatch;
			while ((bracketMatch = remaining.match(/^\[([^\]]+)\]/))) {
				segments.push(bracketMatch[1]);
				remaining = remaining.slice(bracketMatch[0].length);
			}
			const message = remaining.trim();

			return { timestamp, segments, message };
		});

		if (parsedTraces.length === 0) {
			lines.push('(no trace data)');
			lines.push('```');
			lines.push('\n</details>\n');
			return lines;
		}

		// Find the maximum timestamp for time width calculation
		const maxTime = Math.max(...parsedTraces.map(t => t.timestamp));
		const timeWidth = Math.max(6, String(maxTime).length + 3);

		// Build a map of segment paths to track when they start/end
		const activeSegments = new Map<string, { startTime: number; depth: number }>();
		const segmentLifetimes: { path: string; startTime: number; endTime: number; depth: number; name: string }[] = [];

		parsedTraces.forEach((trace, idx) => {
			const currentPath = trace.segments.join('|');

			// Check for segments that are no longer active
			for (const [path, info] of activeSegments) {
				if (!currentPath.startsWith(path) && currentPath !== path) {
					segmentLifetimes.push({
						path,
						startTime: info.startTime,
						endTime: trace.timestamp,
						depth: info.depth,
						name: path.split('|').pop() || ''
					});
					activeSegments.delete(path);
				}
			}

			// Add new segments
			let pathSoFar = '';
			trace.segments.forEach((segment, depth) => {
				pathSoFar = pathSoFar ? `${pathSoFar}|${segment}` : segment;
				if (!activeSegments.has(pathSoFar)) {
					activeSegments.set(pathSoFar, { startTime: trace.timestamp, depth });
				}
			});
		});

		// Close any remaining active segments
		const lastTimestamp = parsedTraces[parsedTraces.length - 1]?.timestamp || 0;
		for (const [path, info] of activeSegments) {
			segmentLifetimes.push({
				path,
				startTime: info.startTime,
				endTime: lastTimestamp,
				depth: info.depth,
				name: path.split('|').pop() || ''
			});
		}

		// Render timeline header
		lines.push('');
		lines.push('Timeline (nested call hierarchy):');
		lines.push('─'.repeat(60));

		// Track what's currently shown at each depth to avoid redundant output
		const currentAtDepth: string[] = [];

		for (const trace of parsedTraces) {
			const timeStr = `[${String(trace.timestamp).padStart(timeWidth - 3)}ms]`;
			const indentUnit = '│   ';
			const newBranchUnit = '├── ';

			// Determine which segments are new vs continuing
			let indent = '';
			let displaySegment = '';
			let hasNewSegment = false;

			for (let d = 0; d < trace.segments.length; d++) {
				const seg = trace.segments[d];
				if (currentAtDepth[d] !== seg) {
					// This is a new segment at this depth
					hasNewSegment = true;
					currentAtDepth[d] = seg;
					// Clear deeper levels
					currentAtDepth.length = d + 1;
					displaySegment = seg;
					indent = indentUnit.repeat(d);
					break;
				}
				indent = indentUnit.repeat(d + 1);
			}

			if (hasNewSegment) {
				// Show the new segment
				const prefix = indent + newBranchUnit;
				lines.push(`${timeStr} ${prefix}[${displaySegment}]`);
				if (trace.message) {
					const msgIndent = indentUnit.repeat(trace.segments.length);
					lines.push(`${' '.repeat(timeWidth + 1)} ${msgIndent}↳ ${trace.message}`);
				}
			} else if (trace.message) {
				// Just a message at the current depth
				const msgIndent = indentUnit.repeat(trace.segments.length);
				lines.push(`${timeStr} ${msgIndent}↳ ${trace.message}`);
			}
		}

		lines.push('─'.repeat(60));
		lines.push('```');
		lines.push('\n</details>\n');

		return lines;
	}

	private _logs: string[] = [];
	addLog(content: string): void {
		this._logs.push(content.replace('\n', '\\n').replace('\t', '\\t').replace('`', '\`') + '\n');
	}


	private _isAccepted: boolean | undefined = undefined;
	setAccepted(isAccepted: boolean): void {
		this._isAccepted = isAccepted;
	}

	addListToLog(list: string[]): void {
		list.forEach(l => this.addLog(`- ${l}`));
	}

	addCodeblockToLog(code: string, language: string = ''): void {
		this._logs.push(`\`\`\`${language}\n${code}\n\`\`\`\n`);
	}

	private _fileDiagnostics: [Uri, Diagnostic[]][] | undefined;
	setFileDiagnostics(fileDiagnostics: [Uri, Diagnostic[]][]): void {
		this._fileDiagnostics = fileDiagnostics;
	}

	private _getDiagnosticsForTrackedFiles(): SerializedDiagnostic[] | undefined {
		if (!this._fileDiagnostics || !this._nextEditRequest?.documents) {
			return undefined;
		}

		const diagnosticsOfTrackedFiles = this._fileDiagnostics.filter(([uri]) =>
			this._nextEditRequest!.documents.some(doc => doc.id.toString() === uri.toString())
		);

		return serializeFileDiagnostics(diagnosticsOfTrackedFiles);
	}

	private _languageContext: LanguageContextResponse | undefined;
	setLanguageContext(langCtx: LanguageContextResponse): void {
		this._languageContext = langCtx;
	}

	/**
	 * Convert the current instance into a JSON format to enable serialization
	 * @returns JSON representation of the current state
	 */
	toJSON(): ISerializedInlineEditLogContext {
		return {
			requestId: this.requestId,
			time: this.time,
			filePath: this.filePath,
			version: this.version,
			statelessNextEditProviderId: this._statelessNextEditProviderId,
			nextEditRequest: this._nextEditRequest?.serialize(),
			diagnosticsResultEdit: this._diagnosticsResultEdit?.toString(),
			resultEdit: this._resultEdit?.toString(),
			isCachedResult: !!this._logContextOfCachedEdit,
			prompt: this.prompt,
			error: String(this.error),
			response: this.fullResponse,
			responseResults: yaml.stringify(this._responseResults, null, '\t'),
			providerStartTime: this.providerStartTime,
			providerEndTime: this.providerEndTime,
			fetchStartTime: this.fetchStartTime,
			fetchEndTime: this.fetchEndTime,
			logs: this._logs,
			isAccepted: this._isAccepted,
			languageContext: this._languageContext ? serializeLanguageContext(this._languageContext) : undefined,
			diagnostics: this._getDiagnosticsForTrackedFiles()
		};
	}
}

function basename(path: string): string {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (slash === -1) { return path; }
	return path.slice(slash + 1);
}

export interface INextEditProviderTest {
	// from least recent to most recent
	recentWorkspaceEdits: { path: string; initialText: string; edit: SerializedEdit }[];
	recentWorkspaceEditsActiveDocumentIdx?: number; // by default the last document
	statelessDocuments?: { initialText: string; edit: SerializedLineEdit }[];
	statelessActiveDocumentIdx?: number; // by default the last document
	statelessLLMPrompt?: string;
	statelessLLMResponse?: string;
	statelessNextEdit?: SerializedLineEdit;

	nextEdit?: SerializedEdit;
}

export interface ISerializedInlineEditLogContext {
	requestId: number;
	time: number;
	filePath: string;
	version: number;
	statelessNextEditProviderId: string | undefined;
	nextEditRequest: ISerializedNextEditRequest | undefined;
	diagnosticsResultEdit: string | undefined;
	resultEdit: string | undefined;
	isCachedResult: boolean;
	prompt: string | undefined;
	error: string;
	response: string | undefined;
	responseResults: string;
	providerStartTime: number | undefined;
	providerEndTime: number | undefined;
	fetchStartTime: number | undefined;
	fetchEndTime: number | undefined;
	logs: string[];
	isAccepted: boolean | undefined;
	languageContext: SerializedContextResponse | undefined;
	diagnostics: SerializedDiagnostic[] | undefined;
}
