/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as ts from 'typescript';
import type * as vscode from 'vscode';

export interface ITypeScriptProgramContext {
	readonly program: ts.Program;
	readonly languageService: ts.LanguageService;
	readonly typeChecker: ts.TypeChecker;
	readonly fileName: string;
	readonly sourceFile: ts.SourceFile;
}

export type TypeScriptDocumentTextResolver = (uri: vscode.Uri) => Promise<string | undefined>;

export interface ITypeScriptServiceHostOptions {
	readonly documentTextResolver?: TypeScriptDocumentTextResolver;
}

export interface ITypeScriptServiceHost {
	getContext(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<ITypeScriptProgramContext | undefined>;
	clear(uri: vscode.Uri): void;
	dispose(): void;
}

interface ITypeScriptProject {
	readonly key: string;
	readonly rootDir: string;
	readonly compilerOptions: ts.CompilerOptions;
	readonly languageService: ts.LanguageService;
	readonly files: Map<string, string>;
	readonly snapshots: Map<string, ts.IScriptSnapshot>;
	readonly versions: Map<string, number>;
}

export class TypeScriptServiceHost implements ITypeScriptServiceHost {

	private readonly projects = new Map<string, ITypeScriptProject>();
	private readonly documentRegistry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames);
	private readonly useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames;

	constructor(private readonly options: ITypeScriptServiceHostOptions = {}) { }

	async getContext(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<ITypeScriptProgramContext | undefined> {
		if (token?.isCancellationRequested) {
			return undefined;
		}

		const fileName = this.normalizePath(uri.fsPath);
		const project = await this.ensureProject(fileName);
		if (!project) {
			return undefined;
		}

		const overrideText = this.options.documentTextResolver ? await this.options.documentTextResolver(uri) : undefined;
		this.updateScript(project, fileName, overrideText);

		const program = project.languageService.getProgram();
		if (!program) {
			return undefined;
		}

		const sourceFile = program.getSourceFile(fileName);
		if (!sourceFile) {
			return undefined;
		}

		return {
			program,
			languageService: project.languageService,
			typeChecker: program.getTypeChecker(),
			fileName,
			sourceFile
		};
	}

	clear(uri: vscode.Uri): void {
		const fileName = this.normalizePath(uri.fsPath);
		const canonical = this.getCanonicalFileName(fileName);

		for (const project of this.projects.values()) {
			project.snapshots.delete(canonical);
			project.versions.delete(canonical);

			if (project.files.delete(canonical) && project.files.size === 0) {
				project.languageService.dispose();
				this.projects.delete(project.key);
			}
		}
	}

	dispose(): void {
		for (const project of this.projects.values()) {
			project.languageService.dispose();
		}
		this.projects.clear();
	}

	private async ensureProject(fileName: string): Promise<ITypeScriptProject | undefined> {
		const configPath = this.findConfigFile(fileName);
		const key = configPath ?? this.normalizePath(path.dirname(fileName));

		let project = this.projects.get(key);
		if (!project) {
			project = this.createProject(key, configPath, fileName);
			if (!project) {
				return undefined;
			}
			this.projects.set(key, project);
		}

		const canonical = this.getCanonicalFileName(fileName);
		if (!project.files.has(canonical)) {
			project.files.set(canonical, fileName);
		}

		return project;
	}

	private createProject(key: string, configPath: string | undefined, initialFile: string): ITypeScriptProject | undefined {
		const rootDir = configPath ? path.dirname(configPath) : path.dirname(initialFile);
		let compilerOptions: ts.CompilerOptions;
		let fileNames: readonly string[];

		if (configPath) {
			const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
			if (readResult.error) {
				return undefined;
			}

			const parsed = ts.parseJsonConfigFileContent(
				readResult.config,
				ts.sys,
				rootDir
			);
			fileNames = parsed.fileNames;
			compilerOptions = parsed.options;
		} else {
			fileNames = [initialFile];
			compilerOptions = {
				allowJs: true,
				esModuleInterop: true,
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				skipLibCheck: true,
				jsx: ts.JsxEmit.ReactJSX,
				target: ts.ScriptTarget.Latest
			};
		}

		const files = new Map<string, string>();
		for (const file of fileNames) {
			files.set(this.getCanonicalFileName(this.normalizePath(file)), this.normalizePath(file));
		}

		const snapshots = new Map<string, ts.IScriptSnapshot>();
		const versions = new Map<string, number>();

		const host: ts.LanguageServiceHost = {
			getCompilationSettings: () => compilerOptions,
			getCurrentDirectory: () => rootDir,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			getScriptFileNames: () => Array.from(files.values()),
			getScriptVersion: (fileName) => {
				const canonical = this.getCanonicalFileName(this.normalizePath(fileName));
				return String(versions.get(canonical) ?? 0);
			},
			getScriptSnapshot: (fileName) => {
				const normalized = this.normalizePath(fileName);
				const canonical = this.getCanonicalFileName(normalized);
				const cached = snapshots.get(canonical);
				if (cached) {
					return cached;
				}

				if (!ts.sys.fileExists(normalized)) {
					return undefined;
				}

				const text = ts.sys.readFile(normalized);
				if (typeof text !== 'string') {
					return undefined;
				}

				const snapshot = ts.ScriptSnapshot.fromString(text);
				snapshots.set(canonical, snapshot);
				return snapshot;
			},
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
			getDirectories: ts.sys.getDirectories,
			directoryExists: ts.sys.directoryExists,
			useCaseSensitiveFileNames: () => this.useCaseSensitiveFileNames
		};

		return {
			key,
			rootDir,
			compilerOptions,
			languageService: ts.createLanguageService(host, this.documentRegistry),
			files,
			snapshots,
			versions
		};
	}

	private updateScript(project: ITypeScriptProject, fileName: string, overrideText: string | undefined): void {
		const normalized = this.normalizePath(fileName);
		const canonical = this.getCanonicalFileName(normalized);

		project.files.set(canonical, normalized);

		let snapshot: ts.IScriptSnapshot | undefined;
		if (typeof overrideText === 'string') {
			snapshot = ts.ScriptSnapshot.fromString(overrideText);
		} else if (ts.sys.fileExists(normalized)) {
			const text = ts.sys.readFile(normalized);
			if (typeof text === 'string') {
				snapshot = ts.ScriptSnapshot.fromString(text);
			}
		}

		if (snapshot) {
			project.snapshots.set(canonical, snapshot);
		} else {
			project.snapshots.delete(canonical);
		}

		const currentVersion = project.versions.get(canonical) ?? 0;
		project.versions.set(canonical, currentVersion + 1);
	}

	private findConfigFile(fileName: string): string | undefined {
		const directory = path.dirname(fileName);
		return ts.findConfigFile(directory, ts.sys.fileExists);
	}

	private normalizePath(fileName: string): string {
		return path.normalize(path.isAbsolute(fileName) ? fileName : path.join(ts.sys.getCurrentDirectory(), fileName));
	}

	private getCanonicalFileName(fileName: string): string {
		return this.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
	}
}
