/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type tt from 'typescript/lib/tsserverlibrary';
import TS from './typescript';
const ts = TS();

import type { Host } from './host';
import {
	CacheScopeKind, CodeSnippet,
	ContextItem,
	ContextItemReference,
	ContextKind,
	ContextRequestResultState,
	ContextRunnableResultKind,
	ContextRunnableState,
	EmitMode, ErrorData, Timings, Trait, TraitKind,
	type CachedContextItem,
	type CachedContextRunnableResult,
	type CacheInfo, type CacheScope,
	type ContextItemKey,
	type ContextRequestResult,
	type ContextRunnableResult,
	type ContextRunnableResultId,
	type ContextRunnableResultReference,
	type ContextRunnableResultTypes,
	type FullContextItem, type Range, type SpeculativeKind
} from './protocol';
import tss, { ImportedByState, Sessions, Symbols, Types } from './typescripts';
import { LRUCache } from './utils';


export class RecoverableError extends Error {

	public static readonly SourceFileNotFound: number = 1;
	public static readonly NodeNotFound: number = 2;
	public static readonly NodeKindMismatch: number = 3;
	public static readonly SymbolNotFound: number = 4;
	public static readonly NoDeclaration: number = 5;
	public static readonly NoProgram: number = 6;
	public static readonly NoSourceFile: number = 7;

	public readonly code: number;

	constructor(message: string, code: number) {
		super(message);
		this.code = code;
	}
}

export abstract class ProgramContext {

	/**
	 * The symbol is skipped if it has no declarations or if one declaration
	 * comes from a default or external library.
	 */
	protected getSymbolInfo(symbol: tt.Symbol): { skip: true } | { skip: false; primary: tt.SourceFile } {
		const declarations = symbol.declarations;
		if (declarations === undefined || declarations.length === 0) {
			return { skip: true };
		}
		let primary: tt.SourceFile | undefined;
		let skipCount = 0;
		const program = this.getProgram();
		for (const declaration of declarations) {
			const sourceFile = declaration.getSourceFile();
			if (primary === undefined) {
				primary = sourceFile;
			}
			if (program.isSourceFileDefaultLibrary(sourceFile) || program.isSourceFileFromExternalLibrary(sourceFile)) {
				skipCount++;
			}
		}
		return skipCount > 0 ? { skip: true } : { skip: false, primary: primary! };
	}

	protected skipDeclaration(declaration: tt.Declaration, sourceFile: tt.SourceFile = declaration.getSourceFile()): boolean {
		const program = this.getProgram();
		return program.isSourceFileDefaultLibrary(sourceFile) || program.isSourceFileFromExternalLibrary(sourceFile) || sourceFile.isDeclarationFile;
	}

	protected abstract getProgram(): tt.Program;

}

export class RequestContext {

	private readonly symbols: Map<tt.Program, Symbols>;

	public readonly neighborFiles: tt.server.NormalizedPath[];
	public readonly clientSideRunnableResults: Map<ContextRunnableResultId, CachedContextRunnableResult>;
	private readonly clientSideContextItems: Map<ContextItemKey, CachedContextItem>;

	constructor(_session: ComputeContextSession, neighborFiles: tt.server.NormalizedPath[], clientSideRunnableResults: Map<ContextRunnableResultId, CachedContextRunnableResult>) {
		this.symbols = new Map();
		this.neighborFiles = neighborFiles;
		this.clientSideRunnableResults = clientSideRunnableResults;
		this.clientSideContextItems = new Map();
		for (const rr of clientSideRunnableResults.values()) {
			for (const item of rr.items) {
				this.clientSideContextItems.set(item.key, item);
			}
		}
	}

	public getSymbols(program: tt.Program): Symbols {
		let result = this.symbols.get(program);
		if (result === undefined) {
			result = new Symbols(program);
			this.symbols.set(program, result);
		}
		return result;
	}

	public getPreferredNeighborFiles(program: tt.Program): tt.SourceFile[] {
		const result: tt.SourceFile[] = [];
		for (const file of this.neighborFiles) {
			const sourceFile = program.getSourceFile(file);
			if (sourceFile !== undefined) {
				result.push(sourceFile);
			}
		}
		return result;
	}

	public createContextItemReferenceIfManaged(key: ContextItemKey): ContextItemReference | undefined {
		const cachedItem = this.clientSideContextItems.get(key);
		return cachedItem !== undefined
			? ContextItemReference.create(cachedItem.key)
			: undefined;
	}

	public clientHasContextItem(key: ContextItemKey): boolean {
		return this.clientSideContextItems.has(key);
	}
}

