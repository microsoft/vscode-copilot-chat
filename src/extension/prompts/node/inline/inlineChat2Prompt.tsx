/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AssistantMessage, PromptElement, PromptElementProps, PromptReference, PromptSizing, SystemMessage, ToolCall, ToolMessage, useKeepWith, UserMessage } from '@vscode/prompt-tsx';
import { ChatResponsePart } from '@vscode/prompt-tsx/dist/base/vscodeTypes';
import type { CancellationToken, ExtendedLanguageModelToolResult, Position, Progress } from 'vscode';
import { TextDocumentSnapshot } from '../../../../platform/editing/common/textDocumentSnapshot';
import { CacheType } from '../../../../platform/endpoint/common/endpointTypes';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { ChatRequest, ChatRequestEditorData, Range } from '../../../../vscodeTypes';
import { ChatVariablesCollection } from '../../../prompt/common/chatVariablesCollection';
import { IToolCall } from '../../../prompt/common/intents';
import { CopilotIdentityRules } from '../base/copilotIdentity';
import { SafetyRules } from '../base/safetyRules';
import { Tag } from '../base/tag';
import { ChatVariables, UserQuery } from '../panel/chatVariables';
import { CodeBlock } from '../panel/safeElements';
import { ToolResult } from '../panel/toolCalling';


export type InlineChat2PromptProps = PromptElementProps<{
	request: ChatRequest;
	snapshotAtRequest: TextDocumentSnapshot;
	data: ChatRequestEditorData;
	exitToolName: string;
	editAttempts: [IToolCall, ExtendedLanguageModelToolResult][];
}>;

export class InlineChat2Prompt extends PromptElement<InlineChat2PromptProps> {

	constructor(
		props: InlineChat2PromptProps,
		@IPromptPathRepresentationService private readonly _promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}


	override render(state: void, sizing: PromptSizing): Promise<any> {

		const snapshotAtRequest = this.props.snapshotAtRequest;

		const selection = this.props.data.selection;

		const variables = new ChatVariablesCollection(this.props.request.references);
		const filepath = this._promptPathRepresentationService.getFilePath(snapshotAtRequest.uri);

		// TODO@jrieken APPLY_PATCH_INSTRUCTIONS
		return (
			<>
				<SystemMessage priority={1000}>
					<CopilotIdentityRules />
					<SafetyRules />
					<Tag name='instructions'>
						You are an AI coding assistant that is used for quick, inline code changes. Changes are scoped to a single file or to some selected code in that file. You ONLY edit that file and use a tool to make these edits.<br />
						The user is interested in code changes grounded in the user's prompt. So, focus on replying with tool calls, avoid wordy explanations, and do not ask back for clarifications.<br />
						Do not make code changes that are not directly and logically related to the user's prompt, instead invoke the {this.props.exitToolName} tool which can handle this.<br />
					</Tag>
					<cacheBreakpoint type={CacheType} />
				</SystemMessage>
				<UserMessage>
					<>
						The filepath is `{filepath}` and this is its content:<br />
					</>
					<Tag name='file'>
						<CodeBlock includeFilepath={false} languageId={snapshotAtRequest.languageId} uri={snapshotAtRequest.uri} references={[new PromptReference(snapshotAtRequest.uri, undefined, undefined)]} code={snapshotAtRequest.getText()} />
					</Tag>
					{selection.isEmpty
						? <FileContextElement snapshot={snapshotAtRequest} position={selection.start} />
						: <FileSelectionElement snapshot={snapshotAtRequest} selection={selection} />
					}
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
				<EditAttemptsElement editAttempts={this.props.editAttempts} data={this.props.data} documentVersionAtRequest={this.props.snapshotAtRequest.version} />
			</>
		);
	}
}


export type FileContextElementProps = PromptElementProps<{
	snapshot: TextDocumentSnapshot;
	position: Position;
}>;

export class FileContextElement extends PromptElement<FileContextElementProps> {

