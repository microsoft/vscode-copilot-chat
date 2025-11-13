/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptElementProps, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { TextDocumentSnapshot } from '../../../../platform/editing/common/textDocumentSnapshot';
import { CacheType } from '../../../../platform/endpoint/common/endpointTypes';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
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
	exitToolName: string;
}>;

export class InlineChat2Prompt extends PromptElement<InlineChat2PromptProps> {

	constructor(
		props: InlineChat2PromptProps,
		@IPromptPathRepresentationService private readonly _promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}


	override render(state: void, sizing: PromptSizing): Promise<any> {

		const workingSet: IWorkingSet = [{
			document: TextDocumentSnapshot.create(this.props.data.document),
			isMarkedReadonly: false,
			state: WorkingSetEntryState.Initial,
			range: this.props.data.selection
		} satisfies ITextDocumentWorkingSetEntry];

		const variables = new ChatVariablesCollection(this.props.request.references);
		const filepath = this._promptPathRepresentationService.getFilePath(this.props.data.document.uri);

		// TODO@jrieken: if the selection is empty and if the line with the selection is empty we could hint to add code and
		// generally with empty selections we could allow the model to be a bit more creative

		// TODO@jrieken APPLY_PATCH_INSTRUCTIONS
		return (
			<>
				<SystemMessage priority={1000}>
					<CopilotIdentityRules />
					<SafetyRules />
					<Tag name='instructions'>
						You are an AI coding assistant that is used for quick, inline code changes. Changes are scoped to a single file or to some selected code in that file. The filepath is `{filepath}` and that is the ONLY file you are editing. There is a tool to make these code changes.<br />
						The user is interested in code changes grounded in the user's prompt. So, focus on replying with tool calls, avoid wordy explanations, and do not ask back for clarifications.<br />
						Do not make code changes that are not directly and logically related to the user's prompt, instead invoke the {this.props.exitToolName} tool which can handle this.<br />
					</Tag>
					<cacheBreakpoint type={CacheType} />
				</SystemMessage>
				<UserMessage>
					<WorkingSet flexGrow={1} priority={950} workingSet={workingSet} />
					<ChatVariables flexGrow={3} priority={898} chatVariables={variables} useFixCookbook={true} />
					<Tag name='reminder'>
						If there is a user selection, focus on it, and try to make changes to the selected code and its context.<br />
						If there is no user selection, make changes or write new code anywhere in the file.<br />
						Do not make code changes that are not directly and logically related to the user's prompt.<br />
						ONLY change the `{filepath}` file and NO other file.
					</Tag>
					<cacheBreakpoint type={CacheType} />
				</UserMessage>
				<UserMessage>
					<Tag name='prompt'>
						<UserQuery flexGrow={7} priority={900} chatVariables={variables} query={this.props.request.prompt} />
					</Tag>
					<cacheBreakpoint type={CacheType} />
				</UserMessage>
			</>
		);
	}
}