export abstract class Search<R> extends ProgramContext {

	protected readonly program: tt.Program;
	protected readonly symbols: Symbols;

	constructor(program: tt.Program, symbols: Symbols = new Symbols(program)) {
		super();
		if (program !== symbols.getProgram()) {
			throw new Error('Program and symbols program must match');
		}
		this.program = program;
		this.symbols = symbols;
	}

	public getSymbols(): Symbols {
		return this.symbols;
	}

	protected override getProgram(): tt.Program {
		return this.program;
	}

	public getHeritageSymbol(node: tt.Node): tt.Symbol | undefined {
		let result = this.symbols.getLeafSymbolAtLocation(node);
		if (result === undefined) {
			return undefined;
		}
		if (Symbols.isAlias(result)) {
			result = this.symbols.getLeafSymbol(result);
		}
		let counter = 0;
		while (Symbols.isTypeAlias(result) && counter < 10) {
			const declarations = result!.declarations;
			if (declarations !== undefined) {
				const start: tt.Symbol = result!;
				for (const declaration of declarations) {
					if (ts.isTypeAliasDeclaration(declaration)) {
						const type = declaration.type;
						if (ts.isTypeReferenceNode(type)) {
							result = this.symbols.getLeafSymbolAtLocation(type.typeName);
						}
					}
				}
				if (start === result) {
					break;
				}
			}
			counter++;
		}
		return result;
	}

	public static getNodeInProgram<T extends tt.Node>(program: tt.Program, node: T): T {
		function sameChain(node: tt.Node | undefined, other: tt.Node | undefined): boolean {
			if (node === undefined || other === undefined) {
				return node === other;
			}
			while (node !== undefined && other !== undefined) {
				if (node.kind !== other.kind || node.pos !== other.pos || node.end !== other.end) {
					return false;
				}
				node = node.parent;
				other = other.parent;
			}
			return node === undefined && other === undefined;
		}
		const fileName = node.getSourceFile().fileName;
		const other = program.getSourceFile(fileName);
		if (other === undefined) {
			throw new RecoverableError(`No source file found for ${fileName}`, RecoverableError.SourceFileNotFound);
		}
		const candidate = tss.getTokenAtPosition(other, node.pos);
		let otherNode = candidate;
		if (otherNode === undefined) {
			throw new RecoverableError(`No node found for ${fileName}:${node.pos}`, RecoverableError.NodeNotFound);
		}

		while (otherNode !== undefined) {
			if (node.pos === otherNode.pos && node.end === otherNode.end && node.kind === otherNode.kind && sameChain(node.parent, otherNode.parent)) {
				return otherNode as T;
			}
			otherNode = otherNode.parent;
		}

		throw new RecoverableError(`Found node ${candidate.kind} for node ${node.kind} in file ${fileName}:${node.pos}`, RecoverableError.NodeKindMismatch);
	}

	public abstract with(program: tt.Program): Search<R>;
	public abstract score(program: tt.Program, context: RequestContext): number;
	public abstract run(context: RequestContext, token: tt.CancellationToken): R | undefined;

}

export interface Logger {
	info(s: string): void;
	msg(s: string, type?: tt.server.Msg): void;
	startGroup(): void;
	endGroup(): void;
}

export class NullLogger implements Logger {
	public info(): void {
	}
	public msg(): void {
	}
	public startGroup(): void {
	}
	public endGroup(): void {
	}
}

export type CodeCacheItem = {
	value: string[];
	uri: string;
	additionalUris?: Set<string>;
};

export abstract class ComputeContextSession implements tss.StateProvider {

	public readonly host: Host;

	private readonly codeCache: LRUCache<string, CodeCacheItem>;
	private readonly importedByState: Map<string, ImportedByState>;
	private readonly supportsCaching: boolean;

	protected constructor(host: Host, supportsCaching: boolean) {
		this.host = host;
		this.codeCache = new LRUCache(100);
		this.importedByState = new Map();
		this.supportsCaching = supportsCaching;
	}

	public getImportedByState(key: string): ImportedByState {
		let state = this.importedByState.get(key);
		if (state === undefined) {
			state = new ImportedByState(key);
			this.importedByState.set(key, state);
		}
		return state;
	}

	public run<R>(search: Search<R>, context: RequestContext, token: tt.CancellationToken): [tt.Program | undefined, R | undefined] {
		const programsToSearch = this.getPossiblePrograms(search, context);
		for (const program of programsToSearch) {
			const programSearch = search.with(program);
			const result = programSearch.run(context, token);
			if (result !== undefined) {
				return [program, result];
			}
		}
		return [undefined, undefined];
	}

