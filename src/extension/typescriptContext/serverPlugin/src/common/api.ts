/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type tt from 'typescript/lib/tsserverlibrary';
import TS from './typescript';
const ts = TS();

import tss from './typescripts';

import { CompilerOptionsRunnable } from './baseContextProviders';
import { ClassContextProvider } from './classContextProvider';
import { ContextProvider, ContextRunnableCollector, RequestContext, type ComputeContextSession, type ContextProviderFactory, type ContextResult, type ContextRunnable, type ProviderComputeContext } from './contextProvider';
import { FunctionContextProvider } from './functionContextProvider';
import { AccessorProvider, ConstructorContextProvider, MethodContextProvider } from './methodContextProvider';
import { ModuleContextProvider } from './moduleContextProvider';
import { validateNesRename, type PrepareNesRenameResult } from './nesRenameValidator';
import { RenameKind, type FilePath, type LastSymbolRename } from './protocol';
import { SourceFileContextProvider } from './sourceFileContextProvider';
import { RecoverableError } from './types';

class ProviderComputeContextImpl implements ProviderComputeContext {

	private firstCallableProvider: ContextProvider | undefined;

	constructor() {
		this.firstCallableProvider = undefined;
	}

	public update(contextProvider: ContextProvider): ContextProvider {
		if (this.firstCallableProvider === undefined && contextProvider.isCallableProvider !== undefined && contextProvider.isCallableProvider === true) {
			this.firstCallableProvider = contextProvider;
		}
		return contextProvider;
	}

	public isFirstCallableProvider(contextProvider: ContextProvider): boolean {
		return this.firstCallableProvider === contextProvider;
	}
}

class ContextProviders {

	private static readonly Factories = new Map<tt.SyntaxKind, ContextProviderFactory>([
		[ts.SyntaxKind.SourceFile, (_node, tokenInfo, computeContext) => new SourceFileContextProvider(tokenInfo, computeContext)],
		[ts.SyntaxKind.FunctionDeclaration, (node, tokenInfo, computeContext) => new FunctionContextProvider(node as tt.FunctionDeclaration, tokenInfo, computeContext)],
		[ts.SyntaxKind.ArrowFunction, (node, tokenInfo, computeContext) => new FunctionContextProvider(node as tt.ArrowFunction, tokenInfo, computeContext)],
		[ts.SyntaxKind.FunctionExpression, (node, tokenInfo, computeContext) => new FunctionContextProvider(node as tt.FunctionExpression, tokenInfo, computeContext)],
		[ts.SyntaxKind.GetAccessor, (node, tokenInfo, computeContext) => new AccessorProvider(node as tt.GetAccessorDeclaration, tokenInfo, computeContext)],
		[ts.SyntaxKind.SetAccessor, (node, tokenInfo, computeContext) => new AccessorProvider(node as tt.SetAccessorDeclaration, tokenInfo, computeContext)],
		[ts.SyntaxKind.ClassDeclaration, ClassContextProvider.create as unknown as ContextProviderFactory],
		[ts.SyntaxKind.Constructor, (node, tokenInfo, computeContext) => new ConstructorContextProvider(node as tt.ConstructorDeclaration, tokenInfo, computeContext)],
		[ts.SyntaxKind.MethodDeclaration, (node, tokenInfo, computeContext) => new MethodContextProvider(node as tt.MethodDeclaration, tokenInfo, computeContext)],
		[ts.SyntaxKind.ModuleDeclaration, (node, tokenInfo, computeContext) => new ModuleContextProvider(node as tt.ModuleDeclaration, tokenInfo, computeContext)],
	]);

	private readonly tokenInfo: tss.TokenInfo;
	private readonly computeInfo: ProviderComputeContextImpl;


	constructor(tokenInfo: tss.TokenInfo) {
		this.tokenInfo = tokenInfo;
		this.computeInfo = new ProviderComputeContextImpl();
	}

	public execute(result: ContextResult, session: ComputeContextSession, languageService: tt.LanguageService, token: tt.CancellationToken): void {
		const collector = this.getContextRunnables(session, languageService, result.context, token);
		result.addPath(tss.StableSyntaxKinds.getPath(this.tokenInfo.touching ?? this.tokenInfo.token));
		for (const runnable of collector.entries()) {
			runnable.initialize(result);
		}
		this.executeRunnables(collector.getPrimaryRunnables(), result, token);
		this.executeRunnables(collector.getSecondaryRunnables(), result, token);
		this.executeRunnables(collector.getTertiaryRunnables(), result, token);
		result.done();
	}

	private executeRunnables(runnables: ContextRunnable[], result: ContextResult, token: tt.CancellationToken): void {
		for (const runnable of runnables) {
			token.throwIfCancellationRequested();
			try {
				runnable.compute(token);
			} catch (error) {
				if (error instanceof RecoverableError) {
					result.addErrorData(error);
				} else {
					throw error;
				}
			}
		}
	}

	private getContextRunnables(session: ComputeContextSession, languageService: tt.LanguageService, context: RequestContext, token: tt.CancellationToken): ContextRunnableCollector {
		const result: ContextRunnableCollector = new ContextRunnableCollector(context.clientSideRunnableResults);
		result.addPrimary(new CompilerOptionsRunnable(session, languageService, context, this.tokenInfo.token.getSourceFile()));
		const providers = this.computeProviders();
		for (const provider of providers) {
			provider.provide(result, session, languageService, context, token);
		}
		return result;
	}

