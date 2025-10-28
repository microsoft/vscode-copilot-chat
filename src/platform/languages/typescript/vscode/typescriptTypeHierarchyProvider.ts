/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as ts from 'typescript';
import * as vscode from 'vscode';
import { TypeScriptServiceHost, type ITypeScriptProgramContext, type ITypeScriptServiceHost } from './typescriptServiceHost';

type TypeHierarchyDeclaration =
	| ts.ClassDeclaration
	| ts.InterfaceDeclaration
	| ts.EnumDeclaration
	| ts.TypeAliasDeclaration;

export class TypeScriptTypeHierarchyProvider {

	private readonly host: ITypeScriptServiceHost;
	private readonly ownsHost: boolean;
	private readonly symbolCache = new WeakMap<vscode.TypeHierarchyItem, ts.Symbol>();

	constructor(host?: ITypeScriptServiceHost) {
		if (host) {
			this.host = host;
			this.ownsHost = false;
		} else {
			this.host = new TypeScriptServiceHost();
			this.ownsHost = true;
		}
	}

	async prepare(uri: vscode.Uri, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[]> {
		const context = await this.host.getContext(uri, token);
		if (!context) {
			return [];
		}

		const declaration = this.findDeclarationAtPosition(context, position);
		if (!declaration) {
			return [];
		}

		const item = this.createHierarchyItem(context, declaration, uri);
		return item ? [item] : [];
	}

	async supertypes(item: vscode.TypeHierarchyItem, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[]> {
		const context = await this.host.getContext(item.uri, token);
		if (!context) {
			return [];
		}

		if (token.isCancellationRequested) {
			return [];
		}

		const symbol = await this.resolveSymbolForItem(context, item, token);
		if (!symbol) {
			return [];
		}

		const declaration = this.getPrimaryDeclaration(symbol);
		if (!declaration) {
			return [];
		}

		const heritageTypes = this.getImmediateHeritageTypes(context, declaration);
		if (heritageTypes.length === 0) {
			return [];
		}

		const results: vscode.TypeHierarchyItem[] = [];
		for (const baseType of heritageTypes) {
			if (token.isCancellationRequested) {
				break;
			}

			const baseSymbol = baseType.getSymbol() ?? baseType.aliasSymbol;
			if (!baseSymbol) {
				continue;
			}
			const baseDeclaration = this.getPrimaryDeclaration(baseSymbol);
			if (!baseDeclaration) {
				continue;
			}
			const baseUri = vscode.Uri.file(baseDeclaration.getSourceFile().fileName);
			const baseContext = baseDeclaration.getSourceFile() === context.sourceFile ?
				context :
				await this.host.getContext(baseUri, token);
			if (!baseContext) {
				continue;
			}
			const itemResult = this.createHierarchyItem(baseContext, baseDeclaration, baseUri, baseSymbol);
			if (itemResult) {
				results.push(itemResult);
			}
		}

		return this.dedupe(results);
	}

	async subtypes(item: vscode.TypeHierarchyItem, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[]> {
		const context = await this.host.getContext(item.uri, token);
		if (!context) {
			return [];
		}

		const positionOffset = context.sourceFile.getPositionOfLineAndCharacter(
			item.selectionRange.start.line,
			item.selectionRange.start.character
		);
		const implementations = context.languageService.getImplementationAtPosition(context.fileName, positionOffset) ?? [];

		const results: vscode.TypeHierarchyItem[] = [];
		for (const impl of implementations) {
			if (token.isCancellationRequested) {
				break;
			}
			const implUri = vscode.Uri.file(impl.fileName);
			const implContext = await this.host.getContext(implUri, token);
			if (!implContext) {
				continue;
			}

			const implPosition = implContext.sourceFile.getLineAndCharacterOfPosition(impl.textSpan.start);
			const declaration = this.findDeclarationAtPosition(
				implContext,
				new vscode.Position(implPosition.line, implPosition.character)
			);
			if (!declaration) {
				continue;
			}

			const subtypeItem = this.createHierarchyItem(implContext, declaration, implUri);
			if (subtypeItem && !this.isSameHierarchyItem(subtypeItem, item)) {
				results.push(subtypeItem);
			}
		}

		return this.dedupe(results);
	}

	dispose(): void {
		if (this.ownsHost) {
			this.host.dispose();
		}
	}

	private findDeclarationAtPosition(context: ITypeScriptProgramContext, position: vscode.Position): TypeHierarchyDeclaration | undefined {
		const offset = context.sourceFile.getPositionOfLineAndCharacter(position.line, position.character);
		let candidate: TypeHierarchyDeclaration | undefined;

		const visit = (node: ts.Node) => {
			if (offset < node.getStart(context.sourceFile, false) || offset > node.getEnd()) {
				return;
			}

			if (this.isTypeDeclaration(node)) {
				candidate = node;
			}

			ts.forEachChild(node, visit);
		};

		ts.forEachChild(context.sourceFile, visit);
		return candidate;
	}

	private createHierarchyItem(
		context: ITypeScriptProgramContext,
		declaration: TypeHierarchyDeclaration,
		uri: vscode.Uri,
		symbolOverride?: ts.Symbol
	): vscode.TypeHierarchyItem | undefined {
		const symbol = symbolOverride ?? this.getSymbolForDeclaration(context, declaration);
		const nameNode = ts.getNameOfDeclaration(declaration);
		const displayName = symbol?.getName() ?? nameNode?.getText() ?? '<anonymous>';
		if (!displayName || displayName === '__type') {
			return undefined;
		}

		const detail = symbol ? context.typeChecker.getFullyQualifiedName(symbol) : '';
		const kind = this.mapSymbolKind(declaration);
		const range = this.nodeToRange(context.sourceFile, declaration);
		const selectionRange = this.nodeToRange(context.sourceFile, nameNode ?? declaration);

		const item = new vscode.TypeHierarchyItem(kind, displayName, detail, uri, range, selectionRange);
		if (symbol) {
			this.symbolCache.set(item, symbol);
		}
		return item;
	}

	private getImmediateHeritageTypes(
		context: ITypeScriptProgramContext,
		declaration: TypeHierarchyDeclaration
	): ts.Type[] {
		if (!('heritageClauses' in declaration) || !declaration.heritageClauses) {
			return [];
		}

		const results: ts.Type[] = [];
		const seen = new Set<ts.Symbol>();

		for (const clause of declaration.heritageClauses) {
			for (const typeNode of clause.types ?? []) {
				const heritageType = context.typeChecker.getTypeAtLocation(typeNode);
				if (!heritageType) {
					continue;
				}
				const symbol = heritageType.getSymbol() ?? heritageType.aliasSymbol;
				if (!symbol || seen.has(symbol)) {
					continue;
				}
				seen.add(symbol);
				results.push(heritageType);
			}
		}

		return results;
	}

	private async resolveSymbolForItem(
		context: ITypeScriptProgramContext,
		item: vscode.TypeHierarchyItem,
		token: vscode.CancellationToken
	): Promise<ts.Symbol | undefined> {
		const cached = this.symbolCache.get(item);
		if (cached) {
			return cached;
		}

		const offset = context.sourceFile.getPositionOfLineAndCharacter(
			item.selectionRange.start.line,
			item.selectionRange.start.character
		);

		const declaration = this.findDeclarationAtOffset(context.sourceFile, offset);
		if (!declaration) {
			return undefined;
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		const symbol = this.getSymbolForDeclaration(context, declaration);
		if (symbol) {
			this.symbolCache.set(item, symbol);
		}
		return symbol;
	}

	private findDeclarationAtOffset(sourceFile: ts.SourceFile, offset: number): TypeHierarchyDeclaration | undefined {
		let candidate: TypeHierarchyDeclaration | undefined;
		const visit = (node: ts.Node) => {
			if (offset < node.getStart(sourceFile, false) || offset > node.getEnd()) {
				return;
			}

			if (this.isTypeDeclaration(node)) {
				candidate = node;
			}

			ts.forEachChild(node, visit);
		};

		ts.forEachChild(sourceFile, visit);
		return candidate;
	}

	private getSymbolForDeclaration(context: ITypeScriptProgramContext, declaration: TypeHierarchyDeclaration): ts.Symbol | undefined {
		const name = ts.getNameOfDeclaration(declaration);
		if (name) {
			const symbol = context.typeChecker.getSymbolAtLocation(name);
			if (symbol) {
				return symbol;
			}
		}
		return context.typeChecker.getSymbolAtLocation(declaration);
	}

	private getPrimaryDeclaration(symbol: ts.Symbol): TypeHierarchyDeclaration | undefined {
		const declarations = symbol.getDeclarations();
		if (!declarations || declarations.length === 0) {
			return undefined;
		}

		for (const declaration of declarations) {
			if (this.isTypeDeclaration(declaration)) {
				return declaration;
			}
		}

		return undefined;
	}

	private mapSymbolKind(declaration: TypeHierarchyDeclaration): vscode.SymbolKind {
		switch (declaration.kind) {
			case ts.SyntaxKind.ClassDeclaration:
				return vscode.SymbolKind.Class;
			case ts.SyntaxKind.InterfaceDeclaration:
				return vscode.SymbolKind.Interface;
			case ts.SyntaxKind.EnumDeclaration:
				return vscode.SymbolKind.Enum;
			case ts.SyntaxKind.TypeAliasDeclaration:
			default:
				return vscode.SymbolKind.TypeParameter;
		}
	}

	private nodeToRange(sourceFile: ts.SourceFile, node: ts.Node): vscode.Range {
		const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
		const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
		return new vscode.Range(
			new vscode.Position(start.line, start.character),
			new vscode.Position(end.line, end.character)
		);
	}

	private isTypeDeclaration(node: ts.Node): node is TypeHierarchyDeclaration {
		switch (node.kind) {
			case ts.SyntaxKind.ClassDeclaration:
			case ts.SyntaxKind.InterfaceDeclaration:
			case ts.SyntaxKind.EnumDeclaration:
			case ts.SyntaxKind.TypeAliasDeclaration:
				return true;
			default:
				return false;
		}
	}

	private dedupe(items: vscode.TypeHierarchyItem[]): vscode.TypeHierarchyItem[] {
		const seen = new Set<string>();
		const result: vscode.TypeHierarchyItem[] = [];

		for (const item of items) {
			const key = `${item.uri.toString()}:${item.selectionRange.start.line}:${item.selectionRange.start.character}:${item.name}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			result.push(item);
		}

		return result;
	}

	private isSameHierarchyItem(a: vscode.TypeHierarchyItem, b: vscode.TypeHierarchyItem): boolean {
		return a.uri.toString() === b.uri.toString()
			&& a.selectionRange.start.line === b.selectionRange.start.line
			&& a.selectionRange.start.character === b.selectionRange.start.character
			&& a.selectionRange.end.line === b.selectionRange.end.line
			&& a.selectionRange.end.character === b.selectionRange.end.character;
	}
}
