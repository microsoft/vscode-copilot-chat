/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { match } from '../../../util/vs/base/common/glob';
import { Schemas } from '../../../util/vs/base/common/network';
import { dirname, isAbsolute } from '../../../util/vs/base/common/path';
import { joinPath } from '../../../util/vs/base/common/resources';
import { isObject } from '../../../util/vs/base/common/types';
import { URI } from '../../../util/vs/base/common/uri';
import { FileType, Uri } from '../../../vscodeTypes';
import { CodeGenerationImportInstruction, CodeGenerationTextInstruction, Config, ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { IFileSystemService } from '../../filesystem/common/fileSystemService';
import { ILogService } from '../../log/common/logService';
import { IPromptPathRepresentationService } from '../../prompts/common/promptPathRepresentationService';
import { IWorkspaceService } from '../../workspace/common/workspaceService';

declare const TextDecoder: {
	decode(input: Uint8Array): string;
	new(): TextDecoder;
};

export interface ICustomInstructions {
	readonly kind: CustomInstructionsKind;
	readonly content: IInstruction[];
	readonly reference: vscode.Uri;
}

export enum CustomInstructionsKind {
	File,
	Setting,
}

export interface IInstruction {
	readonly languageId?: string;
	readonly instruction: string;
}

export const ICustomInstructionsService = createServiceIdentifier<ICustomInstructionsService>('ICustomInstructionsService');

export interface ICustomInstructionsService {
	readonly _serviceBrand: undefined;
	fetchInstructionsFromSetting(configKey: Config<CodeGenerationInstruction[]>): Promise<ICustomInstructions[]>;
	fetchInstructionsFromFile(fileUri: Uri): Promise<ICustomInstructions | undefined>;

	getAgentInstructions(): Promise<URI[]>;

	isExternalInstructionsFile(uri: URI): boolean;
}

export type CodeGenerationInstruction = { languagee?: string; text: string } | { languagee?: string; file: string };

function isCodeGenerationImportInstruction(instruction: any): instruction is CodeGenerationImportInstruction {
	if (typeof instruction === 'object' && instruction !== null) {
		return typeof instruction.file === 'string' && (instruction.language === undefined || typeof instruction.language === 'string');
	}
	return false;
}

function isCodeGenerationTextInstruction(instruction: any): instruction is CodeGenerationTextInstruction {
	if (typeof instruction === 'object' && instruction !== null) {
		return typeof instruction.text === 'string' && (instruction.language === undefined || typeof instruction.language === 'string');
	}
	return false;
}

const INSTRUCTION_FILE_EXTENSION = '.instructions.md';
const INSTRUCTIONS_LOCATION_KEY = 'chat.instructionsFilesLocations';

const COPILOT_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';


export class CustomInstructionsService implements ICustomInstructionsService {

	readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvService private readonly envService: IEnvService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@ILogService private readonly logService: ILogService,
	) {
	}

	public async fetchInstructionsFromFile(fileUri: Uri): Promise<ICustomInstructions | undefined> {
		return await this.readInstructionsFromFile(fileUri);
	}

	public async getAgentInstructions(): Promise<URI[]> {
		const result = [];
		if (this.configurationService.getConfig(ConfigKey.UseInstructionFiles)) {
			for (const folder of this.workspaceService.getWorkspaceFolders()) {
				try {
					const uri = joinPath(folder, COPILOT_INSTRUCTIONS_PATH);
					if ((await this.fileSystemService.stat(uri)).type === FileType.File) {
						result.push(uri);
					}
				} catch (e) {
					// ignore non-existing instruction files
				}
			}
		}
		return result;
	}

	public async fetchInstructionsFromSetting(configKey: Config<CodeGenerationInstruction[]>): Promise<ICustomInstructions[]> {
		const result: ICustomInstructions[] = [];

		const instructions: IInstruction[] = [];
		const seenFiles: Set<string> = new Set();

		const inspect = this.configurationService.inspectConfig(configKey);
		if (inspect) {
			await this.collectInstructionsFromSettings([inspect.workspaceFolderValue, inspect.workspaceValue, inspect.globalValue], seenFiles, instructions, result);
		}

		const reference = Uri.from({ scheme: this.envService.uriScheme, authority: 'settings', path: `/${configKey.fullyQualifiedId}` });
		if (instructions.length > 0) {
			result.push({
				kind: CustomInstructionsKind.Setting,
				content: instructions,
				reference,
			});
		}
		return result;
	}

	private async collectInstructionsFromSettings(instructionsArrays: (CodeGenerationInstruction[] | undefined)[], seenFiles: Set<string>, instructions: IInstruction[], result: ICustomInstructions[]): Promise<void> {
		const seenInstructions: Set<string> = new Set();
		for (const instructionsArray of instructionsArrays) {
			if (Array.isArray(instructionsArray)) {
				for (const entry of instructionsArray) {
					if (isCodeGenerationImportInstruction(entry) && !seenFiles.has(entry.file)) {
						seenFiles.add(entry.file);
						await this._collectInstructionsFromFile(entry.file, entry.language, result);
					}
					if (isCodeGenerationTextInstruction(entry) && !seenInstructions.has(entry.text)) {
						seenInstructions.add(entry.text);
						instructions.push({ instruction: entry.text, languageId: entry.language });
					}
				}
			}
		}
	}

	private async _collectInstructionsFromFile(customInstructionsFile: string, language: string | undefined, result: ICustomInstructions[]): Promise<void> {
		this.logService.debug(`Collect instructions from file: ${customInstructionsFile}`);
		const promises = this.workspaceService.getWorkspaceFolders().map(async folderUri => {
			const fileUri = Uri.joinPath(folderUri, customInstructionsFile);
			const instruction = await this.readInstructionsFromFile(fileUri);
			if (instruction) {
				result.push(instruction);
			}
		});
		await Promise.all(promises);
	}

	private async readInstructionsFromFile(fileUri: Uri, languageId?: string): Promise<ICustomInstructions | undefined> {
		try {
			const fileContents = await this.fileSystemService.readFile(fileUri);
			const content = new TextDecoder().decode(fileContents);
			const instruction = content.trim();
			if (!instruction) {
				this.logService.debug(`Instructions file is empty: ${fileUri.toString()}`);
				return;
			}
			return {
				kind: CustomInstructionsKind.File,
				content: [{ instruction, languageId }],
				reference: fileUri
			};
		} catch (e) {
			this.logService.debug(`Instructions file not found: ${fileUri.toString()}`);
			return undefined;
		}
	}

	public isExternalInstructionsFile(uri: URI): boolean {
		if (!uri.path.endsWith(INSTRUCTION_FILE_EXTENSION)) {
			return false;
		}
		if (uri.scheme === Schemas.vscodeUserData) {
			return true;
		}
		if (uri.scheme !== Schemas.file) {
			return false;
		}
		const instructionFilePath = this.promptPathRepresentationService.getFilePath(uri);
		const instructionFolderPath = dirname(instructionFilePath);

		const locations = this.configurationService.getNonExtensionConfig<Record<string, boolean>>(INSTRUCTIONS_LOCATION_KEY);
		if (isObject(locations)) {
			for (const key in locations) {
				const location = key.trim();
				const value = locations[key];
				if (value === true && isAbsolute(location)) {
					const pathToMatch = location.endsWith('/') || location.endsWith('*') ? instructionFolderPath : location;
					if (match(pathToMatch, location)) {
						return true;
					}
				}
			}
		}
		return true;
	}
}
