/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptReference, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import { ConfigKey } from '../../../../platform/configuration/common/configurationService';
import { CustomInstructionsKind, ICustomInstructions, ICustomInstructionsService } from '../../../../platform/customInstructions/common/customInstructionsService';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { isUri } from '../../../../util/common/types';
import { isString } from '../../../../util/vs/base/common/types';
import { ChatVariablesCollection, isPromptInstruction } from '../../../prompt/common/chatVariablesCollection';
import { Tag } from '../base/tag';

export interface CustomInstructionsProps extends BasePromptElementProps {
	readonly chatVariables: ChatVariablesCollection | undefined;

	readonly languageId: string | undefined;
	/**
	 * @default true
	 */
	readonly includeCodeGenerationInstructions?: boolean;
	/**
	 * @default false
	 */
	readonly includeTestGenerationInstructions?: boolean;
	/**
	 * @default false
	 */
	readonly includeCodeFeedbackInstructions?: boolean;
	/**
	 * @default false
	 */
	readonly includeCommitMessageGenerationInstructions?: boolean;
	/**
	 * @default false
	 */
	readonly includePullRequestDescriptionGenerationInstructions?: boolean;
	readonly customIntroduction?: string;

	/**
	 * @default true
	 */
	readonly includeSystemMessageConflictWarning?: boolean;
}

export class CustomInstructions extends PromptElement<CustomInstructionsProps> {
	constructor(
		props: CustomInstructionsProps,
		@ICustomInstructionsService private readonly customInstructionsService: ICustomInstructionsService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService
	) {
		super(props);
	}
	override async render(state: void, sizing: PromptSizing) {

		const { includeCodeGenerationInstructions, includeTestGenerationInstructions, includeCodeFeedbackInstructions, includeCommitMessageGenerationInstructions, includePullRequestDescriptionGenerationInstructions, customIntroduction } = this.props;
		const includeSystemMessageConflictWarning = this.props.includeSystemMessageConflictWarning ?? true;

		const chunks = [];

		if (includeCodeGenerationInstructions !== false && this.props.chatVariables) {
			for (const variable of this.props.chatVariables) {
				if (isPromptInstruction(variable)) {
					if (isString(variable.value)) {
						chunks.unshift(<TextChunk>{variable.value}</TextChunk>);
					} else if (isUri(variable.value)) {
						const instructions = await this.customInstructionsService.fetchInstructionsFromFile(variable.value);
						if (instructions) {
							chunks.push(<Tag name='attachment' attrs={{ filePath: this.promptPathRepresentationService.getFilePath(variable.value) }}>
								<references value={[new CustomInstructionPromptReference(instructions, instructions.content.map(instruction => instruction.instruction))]} />
								{instructions.content.map(instruction => <TextChunk>{instruction.instruction}</TextChunk>)}
							</Tag>);
						}
					}
				}
			}
		}

		const customInstructions: ICustomInstructions[] = [];
		if (includeCodeGenerationInstructions !== false) {
			customInstructions.push(...await this.customInstructionsService.fetchInstructionsFromSetting(ConfigKey.CodeGenerationInstructions));
		}
		if (includeTestGenerationInstructions) {
			customInstructions.push(...await this.customInstructionsService.fetchInstructionsFromSetting(ConfigKey.TestGenerationInstructions));
		}
		if (includeCodeFeedbackInstructions) {
			customInstructions.push(...await this.customInstructionsService.fetchInstructionsFromSetting(ConfigKey.CodeFeedbackInstructions));
		}
		if (includeCommitMessageGenerationInstructions) {
			customInstructions.push(...await this.customInstructionsService.fetchInstructionsFromSetting(ConfigKey.CommitMessageGenerationInstructions));
		}
		if (includePullRequestDescriptionGenerationInstructions) {
			customInstructions.push(...await this.customInstructionsService.fetchInstructionsFromSetting(ConfigKey.PullRequestDescriptionGenerationInstructions));
		}
		for (const instruction of customInstructions) {
			const chunk = this.createInstructionElement(instruction);
			if (chunk) {
				chunks.push(chunk);
			}
		}
		if (chunks.length === 0) {
			return undefined;
		}
		const introduction = customIntroduction ?? 'When generating code, please follow these user provided coding instructions.';
		const systemMessageConflictWarning = includeSystemMessageConflictWarning && ' You can ignore an instruction if it contradicts a system message.';

		return (<>
			{introduction}{systemMessageConflictWarning}<br />
			<Tag name='instructions'>
				{
					...chunks
				}
			</Tag>

		</>);
	}

	private createInstructionElement(instructions: ICustomInstructions) {
		const lines = [];
		for (const entry of instructions.content) {
			if (entry.languageId) {
				if (entry.languageId === this.props.languageId) {
					lines.push(`For ${entry.languageId} code: ${entry.instruction}`);
				}
			} else {
				lines.push(entry.instruction);
			}
		}
		if (lines.length === 0) {
			return undefined;
		}

		return (<>
			<references value={[new CustomInstructionPromptReference(instructions, lines)]} />
			<>
				{
					lines.map(line => <TextChunk>{line}</TextChunk>)
				}
			</>
		</>);
	}
}

export class CustomInstructionPromptReference extends PromptReference {
	constructor(public readonly instructions: ICustomInstructions, public readonly usedInstructions: string[]) {
		super(instructions.reference);
	}
}

export function getCustomInstructionTelemetry(references: readonly PromptReference[]): { codeGenInstructionsCount: number; codeGenInstructionsLength: number; codeGenInstructionsFilteredCount: number; codeGenInstructionFileCount: number; codeGenInstructionSettingsCount: number } {
	let codeGenInstructionsCount = 0;
	let codeGenInstructionsFilteredCount = 0;
	let codeGenInstructionsLength = 0;
	let codeGenInstructionFileCount = 0;
	let codeGenInstructionSettingsCount = 0;

	for (const reference of references) {
		if (reference instanceof CustomInstructionPromptReference) {
			codeGenInstructionsCount += reference.usedInstructions.length;
			codeGenInstructionsLength += reference.usedInstructions.reduce((acc, instruction) => acc + instruction.length, 0);
			codeGenInstructionsFilteredCount += Math.max(reference.instructions.content.length - reference.usedInstructions.length, 0);
			if (reference.instructions.kind === CustomInstructionsKind.File) {
				codeGenInstructionFileCount++;
			} else {
				codeGenInstructionSettingsCount += reference.usedInstructions.length;
			}
		}
	}
	return { codeGenInstructionsCount, codeGenInstructionsLength, codeGenInstructionsFilteredCount, codeGenInstructionFileCount, codeGenInstructionSettingsCount };

}