	private getPossiblePrograms<R>(search: Search<R>, context: RequestContext): tt.Program[] {
		const candidates: [number, tt.Program][] = [];
		for (const languageService of this.getLanguageServices()) {
			const program = languageService.getProgram();
			if (program === undefined) {
				continue;
			}
			const score = search.score(program, context);
			if (score > 0) {
				candidates.push([score, program]);
			}
		}
		return candidates.sort((a, b) => b[0] - a[0]).map(c => c[1]);
	}

	public getCachedCode(key: string): CodeCacheItem | undefined;
	public getCachedCode(symbol: tt.Symbol): CodeCacheItem | undefined;
	public getCachedCode(symbolOrKey: tt.Symbol | string, symbol?: tt.Symbol): CodeCacheItem | undefined {
		if (!this.supportsCaching) {
			return undefined;
		}
		if (typeof symbolOrKey === 'string') {
			return this.codeCache.get(symbolOrKey);
		} else {
			const key = Symbols.createVersionedKey(symbol!, this, this.host);
			return key === undefined ? undefined : this.codeCache.get(key);
		}
	}

	public cacheCode(key: string, code: CodeCacheItem): void;
	public cacheCode(symbol: tt.Symbol, code: CodeCacheItem): void;
	public cacheCode(symbolOrKey: tt.Symbol | string, code: CodeCacheItem): void {
		if (!this.supportsCaching) {
			return;
		}
		if (typeof symbolOrKey === 'string') {
			this.codeCache.set(symbolOrKey as string, code);
		} else {
			const key = Symbols.createVersionedKey(symbolOrKey, this, this.host);
			if (key !== undefined) {
				this.codeCache.set(key, code!);
			}
		}
	}

	public enableBlueprintSearch(): boolean {
		return false;
	}

	public abstract readonly logger: Logger;
	public abstract getLanguageServices(sourceFile?: tt.SourceFile): IterableIterator<tt.LanguageService>;
	public abstract logError(error: Error, cmd: string): void;
	public abstract getScriptVersion(sourceFile: tt.SourceFile): string | undefined;
}

export class LanguageServerSession extends ComputeContextSession {
	private readonly session: tt.server.Session;

	public readonly logger: Logger;

	constructor(session: tt.server.Session, host: Host) {
		super(host, true);
		this.session = session;
		const projectService = Sessions.getProjectService(this.session);
		this.logger = projectService?.logger ?? new NullLogger();
	}

	public logError(error: Error, cmd: string): void {
		this.session.logError(error, cmd);
	}

	public getFileAndProject(args: tt.server.protocol.FileRequestArgs): Sessions.FileAndProject | undefined {
		return Sessions.getFileAndProject(this.session, args);
	}

	public getPositionInFile(args: tt.server.protocol.Location & { position?: number }, file: tt.server.NormalizedPath): number | undefined {
		return Sessions.getPositionInFile(this.session, args, file);
	}

	public *getLanguageServices(sourceFile?: tt.SourceFile): IterableIterator<tt.LanguageService> {
		const projectService = Sessions.getProjectService(this.session);
		if (projectService === undefined) {
			return;
		}
		if (sourceFile === undefined) {
			for (const project of projectService.configuredProjects.values()) {
				const languageService = project.getLanguageService();
				yield languageService;
			}
			for (const project of projectService.inferredProjects) {
				const languageService = project.getLanguageService();
				yield languageService;
			}
			for (const project of projectService.externalProjects) {
				const languageService = project.getLanguageService();
				yield languageService;
			}
		} else {
			const file = ts.server.toNormalizedPath(sourceFile.fileName);
			const scriptInfo = projectService.getScriptInfoForNormalizedPath(file)!;
			yield* scriptInfo ? scriptInfo.containingProjects.map(p => p.getLanguageService()) : [];
		}
	}

	public override getScriptVersion(sourceFile: tt.SourceFile): string | undefined {
		const file = ts.server.toNormalizedPath(sourceFile.fileName);
		const projectService = Sessions.getProjectService(this.session);
		if (projectService === undefined) {
			return undefined;
		}
		const scriptInfo = projectService.getScriptInfoForNormalizedPath(file);
		return scriptInfo?.getLatestVersion();
	}
}

export class SingleLanguageServiceSession extends ComputeContextSession {

	private readonly languageService: tt.LanguageService;

	public readonly logger: Logger;