	private computeProviders(): ContextProvider[] {
		const result: ContextProvider[] = [];

		let token = this.tokenInfo.touching;
		if (token === undefined) {
			if (this.tokenInfo.token === undefined || this.tokenInfo.token.kind === ts.SyntaxKind.EndOfFileToken) {
				token = this.tokenInfo.previous;
			} else {
				token = this.tokenInfo.token;
			}
		}
		if (token === undefined || token.kind === ts.SyntaxKind.EndOfFileToken) {
			return result;
		}
		let current = token;
		while (current !== undefined) {
			const factory = ContextProviders.Factories.get(current.kind);
			if (factory !== undefined) {
				const provider = factory(current, this.tokenInfo, this.computeInfo);
				if (provider !== undefined) {
					result.push(this.computeInfo.update(provider));
				}
			}
			current = current.parent;
		}

		return result;
	}
}

export function computeContext(result: ContextResult, session: ComputeContextSession, languageService: tt.LanguageService, document: FilePath, position: number, token: tt.CancellationToken): void {
	const program = languageService.getProgram();
	if (program === undefined) {
		result.addErrorData(new RecoverableError(`No program found on language service`, RecoverableError.NoProgram));
		return;
	}
	const sourceFile = program.getSourceFile(document);
	if (sourceFile === undefined) {
		result.addErrorData(new RecoverableError(`No source file found for document`, RecoverableError.NoSourceFile));
		return;
	}

	const tokenInfo = tss.getRelevantTokens(sourceFile, position);
	const providers = new ContextProviders(tokenInfo);
	providers.execute(result, session, languageService, token);
}

export function prepareNesRename(result: PrepareNesRenameResult, session: ComputeContextSession, languageService: tt.LanguageService, document: FilePath, position: number, oldName: string | undefined, newName: string | undefined, lastSymbolRename: LastSymbolRename | undefined, token: tt.CancellationToken): void {
	if (typeof oldName !== 'string' || oldName.length === 0) {
		result.setCanRename(RenameKind.no, 'No old name provided');
		return;
	}
	if (typeof newName !== 'string' || newName.length === 0) {
		result.setCanRename(RenameKind.no, 'No new name provided');
		return;
	}

	const program = languageService.getProgram();
	if (program === undefined) {
		result.setCanRename(RenameKind.no, 'No program found on language service');
		return;
	}

	const sourceFile = program.getSourceFile(document);
	if (sourceFile === undefined) {
		result.setCanRename(RenameKind.no, 'No source file found for document');
		return;
	}

	const renameInfo = languageService.getRenameInfo(document, position, {});
	if (!renameInfo.canRename) {
		if (lastSymbolRename !== undefined) {
			runPrepareNesRenameOnOldState(result, session, languageService, sourceFile, position, oldName, newName, lastSymbolRename, token);
			return;
		}
		result.setCanRename(RenameKind.no, renameInfo.localizedErrorMessage);
		return;
	}
	if (renameInfo.displayName !== oldName) {
		result.setCanRename(RenameKind.no, `Old name '${oldName}' does not match symbol name '${renameInfo.displayName}'`);
		return;
	}
	doPrepareNesRename(result, program, sourceFile, position, oldName, newName, token);
}

function doPrepareNesRename(result: PrepareNesRenameResult, program: tt.Program, sourceFile: tt.SourceFile, position: number, oldName: string, newName: string, token: tt.CancellationToken) {
	const tokenInfo = tss.getRelevantTokens(sourceFile, position);
	if (tokenInfo.token === undefined) {
		result.setCanRename(RenameKind.no, 'No token found at position');
		return;
	}
	result.setCanRename(RenameKind.maybe, oldName);
	token.throwIfCancellationRequested();
	validateNesRename(result, program, tokenInfo.token, oldName, newName, token);
}

function runPrepareNesRenameOnOldState(result: PrepareNesRenameResult, session: ComputeContextSession, languageService: tt.LanguageService, sourceFile: tt.SourceFile, position: number, oldName: string, newName: string, lastSymbolRename: LastSymbolRename, token: tt.CancellationToken) {
	const text = sourceFile.getFullText();
	// The API is 0-based for both line and offset
	const startPos = sourceFile.getPositionOfLineAndCharacter(lastSymbolRename.start.line, lastSymbolRename.start.offset);
	const endPos = sourceFile.getPositionOfLineAndCharacter(lastSymbolRename.end.line, lastSymbolRename.end.offset);
	const newText = text.substring(0, startPos) + oldName + text.substring(endPos);
	const newPos = position < startPos ? position : position - (newName.length - oldName.length);

	tss.LanguageServiceHost.runWithTemporaryFileUpdate(session.languageServiceHost, sourceFile.fileName, newText, (updatedProgram, _originalProgram, updatedSourceFile) => {
		const renameInfo = languageService.getRenameInfo(updatedSourceFile.fileName, newPos, {});
		if (!renameInfo.canRename) {
			result.setCanRename(RenameKind.no, renameInfo.localizedErrorMessage);
			return;
		}
		if (renameInfo.displayName !== oldName) {
			result.setCanRename(RenameKind.no, `Old name '${oldName}' does not match symbol name '${renameInfo.displayName}'`);
			return;
		}
		doPrepareNesRename(result, updatedProgram, updatedSourceFile, newPos, oldName, newName, token);
		if (result.getCanRename() === RenameKind.maybe || result.getCanRename() === RenameKind.yes) {
			result.setOnOldState(true);
		}
	});
}