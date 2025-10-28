/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { TypeScriptServiceHost } from '../typescript/vscode/typescriptServiceHost';
import { TypeScriptTypeHierarchyProvider } from '../typescript/vscode/typescriptTypeHierarchyProvider';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { ILanguageFeaturesService } from '../common/languageFeaturesService';

export class LanguageFeaturesServiceImpl implements ILanguageFeaturesService {

	declare readonly _serviceBrand: undefined;

	private readonly typeScriptServiceHost: TypeScriptServiceHost;
	private readonly typeScriptHierarchyProvider: TypeScriptTypeHierarchyProvider;
	private readonly typeScriptSnapshots = new Map<string, string>();
	private readonly typeScriptLanguageIds = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
	private readonly disposables = new DisposableStore();
	private firedTelemetry = false;

	constructor(
		@ITelemetryService private readonly telemetryService: ITelemetryService
	) {
		this.typeScriptServiceHost = new TypeScriptServiceHost({
			documentTextResolver: (uri) => this.resolveTypeScriptDocumentText(uri)
		});
		this.typeScriptHierarchyProvider = new TypeScriptTypeHierarchyProvider(this.typeScriptServiceHost);

		for (const document of vscode.workspace.textDocuments) {
			if (this.isTypeScriptLanguage(document.languageId)) {
				this.updateTypeScriptSnapshot(document);
			}
		}

		this.disposables.add(vscode.workspace.onDidChangeTextDocument(event => {
			if (this.isTypeScriptLanguage(event.document.languageId)) {
				this.updateTypeScriptSnapshot(event.document);
			}
		}));

		this.disposables.add(vscode.workspace.onDidCloseTextDocument(document => {
			if (this.isTypeScriptLanguage(document.languageId)) {
				const key = this.normalizeFsPath(document.uri.fsPath);
				this.typeScriptSnapshots.delete(key);
				this.typeScriptServiceHost.clear(document.uri);
			}
		}));
	}

	async getDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<(vscode.LocationLink | vscode.Location)[]> {
		return await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
	}

	async getImplementations(uri: vscode.Uri, position: vscode.Position): Promise<(vscode.LocationLink | vscode.Location)[]> {
		return await vscode.commands.executeCommand('vscode.executeImplementationProvider', uri, position);
	}

	async getReferences(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
		return await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position);
	}

	async getWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
		return await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
	}

	async getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
		return await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
	}

	getDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
		return vscode.languages.getDiagnostics(uri);
	}

	async prepareTypeHierarchy(uri: vscode.Uri, position: vscode.Position): Promise<vscode.TypeHierarchyItem[]> {
		const document = await this.tryGetDocument(uri);
		if (document && this.shouldUseTypeScriptProvider(document)) {
			this.updateTypeScriptSnapshot(document);
			this.fireTypeScriptTelemetry();
			const cancellation = new vscode.CancellationTokenSource();
			try {
				return await this.typeScriptHierarchyProvider.prepare(uri, position, cancellation.token);
			} finally {
				cancellation.dispose();
			}
		}

		const result = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
			'vscode.prepareTypeHierarchy',
			uri,
			position
		);
		return result ?? [];
	}

	async getTypeHierarchySupertypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[]> {
		const document = await this.tryGetDocument(item.uri);
		if (document && this.shouldUseTypeScriptProvider(document)) {
			this.updateTypeScriptSnapshot(document);
			this.fireTypeScriptTelemetry();
			const cancellation = new vscode.CancellationTokenSource();
			try {
				return await this.typeScriptHierarchyProvider.supertypes(item, cancellation.token);
			} finally {
				cancellation.dispose();
			}
		}

		const result = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
			'vscode.provideSupertypes',
			item
		);
		return result ?? [];
	}

	async getTypeHierarchySubtypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[]> {
		const document = await this.tryGetDocument(item.uri);
		if (document && this.shouldUseTypeScriptProvider(document)) {
			this.updateTypeScriptSnapshot(document);
			this.fireTypeScriptTelemetry();
			const cancellation = new vscode.CancellationTokenSource();
			try {
				return await this.typeScriptHierarchyProvider.subtypes(item, cancellation.token);
			} finally {
				cancellation.dispose();
			}
		}

		const result = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
			'vscode.provideSubtypes',
			item
		);
		return result ?? [];
	}

	private async tryGetDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
		const openDocument = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
		if (openDocument) {
			return openDocument;
		}

		try {
			return await vscode.workspace.openTextDocument(uri);
		} catch {
			return undefined;
		}
	}

	private shouldUseTypeScriptProvider(document: vscode.TextDocument): boolean {
		return this.isTypeScriptLanguage(document.languageId);
	}

	private isTypeScriptLanguage(languageId: string): boolean {
		return this.typeScriptLanguageIds.has(languageId);
	}

	private updateTypeScriptSnapshot(document: vscode.TextDocument): void {
		const key = this.normalizeFsPath(document.uri.fsPath);
		this.typeScriptSnapshots.set(key, document.getText());
	}

	private async resolveTypeScriptDocumentText(uri: vscode.Uri): Promise<string | undefined> {
		const key = this.normalizeFsPath(uri.fsPath);
		const cached = this.typeScriptSnapshots.get(key);
		if (typeof cached === 'string') {
			return cached;
		}

		const openDocument = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
		if (openDocument) {
			const text = openDocument.getText();
			this.typeScriptSnapshots.set(key, text);
			return text;
		}

		return undefined;
	}

	private normalizeFsPath(fsPath: string): string {
		const normalized = path.normalize(fsPath);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	}

	private fireTypeScriptTelemetry(): void {
		if (this.firedTelemetry) {
			return;
		}

		this.firedTelemetry = true;
		try {
			this.telemetryService.sendGHTelemetryEvent('copilot.typeHierarchy.typescript.used');
		} catch {
			// ignore telemetry errors
		}
	}

	dispose(): void {
		this.disposables.dispose();
		this.typeScriptServiceHost.dispose();
		this.typeScriptHierarchyProvider.dispose();
	}
}