	constructor(languageService: tt.LanguageService, host: Host) {
		super(host, false);
		this.languageService = languageService;
		this.logger = new NullLogger();
	}

	public logError(_error: Error, _cmd: string): void {
		// Null logger;
	}

	public *getLanguageServices(sourceFile?: tt.SourceFile): IterableIterator<tt.LanguageService> {
		const ls: tt.LanguageService | undefined = this.languageService;
		if (ls === undefined) {
			return;
		}
		if (sourceFile === undefined) {
			yield ls;
		} else {
			const file = ts.server.toNormalizedPath(sourceFile.fileName);
			const scriptInfo = ls.getProgram()?.getSourceFile(file);
			if (scriptInfo === undefined) {
				return;
			}
			yield ls;
		}
	}

	public override run<R>(search: Search<R>, context: RequestContext, token: tt.CancellationToken): [tt.Program | undefined, R | undefined] {
		const program = this.languageService.getProgram();
		if (program === undefined) {
			return [undefined, undefined];
		}
		if (search.score(program, context) === 0) {
			return [undefined, undefined];
		}
		const programSearch = search.with(program);
		const result = programSearch.run(context, token);
		if (result !== undefined) {
			return [program, result];
		} else {
			return [undefined, undefined];
		}
	}

	public override getScriptVersion(_sourceFile: tt.SourceFile): string | undefined {
		return undefined;
	}
}

export interface SnippetProvider {
	isEmpty(): boolean;
	snippet(key: string | undefined, priority: number, speculativeKind: SpeculativeKind): CodeSnippet;
}


export class RunnableResult {

	private readonly id: string;
	private readonly tokenBudget: TokenBudget;
	private readonly contextItemManager: ContextItemManager;
	private state: ContextRunnableState;
	private cache: CacheInfo | undefined;
	public readonly items: ContextItem[];

	constructor(id: string, tokenBudget: TokenBudget, contextItemManager: ContextItemManager, cache?: CacheInfo | undefined) {
		this.id = id;
		this.tokenBudget = tokenBudget;
		this.contextItemManager = contextItemManager;
		this.state = ContextRunnableState.Created;
		this.cache = cache;
		this.items = [];
	}

	public isTokenBudgetExhausted(): boolean {
		if (this.tokenBudget.isExhausted()) {
			this.state = ContextRunnableState.IsFull;
			return true;
		}
		return false;
	}

	public done(): void {
		if (this.state === ContextRunnableState.Created || this.state === ContextRunnableState.InProgress) {
			this.state = ContextRunnableState.Finished;
		}
	}

	public setCacheInfo(cache: CacheInfo): void {
		this.cache = cache;
	}

	public addFromKnownItems(key: string): boolean {
		this.state = ContextRunnableState.InProgress;
		const reference = this.contextItemManager.createContextItemReference(key);
		if (reference === undefined) {
			return false;
		}
		this.items.push(reference);
		return true;
	}

	public addTrait(traitKind: TraitKind, priority: number, name: string, value: string): void {
		this.state = ContextRunnableState.InProgress;
		const trait = Trait.create(traitKind, priority, name, value);
		this.items.push(this.contextItemManager.manageContextItem(trait));
		this.tokenBudget.spent(Trait.sizeInChars(trait));
	}

	public addSnippet(code: SnippetProvider, key: string | undefined, priority: number, speculativeKind: SpeculativeKind): void;
	public addSnippet(code: SnippetProvider, key: string | undefined, priority: number, speculativeKind: SpeculativeKind, ifRoom: false): void;
	public addSnippet(code: SnippetProvider, key: string | undefined, priority: number, speculativeKind: SpeculativeKind, ifRoom: true): boolean;
	public addSnippet(code: SnippetProvider, key: string | undefined, priority: number, speculativeKind: SpeculativeKind, ifRoom: boolean = false): boolean {
		if (code.isEmpty()) {
			return true;
		}
		const snippet: CodeSnippet = code.snippet(key, priority, speculativeKind);
		const size = CodeSnippet.sizeInChars(snippet);
		if (ifRoom && !this.tokenBudget.hasRoom(size)) {
			this.state = ContextRunnableState.IsFull;
			return false;
		}
		this.state = ContextRunnableState.InProgress;
		this.tokenBudget.spent(size);
		this.items.push(this.contextItemManager.manageContextItem(snippet));
		return true;
	}

	public toJson(): ContextRunnableResult {
		return {
			kind: ContextRunnableResultKind.ComputedResult,
			id: this.id,
			state: this.state,
			items: this.items,
			cache: this.cache
		};
	}
}

