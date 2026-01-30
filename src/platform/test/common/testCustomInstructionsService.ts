/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ResourceSet } from '../../../util/vs/base/common/map';
import { URI } from '../../../util/vs/base/common/uri';
import type { Uri } from '../../../vscodeTypes';
import { Config } from '../../configuration/common/configurationService';
import { CodeGenerationInstruction, ICustomInstructions, ICustomInstructionsService, IInstructionIndexFile } from '../../customInstructions/common/customInstructionsService';

/**
 * A configurable mock implementation of ICustomInstructionsService for testing.
 * Allows setting skill files and external instruction files for different test scenarios.
 */
export class MockCustomInstructionsService implements ICustomInstructionsService {
	declare readonly _serviceBrand: undefined;

	private skillFiles = new Set<string>();
	private externalFiles = new Set<string>();
	private externalFolders = new Set<string>();
	private extensionSkillInfos = new Map<string, { skillName: string; skillFolderUri: URI }>();

	parseInstructionIndexFile(promptFileIndexText: string): IInstructionIndexFile {
		return {
			instructions: new ResourceSet(),
			skills: new ResourceSet(),
			skillFolders: new ResourceSet(),
			agents: new Set<string>()
		};
	}

	/**
	 * Set the URIs that should be recognized as skill files.
	 */
	setSkillFiles(uris: URI[]): void {
		this.skillFiles.clear();
		uris.forEach(uri => this.skillFiles.add(uri.toString()));
	}

	/**
	 * Set the URIs that should be recognized as external instruction files.
	 */
	setExternalFiles(uris: URI[]): void {
		this.externalFiles.clear();
		uris.forEach(uri => this.externalFiles.add(uri.toString()));
	}

	/**
	 * Set the URIs that should be recognized as external instruction folders.
	 */
	setExternalFolders(uris: URI[]): void {
		this.externalFolders.clear();
		uris.forEach(uri => this.externalFolders.add(uri.toString()));
	}

	/**
	 * Set the URIs that should be recognized as extension skill files with their info.
	 */
	setExtensionSkillInfos(infos: { uri: URI; skillName: string; skillFolderUri: URI }[]): void {
		this.extensionSkillInfos.clear();
		infos.forEach(info => this.extensionSkillInfos.set(info.uri.toString(), { skillName: info.skillName, skillFolderUri: info.skillFolderUri }));
	}

	isSkillFile(uri: URI): boolean {
		return this.skillFiles.has(uri.toString());
	}

	isSkillMdFile(uri: URI): boolean {
		return this.isSkillFile(uri) && uri.path.toLowerCase().endsWith('skill.md');
	}

	getSkillDirectory(uri: URI): URI {
		// Simple mock implementation: return parent directory
		return URI.parse(uri.toString().substring(0, uri.toString().lastIndexOf('/')));
	}

	getSkillName(uri: URI): string {
		const skillDir = this.getSkillDirectory(uri);
		const path = skillDir.path;
		return path.substring(path.lastIndexOf('/') + 1);
	}

	getSkillMdUri(uri: URI): URI {
		if (this.isSkillMdFile(uri)) {
			return uri;
		}
		const skillDir = this.getSkillDirectory(uri);
		return URI.joinPath(skillDir, 'SKILL.md');
	}

	getSkillInfo(uri: URI): { skillName: string; skillFolderUri: URI } | undefined {
		if (!this.isSkillFile(uri)) {
			return undefined;
		}
		const skillFolderUri = this.getSkillDirectory(uri);
		const skillName = this.getSkillName(uri);
		return { skillName, skillFolderUri };
	}

	isExternalInstructionsFile(uri: URI): Promise<boolean> {
		return Promise.resolve(this.externalFiles.has(uri.toString()));
	}

	isExternalInstructionsFolder(uri: URI): boolean {
		return this.externalFolders.has(uri.toString());
	}

	fetchInstructionsFromSetting(_configKey: Config<CodeGenerationInstruction[]>): Promise<ICustomInstructions[]> {
		return Promise.resolve([]);
	}

	fetchInstructionsFromFile(_fileUri: Uri): Promise<ICustomInstructions | undefined> {
		return Promise.resolve(undefined);
	}

	getAgentInstructions(): Promise<URI[]> {
		return Promise.resolve([]);
	}

	refreshExtensionPromptFiles(): Promise<void> {
		return Promise.resolve();
	}

	getExtensionSkillInfo(uri: URI): { skillName: string; skillFolderUri: URI } | undefined {
		return this.extensionSkillInfos.get(uri.toString());
	}
}
