/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptElementProps, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { TextDocumentSnapshot } from '../../../../platform/editing/common/textDocumentSnapshot';
import { ChatRequest, ChatRequestEditorData } from '../../../../vscodeTypes';
import { ChatVariablesCollection } from '../../../prompt/common/chatVariablesCollection';
import { ITextDocumentWorkingSetEntry, IWorkingSet, WorkingSetEntryState } from '../../../prompt/common/intents';
import { CopilotIdentityRules } from '../base/copilotIdentity';
import { SafetyRules } from '../base/safetyRules';
import { Tag } from '../base/tag';
import { ChatVariables, UserQuery } from '../panel/chatVariables';
import { WorkingSet } from '../panel/editCodePrompt';


export type InlineChat2PromptProps = PromptElementProps<{
	request: ChatRequest;
	data: ChatRequestEditorData;
}>;

export class InlineChat2Prompt extends PromptElement<InlineChat2PromptProps> {


	override render(state: void, sizing: PromptSizing): Promise<any> {

		const workingSet: IWorkingSet = [{
			document: TextDocumentSnapshot.create(this.props.data.document),
			isMarkedReadonly: false,
			state: WorkingSetEntryState.Initial,
			range: this.props.data.selection
		} satisfies ITextDocumentWorkingSetEntry];

		return (
			<>
				<SystemMessage priority={1000}>
					<CopilotIdentityRules />
					<SafetyRules />
					<Tag name='instructions'>
						You are an AI coding assistant that is used for quick, inline code changes. Changes are scoped to a single file or to some selected code. There is a tool to make these code changes.<br />
						The user is interested in code changes grounded in the user's prompt. So, focus on replying with tool calls, avoid wordy explanations, and do not ask back for clarifications.<br />
						Do not make code changes that are not directly and logically related to the user's prompt, instead reply with a simple message.<br />
						{/* TODO@jrieken APPLY_PATCH_INSTRUCTIONS */}
					</Tag>
				</SystemMessage>
				<UserMessage>
					<WorkingSet flexGrow={1} priority={950} workingSet={workingSet} />
					<InlineChatUserMessage flexGrow={2} priority={900} {...this.props} />
				</UserMessage>
			</>
		);
	}
}


interface InlineChatUserMessageProps extends PromptElementProps<InlineChat2PromptProps> { }

class InlineChatUserMessage extends PromptElement<InlineChatUserMessageProps> {

	override render(state: void, sizing: PromptSizing) {

		const { prompt, references } = this.props.request;
		const variables = new ChatVariablesCollection(references);

		return (
			<>
				<ChatVariables flexGrow={3} priority={898} chatVariables={variables} />
				<Tag name='reminder'>
					<InlineChatReminder />
				</Tag>
				<Tag name='prompt'>
					<UserQuery flexGrow={7} priority={900} chatVariables={variables} query={prompt} />
				</Tag>

			</>
		);
	}
}


type InlineChatReminderProps = PromptElementProps<{}>;

class InlineChatReminder extends PromptElement<InlineChatReminderProps> {

	async render(state: void, sizing: PromptSizing) {

		return (
			<>
				If there is a user selection, focus on it, and try to make changes to the selected code and its context.<br />
				If there is no user selection, make changes or write new code anywhere in the file.<br />
				Do not make code changes that are not directly and logically related to the user's prompt.
			</>
		);
	}
}