class RunnableResultReference {

	private readonly cached: CachedContextRunnableResult;

	constructor(cached: CachedContextRunnableResult) {
		this.cached = cached;
	}

	public get items(): ContextItem[] {
		const result: ContextItem[] = [];
		for (const item of this.cached.items) {
			result.push(ContextItemReference.create(item.key));
		}
		return result;
	}

	public toJson(): ContextRunnableResultReference {
		return {
			kind: ContextRunnableResultKind.Reference,
			id: this.cached.id,
		};
	}
}

export interface ContextItemManager {
	createContextItemReference(key: ContextItemKey): ContextItemReference | undefined;
	manageContextItem(item: FullContextItem): ContextItem;
}

export class ContextResult implements ContextItemManager {

	public readonly tokenBudget: TokenBudget;
	public readonly context: RequestContext;

	private state: ContextRequestResultState;
	private path: number[] | undefined;
	private timings: Timings | undefined;
	private timedOut: boolean;
	private readonly errors: ErrorData[];

	private readonly runnableResults: (RunnableResult | RunnableResultReference)[] = [];
	private readonly contextItems: Map<ContextItemKey, FullContextItem>;

	constructor(tokenBudget: TokenBudget, context: RequestContext) {
		this.tokenBudget = tokenBudget;
		this.context = context;
		this.state = ContextRequestResultState.Created;
		this.path = undefined;
		this.timedOut = false;
		this.errors = [];
		this.runnableResults = [];
		this.contextItems = new Map<ContextItemKey, FullContextItem>();
	}

	public addPath(path: number[]): void {
		this.path = path;
	}

	public addErrorData(error: RecoverableError): void {
		this.errors.push(ErrorData.create(error.code, error.message));
	}

	public addTimings(totalTime: number, computeTime: number): void {
		this.timings = Timings.create(totalTime, computeTime);
	}

	public setTimedOut(timedOut: boolean): void {
		this.timedOut = timedOut;
	}

	public createRunnableResult(id: string, cache?: CacheInfo | undefined): RunnableResult {
		this.state = ContextRequestResultState.InProgress;
		const result = new RunnableResult(id, this.tokenBudget, this, cache);
		this.runnableResults.push(result);
		return result;
	}

	public addRunnableResultReference(cached: CachedContextRunnableResult): void {
		this.state = ContextRequestResultState.InProgress;
		this.runnableResults.push(new RunnableResultReference(cached));
	}

	public createContextItemReference(key: ContextItemKey): ContextItemReference | undefined {
		const clientSide = this.context.createContextItemReferenceIfManaged(key);
		if (clientSide !== undefined) {
			return clientSide;
		}
		const serverSide = this.contextItems.get(key);
		if (serverSide !== undefined) {
			return ContextItemReference.create(key);
		}
		return undefined;
	}

	public manageContextItem(item: FullContextItem): ContextItem {
		if (!ContextItem.hasKey(item)) {
			return item;
		}
		const key = item.key;
		if (this.context.clientHasContextItem(key)) {
			// The item is already known on the client side.
			return ContextItemReference.create(key);
		}
		if (this.contextItems.has(key)) {
			// The item is already known on the server side.
			return ContextItemReference.create(key);
		}
		this.contextItems.set(key, item);
		return ContextItemReference.create(key);
	}

	public done(): void {
		this.state = ContextRequestResultState.Finished;
	}

	public items(): FullContextItem[] {
		const seen: Set<ContextItemKey> = new Set();
		const items: FullContextItem[] = [];
		for (const runnableResult of this.runnableResults) {
			for (const item of runnableResult.items) {
				if (item.kind === ContextKind.Reference) {
					if (seen.has(item.key)) {
						// We have already seen this item, skip it.
						continue;
					}
					seen.add(item.key);
					const referenced = this.contextItems.get(item.key);
					if (referenced !== undefined) {
						items.push(referenced);
					}
				} else {
					items.push(item);
				}
			}
		}
		return items;
	}

	public toJson(): ContextRequestResult {
		const runnableResults: ContextRunnableResultTypes[] = [];
		for (const runnableResult of this.runnableResults) {
			runnableResults.push(runnableResult.toJson());
		}
		return {
			state: this.state,
			path: this.path,
			timings: this.timings,
			errors: this.errors,
			timedOut: this.timedOut,
			exhausted: this.tokenBudget.isExhausted(),
			runnableResults: runnableResults,
			contextItems: Array.from(this.contextItems.values())
		};
	}
}

export enum ComputeCost {
	Low = 1,
	Medium = 2,
	High = 3
}

