/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IIgnoreService } from '../../../../platform/ignore/common/ignoreService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { Uri } from '../../../../vscodeTypes';

export const IPromptWorkspaceLabels = createServiceIdentifier<IPromptWorkspaceLabels>('IPromptWorkspaceLabels');
export interface IPromptWorkspaceLabels {
	readonly _serviceBrand: undefined;
	/**
	 * Will be unique and sorted.
	 */
	readonly labels: string[];
	collectContext(): Promise<void>;
}

export class PromptWorkspaceLabels implements IPromptWorkspaceLabels {
	declare _serviceBrand: undefined;

	private readonly basicWorkspaceLabels: IPromptWorkspaceLabelsStrategy;

	private get workspaceLabels(): IPromptWorkspaceLabelsStrategy {
		return this.basicWorkspaceLabels;
	}

	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		this.basicWorkspaceLabels = this._instantiationService.createInstance(BasicPromptWorkspaceLabels);
	}

	public get labels(): string[] {
		const uniqueLabels = [...new Set(this.workspaceLabels.labels)].sort();
		return uniqueLabels;
	}

	public async collectContext(): Promise<void> {
		await this.workspaceLabels.collectContext();

		const uniqueLabels = [...new Set(this.labels)].sort();

		/* __GDPR__
			"projectLabels" : {
				"owner": "digitarald",
				"comment": "Reports quality of labels detected in a workspace",
				"labels": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Unique workspace label count." },
				"count": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Unique workspace labels in context." }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('projectLabels', {
			labels: uniqueLabels.join(',').replaceAll('@', ' ')
		}, {
			count: uniqueLabels.length,
		});
	}
}

interface IPromptWorkspaceLabelsStrategy {
	readonly labels: string[];
	collectContext(): Promise<void>;
}

class BasicPromptWorkspaceLabels implements IPromptWorkspaceLabelsStrategy {

	indicators: Map<string, string[]> = new Map<string, string[]>();
	contentIndicators: Map<string, (contents: string) => string[]> = new Map<string, (contents: string) => string[]>();
	private readonly _labels: string[] = [];

	constructor(
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
	) {
		this.initIndicators();
	}

	public get labels(): string[] {
		// Check if labels have both javascript and typescript and remove javascript
		// This can confuse the LLM and typescript should take precedent so types are returned.
		if (this._labels.includes('javascript') && this._labels.includes('typescript')) {
			const index = this._labels.indexOf('javascript');
			this._labels.splice(index, 1);
		}
		return this._labels;
	}

	public async collectContext() {
		const folders = this._workspaceService.getWorkspaceFolders();
		if (folders) {
			for (let i = 0; i < folders.length; i++) {
				await this.addContextForFolders(folders[i]);
			}
		}
	}

	private async addContextForFolders(f: Uri) {
		for (const [filename, labels] of this.indicators.entries()) {
			await this.addLabelIfApplicable(f, filename, labels);
		}
	}

	private async addLabelIfApplicable(rootFolder: Uri, filename: string, labels: string[]) {
		const uri = Uri.joinPath(rootFolder, filename);

		if (await this._ignoreService.isCopilotIgnored(uri)) {
			return;
		}

		try {
			await this._fileSystemService.stat(uri);
			labels.forEach(label => this._labels.push(label));
			const parseCallback = this.contentIndicators.get(filename);
			if (parseCallback) {
				const b = await this._fileSystemService.readFile(uri);
				try {
					const contentLabels = parseCallback(new TextDecoder().decode(b));
					contentLabels.forEach(label => this._labels.push(label));
				} catch (e) {
					// it's ok if we can't parse those files
				}
			}
		} catch (e) {
			// ignore non-existing files
		}
	}

	private initIndicators() {
		this.addIndicator('package.json', 'javascript', 'npm');
		this.addIndicator('tsconfig.json', 'typescript');
		this.addIndicator('pom.xml', 'java', 'maven');
		this.addIndicator('build.gradle', 'java', 'gradle');
		this.addIndicator('requirements.txt', 'python', 'pip');
		this.addIndicator('Pipfile', 'python', 'pip');
		this.addIndicator('Cargo.toml', 'rust', 'cargo');
		this.addIndicator('go.mod', 'go', 'go.mod');
		this.addIndicator('pubspec.yaml', 'dart', 'pub');
		this.addIndicator('build.sbt', 'scala', 'sbt');
		this.addIndicator('build.boot', 'clojure', 'boot');
		this.addIndicator('project.clj', 'clojure', 'lein');
		this.addIndicator('mix.exs', 'elixir', 'mix');
		this.addIndicator('composer.json', 'php', 'composer');
		this.addIndicator('Gemfile', 'ruby', 'bundler');
		this.addIndicator('build.xml', 'java', 'ant');
		this.addIndicator('build.gradle.kts', 'java', 'gradle');
		this.addIndicator('yarn.lock', 'yarn');
		this.addIndicator('CMakeLists.txt', 'c++', 'cmake');
		this.addIndicator('vcpkg.json', 'c++');
		this.addIndicator('Makefile', 'c++', 'makefile');
		this.addContentIndicator('CMakeLists.txt', this.collectCMakeListsTxtIndicators);
		this.addContentIndicator('package.json', this.collectPackageJsonIndicators);
	}

	private addIndicator(filename: string, ...labels: string[]) {
		this.indicators.set(filename, labels);
	}

	protected addContentIndicator(filename: string, callback: (contents: string) => string[]) {
		this.contentIndicators.set(filename, callback);
	}

	private collectCMakeListsTxtIndicators(contents: string): string[] {
		function parseStandardVersion(contents: string, regex: RegExp, allowedList: number[]): number | undefined {
			try {
				const matchResult = Array.from(contents.matchAll(regex));
				if (matchResult && matchResult[0] && matchResult[0][1]) {
					const version = parseInt(matchResult[0][1]);
					if (allowedList.includes(version)) {
						return version;
					}
				}
			} catch (e) {
				// It's ok if the parsing of the standard version fails.
			}
			return undefined;
		}

		const tags: string[] = [];
		const cppLangStdVer = parseStandardVersion(contents,
			/set\s*\(\s*CMAKE_CXX_STANDARD\s*(\d+)/gmi, [98, 11, 14, 17, 20, 23, 26]);
		if (cppLangStdVer) {
			tags.push(`C++${cppLangStdVer}`);
		}

		const cLangStdVer = parseStandardVersion(contents,
			/set\s*\(\s*CMAKE_C_STANDARD\s*(\d+)/gmi, [90, 99, 11, 17, 23]);
		if (cLangStdVer) {
			tags.push(`C${cLangStdVer}`);
		}
		return tags;
	}

	private collectPackageJsonIndicators(contents: string): string[] {
		const tags = [];
		const json = JSON.parse(contents);
		const dependencies = json.dependencies;
		const devDependencies = json.devDependencies;
		if (dependencies) {
			if (dependencies['@angular/core']) {
				tags.push('angular');
			}
			if (dependencies['react']) {
				tags.push('react');
			}
			if (dependencies['vue']) {
				tags.push('vue');
			}
		}
		if (devDependencies) {
			if (devDependencies['typescript']) {
				tags.push('typescript');
			}
		}
		const engines = json.engines;
		if (engines) {
			if (engines['node']) {
				tags.push('node');
			}
			if (engines['vscode']) {
				tags.push('vscode extension');
			}
		}
		return tags;
	}
}
