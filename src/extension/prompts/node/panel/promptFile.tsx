/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptReference, PromptSizing } from '@vscode/prompt-tsx';
import type { ChatLanguageModelToolReference } from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IIgnoreService } from '../../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { URI } from '../../../../util/vs/base/common/uri';
import { PromptVariable } from '../../../prompt/common/chatVariablesCollection';
import { IPromptVariablesService } from '../../../prompt/node/promptVariablesService';
import { EmbeddedInsideUserMessage } from '../base/promptElement';
import { Tag } from '../base/tag';
import { FilePathMode } from './fileVariable';

export interface PromptFileProps extends BasePromptElementProps, EmbeddedInsideUserMessage {
	readonly variable: PromptVariable;
	readonly omitReferences?: boolean;
	readonly filePathMode: FilePathMode;
}

export class PromptFile extends PromptElement<PromptFileProps, void> {

	constructor(
		props: PromptFileProps,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IPromptVariablesService private readonly promptVariablesService: IPromptVariablesService,
		@ILogService private readonly logService: ILogService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IIgnoreService private readonly ignoreService: IIgnoreService
	) {
		super(props);
	}

	override async render(state: void, sizing: PromptSizing) {
		const variable = this.props.variable.reference;
		const uri = variable.value;
		if (!URI.isUri(uri)) {
			this.logService.debug(`Prompt file variable does not have a URI value: ${variable.value}`);
			return undefined;
		}

		if (await this.ignoreService.isCopilotIgnored(uri)) {
			return <ignoredFiles value={[uri]} />;
		}

		const content = await this.getBodyContent(uri, variable.toolReferences);
		const attrs: Record<string, string> = {};
		attrs.id = variable.name;
		if (this.props.filePathMode === FilePathMode.AsAttribute) {
			attrs.filePath = this.promptPathRepresentationService.getFilePath(uri);
		}
		return <Tag name='attachment' attrs={attrs}>
			{!this.props.omitReferences && <references value={[new PromptReference({ variableName: variable.name, value: uri }, undefined)]} />}
			Prompt instructions file:<br />
			{content}
		</Tag>;
	}

	private async getBodyContent(fileUri: URI, toolReferences: readonly ChatLanguageModelToolReference[] | undefined): Promise<string | undefined> {
		try {
			const fileContents = await this.fileSystemService.readFile(fileUri);
			let content = new TextDecoder().decode(fileContents);
			if (toolReferences && toolReferences.length > 0) {
				content = await this.promptVariablesService.resolveToolReferencesInPrompt(content, toolReferences);
			}

			let bodyOffset = 0;
			if (content.match(/^---[\s\r\n]/)) {
				// find the start of the body
				const match = content.slice(3).match(/[\r\n]---[\s\r\n]*/);
				if (match) {
					bodyOffset = match.index! + match[0].length;
				}
			}
			return content.substring(bodyOffset);
		} catch (e) {
			this.logService.debug(`Prompt file not found: ${fileUri.toString()}`);
			return undefined;
		}
	}
}