export type SymbolEmitData = {
	symbol: tt.Symbol;
	name?: string;
}

export namespace CacheScopes {
	export function fromDeclaration(declaration: tt.FunctionLikeDeclarationBase): CacheScope | undefined {
		const body = declaration.body;
		if (body === undefined || !ts.isBlock(body)) {
			return undefined;
		}
		return createWithinCacheScope(body, declaration.getSourceFile());
	}

	export function createWithinCacheScope(node: tt.Node, sourceFile?: tt.SourceFile | undefined): CacheScope;
	export function createWithinCacheScope(node: tt.NodeArray<tt.Node>, sourceFile: tt.SourceFile | undefined): CacheScope;
	export function createWithinCacheScope(node: tt.Node | tt.NodeArray<tt.Node>, sourceFile?: tt.SourceFile | undefined): CacheScope {
		return {
			kind: CacheScopeKind.WithinRange,
			range: createRange(node as any, sourceFile),
		};
	}

	export function createOutsideCacheScope(nodes: Iterable<tt.Node>, sourceFile: tt.SourceFile | undefined): CacheScope {
		const ranges: Range[] = [];
		for (const node of nodes) {
			ranges.push(createRange(node, sourceFile));
		}
		ranges.sort((a, b) => {
			if (a.start.line !== b.start.line) {
				return a.start.line - b.start.line;
			}
			return a.start.character - b.start.character;
		});
		return {
			kind: CacheScopeKind.OutsideRange,
			ranges
		};
	}

	export function createRange(node: tt.Node, sourceFile?: tt.SourceFile | undefined): Range;
	export function createRange(node: tt.NodeArray<tt.Node>, sourceFile: tt.SourceFile | undefined): Range;
	export function createRange(node: tt.Node | tt.NodeArray<tt.Node>, sourceFile?: tt.SourceFile | undefined): Range {
		let startOffset: number;
		let endOffset: number;
		if (isNodeArray(node)) {
			startOffset = node.pos;
			endOffset = node.end;
		} else {
			startOffset = node.getStart(sourceFile);
			endOffset = node.getEnd();
			if (sourceFile === undefined) {
				sourceFile = node.getSourceFile();
			}
		}
		const start = ts.getLineAndCharacterOfPosition(sourceFile!, startOffset);
		const end = ts.getLineAndCharacterOfPosition(sourceFile!, endOffset);
		return { start, end };
	}

	function isNodeArray(node: tt.Node | tt.NodeArray<tt.Node>): node is tt.NodeArray<tt.Node> {
		return Array.isArray(node);
	}
}

export interface ContextRunnable {
	readonly id: ContextRunnableResultId;
	readonly priority: number;
	readonly cost: ComputeCost;
	initialize(result: ContextResult): void;
	compute(token: tt.CancellationToken): void;
}

class CacheBasedContextRunnable implements ContextRunnable {

	private readonly cached: CachedContextRunnableResult;
	private tokenBudget: TokenBudget | undefined;

	public readonly id: ContextRunnableResultId;
	public readonly priority: number;
	public readonly cost: ComputeCost;

	constructor(cached: CachedContextRunnableResult, priority: number, cost: ComputeCost) {
		this.cached = cached;
		this.id = cached.id;
		this.priority = priority;
		this.cost = cost;
	}

	initialize(result: ContextResult): void {
		this.tokenBudget = result.tokenBudget;
		result.addRunnableResultReference(this.cached);
	}

	compute(): void {
		if (this.tokenBudget === undefined) {
			return;
		}
		// Update the token budget.
		for (const item of this.cached.items) {
			this.tokenBudget.spent(item.sizeInChars ?? 0);
		}
	}
}

export abstract class AbstractContextRunnable implements ContextRunnable {

	protected readonly session: ComputeContextSession;
	protected readonly languageService: tt.LanguageService;
	private readonly program: tt.Program | undefined;
	protected readonly context: RequestContext;
	protected readonly symbols: Symbols;

	public readonly id: ContextRunnableResultId;
	public readonly priority: number;
	public readonly cost: ComputeCost;

	private result: RunnableResult | undefined;

	constructor(session: ComputeContextSession, languageService: tt.LanguageService, context: RequestContext, id: string, priority: number, cost: ComputeCost) {
		this.session = session;
		this.languageService = languageService;
		this.program = languageService.getProgram();
		this.context = context;
		this.symbols = context.getSymbols(this.getProgram());
		this.id = id;
		this.priority = priority;
		this.cost = cost;
	}