	override render(state: void, sizing: PromptSizing, _progress?: Progress<ChatResponsePart>, _token?: CancellationToken) {

		let startLine = this.props.position.line;
		let endLine = this.props.position.line;
		let n = 0;
		let seenNonEmpty = false;
		while (startLine > 0) {
			seenNonEmpty = seenNonEmpty || !this.props.snapshot.lineAt(startLine).isEmptyOrWhitespace;
			startLine--;
			n++;
			if (n >= 3 && seenNonEmpty) {
				break;
			}
		}
		n = 0;
		seenNonEmpty = false;
		while (endLine < this.props.snapshot.lineCount - 1) {
			seenNonEmpty = seenNonEmpty || !this.props.snapshot.lineAt(endLine).isEmptyOrWhitespace;
			endLine++;
			n++;
			if (n >= 3 && seenNonEmpty) {
				break;
			}
		}

		const textBefore = this.props.snapshot.getText(new Range(this.props.position.with({ line: startLine, character: 0 }), this.props.position));
		const textAfter = this.props.snapshot.getText(new Range(this.props.position, this.props.position.with({ line: endLine, character: Number.MAX_SAFE_INTEGER })));

		const code = `${textBefore}$CURSOR$${textAfter}`;

		return <>
			<Tag name='file-cursor-context'>
				<CodeBlock includeFilepath={false} languageId={this.props.snapshot.languageId} uri={this.props.snapshot.uri} references={[new PromptReference(this.props.snapshot.uri, undefined, undefined)]} code={code} />
			</Tag>
		</>;
	}
}


export type FileSelectionElementProps = PromptElementProps<{
	snapshot: TextDocumentSnapshot;
	selection: Range;
}>;

export class FileSelectionElement extends PromptElement<FileSelectionElementProps> {

	override render(state: void, sizing: PromptSizing, progress?: Progress<ChatResponsePart>, token?: CancellationToken) {


		// the full lines of the selection
		// TODO@jrieken
		// * use the true selected text (now we extend to full lines)

		const selectedLines = this.props.snapshot.getText(this.props.selection.with({
			start: this.props.selection.start.with({ character: 0 }),
			end: this.props.selection.end.with({ character: Number.MAX_SAFE_INTEGER }),
		}));

		return <>
			<Tag name='file-selection'>
				<CodeBlock includeFilepath={false} languageId={this.props.snapshot.languageId} uri={this.props.snapshot.uri} references={[new PromptReference(this.props.snapshot.uri, undefined, undefined)]} code={selectedLines} />
			</Tag>
		</>;
	}
}


type EditAttemptsElementProps = PromptElementProps<{
	editAttempts: [IToolCall, ExtendedLanguageModelToolResult][];
	data: ChatRequestEditorData;
	documentVersionAtRequest: number;
}>;

class EditAttemptsElement extends PromptElement<EditAttemptsElementProps> {

	override render() {
		if (this.props.editAttempts.length === 0) {
			return;
		}

		const documentNow = this.props.data.document;

		const assistantToolCalls: Required<ToolCall>[] = [];
		const KeepWith = useKeepWith();

		for (const [toolCall] of this.props.editAttempts) {
			assistantToolCalls.push({
				type: 'function',
				id: toolCall.id,
				function: { name: toolCall.name, arguments: toolCall.arguments },
				keepWith: KeepWith
			});
		}

		return <>
			<AssistantMessage toolCalls={assistantToolCalls} />
			{this.props.editAttempts.map(([toolCall, result]) => {
				return (
					<KeepWith>
						<ToolMessage toolCallId={toolCall.id}>
							<ToolResult content={result.content} toolCallId={toolCall.id} />
						</ToolMessage>
					</KeepWith>
				);
			})}
			<UserMessage>
				{documentNow.version === this.props.documentVersionAtRequest && <>
					<Tag name='feedback'>
						Editing this file did not produce the desired result. No changes were made. Understand the previous edit attempts and the original file content, and <br />
						produce a better edit.<br />
					</Tag>
				</>}
				{documentNow.version !== this.props.documentVersionAtRequest && <>
					<Tag name='feedback'>
						Editing this file did not produce the desired result. Understand the previous edit attempts and the current file content, and <br />
						produce a better edit. This is the current file content:<br />
					</Tag>
					<Tag name='file'>
						<CodeBlock includeFilepath={false} languageId={documentNow.languageId} uri={documentNow.uri} references={[new PromptReference(documentNow.uri, undefined, undefined)]} code={documentNow.getText()} />
					</Tag>
				</>}
			</UserMessage>
		</>;
	}
}
