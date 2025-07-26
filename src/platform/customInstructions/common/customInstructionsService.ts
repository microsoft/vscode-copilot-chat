/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Uri } from '../../../vscodeTypes';
import { CodeGenerationImportInstruction, CodeGenerationTextInstruction, Config, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { IFileSystemService } from '../../filesystem/common/fileSystemService';
import { ILogService } from '../../log/common/logService';
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

export class CustomInstructionsService implements ICustomInstructionsService {

	readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvService private readonly envService: IEnvService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
	) {
	}

	public async fetchInstructionsFromFile(fileUri: Uri): Promise<ICustomInstructions | undefined> {
		return await this.readInstructionsFromFile(fileUri);
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
}