	public initialize(result: ContextResult): void {
		if (this.result !== undefined) {
			throw new Error('Runnable already initialized');
		}
		this.result = this.createRunnableResult(result);
	}

	public useCachedResult(cached: CachedContextRunnableResult): boolean {
		const cacheInfo = cached.cache;
		if (cacheInfo === undefined) {
			return false;
		}
		if (cacheInfo.emitMode === EmitMode.ClientBased && cached.state === ContextRunnableState.Finished) {
			return true;
		} else {
			return false;
		}
	}

	public compute(token: tt.CancellationToken): void {
		if (this.result === undefined) {
			throw new Error('Runnable not initialized');
		}
		token.throwIfCancellationRequested();
		if (this.result.isTokenBudgetExhausted()) {
			return;
		}
		this.run(this.result, token);
		this.result.done();
	}

	protected abstract createRunnableResult(result: ContextResult): RunnableResult;

	protected abstract run(result: RunnableResult, token: tt.CancellationToken): void;

	protected getProgram(): tt.Program {
		if (this.program === undefined) {
			throw new RecoverableError('No program available', RecoverableError.NoProgram);
		}
		return this.program;
	}

	protected createCacheScope(node: tt.Node, sourceFile?: tt.SourceFile | undefined): CacheScope;
	protected createCacheScope(node: tt.NodeArray<tt.Node>, sourceFile: tt.SourceFile | undefined): CacheScope;
	protected createCacheScope(node: tt.Node | tt.NodeArray<tt.Node>, sourceFile?: tt.SourceFile | undefined): CacheScope {
		return CacheScopes.createWithinCacheScope(node as any, sourceFile);
	}

	protected addScopeNode<T extends tt.Node>(scopeNodes: Set<T>, symbol: tt.Symbol, kind: tt.SyntaxKind, sourceFile: tt.SourceFile): Set<T> | undefined {
		const declarations = symbol.getDeclarations();
		if (declarations === undefined) {
			return undefined;
		}
		let scopeNode: T | undefined = undefined;
		let outsideDeclarations: number = 0;
		for (const declaration of declarations) {
			if (declaration.getSourceFile() !== sourceFile) {
				outsideDeclarations++;
				continue;
			}
			const parent = tss.Nodes.getParentOfKind(declaration, kind) as T;
			if (parent === undefined) {
				return undefined;
			}
			if (scopeNode === undefined) {
				scopeNode = parent;
			} else if (scopeNode !== parent) {
				return undefined;
			}
		}
		if (outsideDeclarations < declarations.length) {
			if (scopeNode !== undefined) {
				scopeNodes.add(scopeNode);
			} else {
				return undefined;
			}
		}
		return scopeNodes;
	}

	protected createCacheInfo(emitMode: EmitMode, cacheScope?: CacheScope | undefined): CacheInfo | undefined {
		return cacheScope !== undefined ? { emitMode, scope: cacheScope } : undefined;
	}

	protected handleSymbolIfKnown(result: RunnableResult, symbol: tt.Symbol): [boolean, string | undefined] {
		const key = Symbols.createKey(symbol, this.session.host);
		if (key === undefined) {
			return [false, undefined];
		}

		if (result.addFromKnownItems(key)) {
			return [true, key];
		}

		return [false, key];
	}

	protected isNodeArray(node: tt.Node | tt.NodeArray<tt.Node>): node is tt.NodeArray<tt.Node> {
		return Array.isArray(node);
	}

	protected skipSourceFile(sourceFile: tt.SourceFile): boolean {
		const program = this.getProgram();
		return program.isSourceFileDefaultLibrary(sourceFile) || program.isSourceFileFromExternalLibrary(sourceFile);
	}

	protected getSymbolsToEmitForTypeNode(node: tt.TypeNode): SymbolEmitData[] {
		const result: SymbolEmitData[] = [];
		this.doGetSymbolsToEmitForTypeNode(result, node);
		return result;
	}

	private doGetSymbolsToEmitForTypeNode(result: SymbolEmitData[], node: tt.TypeNode): void {
		if (ts.isTypeReferenceNode(node)) {
			const symbol = this.symbols.getLeafSymbolAtLocation(node.typeName);
			if (symbol !== undefined) {
				result.push({ symbol, name: node.typeName.getText() });
			}
		} else if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
			for (const type of node.types) {
				this.doGetSymbolsToEmitForTypeNode(result, type);
			}
		}
	}

	protected getSymbolsToEmitForType(type: tt.Type): SymbolEmitData[] {
		const result: SymbolEmitData[] = [];
		this.doGetSymbolsToEmitForType(result, type);
		return result;
	}

	private doGetSymbolsToEmitForType(result: SymbolEmitData[], type: tt.Type): void {
		const symbol = type.getSymbol();
		if (symbol !== undefined) {
			result.push({ symbol, name: symbol.getName() });
		} else if (Types.isIntersection(type) || Types.isUnion(type)) {
			for (const item of type.types) {
				this.doGetSymbolsToEmitForType(result, item);
			}
		}
	}
}

