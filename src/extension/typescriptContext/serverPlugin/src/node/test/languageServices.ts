/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import crypto from 'crypto';
import { statSync } from 'fs';
import path from 'path';

import type tt from 'typescript';
import TS from '../../common/typescript';
const ts = TS();

import { ComputeContextSession, type Logger } from '../../common/contextProvider';
import type { Host } from '../../common/host';

const isWindows = process.platform === 'win32';
function _normalizePath(value: string): string {
	if (isWindows) {
		value = value.replace(/\\/g, '/');
		if (/^[a-z]:/.test(value)) {
			value = value.charAt(0).toUpperCase() + value.substring(1);
		}
	}
	const result = path.posix.normalize(value);
	return result.length > 0 && result.charAt(result.length - 1) === '/' ? result.substr(0, result.length - 1) : result;
}

function makeAbsolute(p: string, root?: string): string {
	if (path.isAbsolute(p)) {
		return _normalizePath(p);
	}
	if (root === undefined) {
		return _normalizePath(path.join(process.cwd(), p));
	} else {
		return _normalizePath(path.join(root, p));
	}
}

interface InternalCompilerOptions extends tt.CompilerOptions {
	configFilePath?: string;
}

namespace ParseCommandLine {
	export function create(fileOrDirectory: string): tt.ParsedCommandLine {
		const stat = statSync(fileOrDirectory);
		let configFilePath: string;
		if (stat.isFile()) {
			configFilePath = fileOrDirectory;
		} else if (stat.isDirectory()) {
			configFilePath = path.join(fileOrDirectory, 'tsconfig.json');
		} else {
			throw new Error('The provided path is neither a file nor a directory.');
		}
		return loadConfigFile(configFilePath);
	}

	function getDefaultCompilerOptions(configFileName?: string) {
		const options: tt.CompilerOptions = configFileName && path.basename(configFileName) === 'jsconfig.json'
			? { allowJs: true, maxNodeModuleJsDepth: 2, allowSyntheticDefaultImports: true, skipLibCheck: true, noEmit: true }
			: {};
		return options;
	}

	function loadConfigFile(filePath: string): tt.ParsedCommandLine {
		const readResult = ts.readConfigFile(filePath, ts.sys.readFile);
		if (readResult.error) {
			throw new Error(ts.formatDiagnostics([readResult.error], ts.createCompilerHost({})));
		}
		const config = readResult.config;
		if (config.compilerOptions !== undefined) {
			config.compilerOptions = Object.assign(config.compilerOptions, getDefaultCompilerOptions(filePath));
		}
		const result = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(filePath));
		if (result.errors.length > 0) {
			throw new Error(ts.formatDiagnostics(result.errors, ts.createCompilerHost({})));
		}
		return result;
	}
}

namespace CompileOptions {
	export function getConfigFilePath(options: tt.CompilerOptions): string | undefined {
		if (options.project) {
			const projectPath = path.resolve(options.project);
			if (ts.sys.directoryExists(projectPath)) {
				return _normalizePath(path.join(projectPath, 'tsconfig.json'));
			} else {
				return _normalizePath(projectPath);
			}
		}
		const result = (options as InternalCompilerOptions).configFilePath;
		return result && makeAbsolute(result);
	}
}

interface InternalLanguageServiceHost extends tt.LanguageServiceHost {
	useSourceOfProjectReferenceRedirect?(): boolean;
}

namespace LanguageServiceHost {
	export function useSourceOfProjectReferenceRedirect(host: tt.LanguageServiceHost, value: () => boolean): void {
		(host as InternalLanguageServiceHost).useSourceOfProjectReferenceRedirect = value;
	}
}

export namespace LanguageServices {

	export function createLanguageService(fileOrDirectory: string): tt.LanguageService {
		const config = ParseCommandLine.create(fileOrDirectory);
		return LanguageServices._createLanguageService(config);
	}