export class ContextRunnableCollector {

	private readonly cachedRunnableResults: Map<string, CachedContextRunnableResult>;

	public readonly primary: ContextRunnable[];
	public readonly secondary: ContextRunnable[];
	public readonly tertiary: ContextRunnable[];

	constructor(cachedRunnableResults: Map<string, CachedContextRunnableResult>) {
		this.cachedRunnableResults = cachedRunnableResults;
		this.primary = [];
		this.secondary = [];
		this.tertiary = [];
	}

	public addPrimary(runnable: AbstractContextRunnable): void {
		this.primary.push(this.useCachedRunnableIfPossible(runnable));
	}

	public addSecondary(runnable: AbstractContextRunnable): void {
		this.secondary.push(this.useCachedRunnableIfPossible(runnable));
	}

	public addTertiary(runnable: AbstractContextRunnable): void {
		this.tertiary.push(this.useCachedRunnableIfPossible(runnable));
	}

	public *entries(): IterableIterator<ContextRunnable> {
		for (const runnable of this.primary) {
			yield runnable;
		}
		for (const runnable of this.secondary) {
			yield runnable;
		}
		for (const runnable of this.tertiary) {
			yield runnable;
		}
	}

	public getPrimaryRunnables(): ContextRunnable[] {
		return this.primary.sort((a, b) => {
			const result = a.cost - b.cost;
			if (result !== 0) {
				return result;
			}
			return b.priority - a.priority;
		});
	}

	public getSecondaryRunnables(): ContextRunnable[] {
		return this.secondary.sort((a, b) => {
			const result = a.cost - b.cost;
			if (result !== 0) {
				return result;
			}
			return b.priority - a.priority;
		});
	}

	public getTertiaryRunnables(): ContextRunnable[] {
		return this.tertiary.sort((a, b) => {
			const result = a.cost - b.cost;
			if (result !== 0) {
				return result;
			}
			return b.priority - a.priority;
		});
	}

	private useCachedRunnableIfPossible(runnable: AbstractContextRunnable): ContextRunnable {
		const cached = this.cachedRunnableResults.get(runnable.id);
		if (cached === undefined) {
			return runnable;
		}
		return runnable.useCachedResult(cached) ? new CacheBasedContextRunnable(cached, runnable.priority, runnable.cost) : runnable;
	}
}

export abstract class ContextProvider {

	constructor() {
	}

	public isCallableProvider?: boolean;
	public abstract provide(result: ContextRunnableCollector, session: ComputeContextSession, languageService: tt.LanguageService, context: RequestContext, token: tt.CancellationToken): void;
}

export interface ProviderComputeContext {
	isFirstCallableProvider(contextProvider: ContextProvider): boolean;
}
export type ContextProviderFactory = (node: tt.Node, tokenInfo: tss.TokenInfo, context: ProviderComputeContext) => ContextProvider | undefined;

export class TokenBudgetExhaustedError extends Error {
	constructor() {
		super('Budget exhausted');
	}
}

export class TokenBudget {

	private charBudget: number;
	private lowWaterMark: number;
	private itemRejected: boolean;

	constructor(budget: number, lowWaterMark: number = 64) {
		// This is an approximation that we can have 4 characters
		// per token on average.
		this.charBudget = budget * 4;
		this.lowWaterMark = lowWaterMark * 4;
		this.itemRejected = false;
	}

	public spent(chars: number): void {
		this.charBudget -= chars;
	}

	public hasRoom(chars: number): boolean {
		const result = this.charBudget - this.lowWaterMark >= chars;
		if (!result) {
			this.itemRejected = true;
		}
		return result;
	}

	public isExhausted(): boolean {
		return this.charBudget <= 0;
	}

	public wasItemRejected(): boolean {
		return this.itemRejected;
	}

	public throwIfExhausted(): void {
		if (this.charBudget <= 0) {
			throw new TokenBudgetExhaustedError();
		}
	}

	public spentAndThrowIfExhausted(chars: number): void {
		this.spent(chars);
		this.throwIfExhausted();
	}
}