	export function _createLanguageService(config: tt.ParsedCommandLine): tt.LanguageService {
		const configFilePath = CompileOptions.getConfigFilePath(config.options);
		const scriptSnapshots: Map<string, tt.IScriptSnapshot> = new Map();
		const host: tt.LanguageServiceHost = {
			getScriptFileNames: () => {
				return config.fileNames;
			},
			getCompilationSettings: () => {
				return config.options;
			},
			getProjectReferences: () => {
				return config.projectReferences;
			},
			getScriptVersion: (_fileName: string): string => {
				// The files are immutable.
				return '0';
			},
			// The project is immutable
			getProjectVersion: () => '0',
			getScriptSnapshot: (fileName: string): tt.IScriptSnapshot | undefined => {
				let result: tt.IScriptSnapshot | undefined = scriptSnapshots.get(fileName);
				if (result === undefined) {
					const content: string | undefined = ts.sys.fileExists(fileName) ? ts.sys.readFile(fileName) : undefined;
					if (content === undefined) {
						return undefined;
					}
					result = ts.ScriptSnapshot.fromString(content);
					scriptSnapshots.set(fileName, result);
				}
				return result;
			},
			getCurrentDirectory: () => {
				if (configFilePath !== undefined) {
					return path.dirname(configFilePath);
				} else {
					return process.cwd();
				}
			},
			getDefaultLibFileName: (options) => {
				// We need to return the path since the language service needs
				// to know the full path and not only the name which is return
				// from ts.getDefaultLibFileName
				return ts.getDefaultLibFilePath(options);
			},
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
			// this is necessary to make source references work.
			realpath: ts.sys.realpath
		};

		LanguageServiceHost.useSourceOfProjectReferenceRedirect(host, () => {
			return !config.options.disableSourceOfProjectReferenceRedirect;
		});

		const languageService: tt.LanguageService = ts.createLanguageService(host);
		const program = languageService.getProgram();
		if (program === undefined) {
			throw new Error('Couldn\'t create language service with underlying program.');
		}

		return languageService;
	}
}

class ConsoleLogger implements Logger {

	info(s: string): void {
		console.info(s);
	}

	msg(s: string, type?: tt.server.Msg): void {
		type = type ?? ts.server.Msg.Info;
		switch (type) {
			case ts.server.Msg.Err:
				console.error(s);
				break;
			case ts.server.Msg.Info:
				console.info(s);
				break;
			case ts.server.Msg.Perf:
				console.log(s);
				break;
			default:
				console.error(s);
		}

	}

	startGroup(): void {
		console.group();
	}

	endGroup(): void {
		console.groupEnd();
	}
}

export class LanguageServicesSession extends ComputeContextSession {

	private readonly languageServices: Map<string, tt.LanguageService>;

	public readonly logger: Logger;

	constructor(root: tt.LanguageService | string, host: Host) {
		super(host, true);
		this.logger = new ConsoleLogger();
		this.languageServices = new Map();
		let languageService: tt.LanguageService;
		let key: string | undefined;
		if (typeof root === 'string') {
			languageService = LanguageServices.createLanguageService(root);
			key = makeAbsolute(root);
		} else {
			languageService = root;
			key = CompileOptions.getConfigFilePath(languageService.getProgram()!.getCompilerOptions());
		}
		if (key === undefined) {
			throw new Error('Failed to create key');
		}
		this.languageServices.set(key, languageService);
		this.createDeep(languageService);
	}

	public override logError(error: Error, cmd: string): void {
		console.error(`Error in ${cmd}: ${error.message}`, error);
	}

	public override getScriptVersion(_sourceFile: tt.SourceFile): string | undefined {
		return '1';
	}

	public *getLanguageServices(sourceFile?: tt.SourceFile): IterableIterator<tt.LanguageService> {
		if (sourceFile === undefined) {
			yield* this.languageServices.values();
		} else {
			const file = ts.server.toNormalizedPath(sourceFile.fileName);
			for (const languageService of this.languageServices.values()) {
				const scriptInfo = languageService.getProgram()?.getSourceFile(file);
				if (scriptInfo === undefined) {
					continue;
				}
				yield languageService;
			}
		}
	}

	public entries() {
		return this.languageServices.values();
	}

	private createDeep(languageService: tt.LanguageService): void {
		const program = languageService.getProgram();
		if (program === undefined) {
			throw new Error(`Failed to create program`);
		}
		const references = program.getResolvedProjectReferences();
		if (references !== undefined) {
			for (const reference of references) {
				if (reference === undefined) {
					continue;
				}
				const configFilePath = CompileOptions.getConfigFilePath(reference.commandLine.options);
				const key = configFilePath ?? LanguageServicesSession.makeKey(reference.commandLine);
				if (this.languageServices.has(key)) {
					continue;
				}
				const languageService = LanguageServices._createLanguageService(reference.commandLine);
				this.languageServices.set(key, languageService);
				this.createDeep(languageService);
			}
		}
	}

	private static makeKey(config: tt.ParsedCommandLine): string {
		const hash = crypto.createHash('md5'); // CodeQL [SM04514] The 'md5' algorithm is used to compute a shorter string to represent command line arguments in a map. It has no security implications.
		hash.update(JSON.stringify(config.options, undefined, 0));
		return hash.digest('base64');
	}
}