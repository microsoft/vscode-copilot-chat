/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptPiece, PromptSizing, RenderPromptResult, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { TextDocumentSnapshot } from '../../../../../platform/editing/common/textDocumentSnapshot';
import { IChatEndpoint } from '../../../../../platform/networking/common/networking';
import { ITabsAndEditorsService } from '../../../../../platform/tabs/common/tabsAndEditorsService';
import { KeywordItem } from '../../../../../platform/workspaceChunkSearch/common/workspaceChunkSearch';
import { IInstantiationService, ServicesAccessor } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatVariablesCollection } from '../../../../prompt/common/chatVariablesCollection';
import { Turn } from '../../../../prompt/common/conversation';
import { IBuildPromptContext } from '../../../../prompt/common/intents';
import { InstructionMessage } from '../../base/instructionMessage';
import { PromptRenderer } from '../../base/promptRenderer';
import { ChatVariablesAndQuery } from '../chatVariables';
import { HistoryWithInstructions } from '../conversationHistory';
import { DirectoryStructure, WorkspaceStructure } from './workspaceStructure';

export interface WorkspaceMetaPromptProps extends BasePromptElementProps {
	chatVariables: ChatVariablesCollection;

	history?: readonly Turn[];
	query: string;
	document?: TextDocumentSnapshot;
	selection?: vscode.Selection;
	scopedDirectories?: vscode.Uri[];
}

interface WorkspaceMetaState { }

export class WorkspaceMetaPrompt extends PromptElement<WorkspaceMetaPromptProps, WorkspaceMetaState> {

	override render(state: WorkspaceMetaState, sizing: PromptSizing): PromptPiece<any, any> | undefined {
		const { scopedDirectories } = this.props;
		return <>
			<SystemMessage priority={1000}>
				You are a coding assistant who help the user answer questions about code in their workspace by providing a list of relevant keywords they can search for to answer the question.<br />
				The user will provide you with potentially relevant information from the workspace. This information may be incomplete.<br />
			</SystemMessage>
			<HistoryWithInstructions historyPriority={500} passPriority history={this.props.history || []} sessionResource={undefined}>
				<InstructionMessage priority={1000}>
					Respond in Markdown. First under a `# Question` header, output a rephrased version of the user's question that resolves all pronouns and ambiguous words like 'this' to the specific nouns they stand for.<br />
					Then under a `# Keywords` header, output a short markdown list of up to 8 relevant keywords that the user can search for to answer the question. You may include variations after each keyword.<br />
					DO NOT ask the user for additional information or clarification.<br />
					DO NOT answer the user's question directly.<br />
					<br />
					# Additional Rules<br />
					<br />
					Think step by step:<br />
					1. Read the user's question to understand what they are asking about their workspace.<br />
					2. If the question contains pronouns such as 'it' or 'that', try to understand what the pronoun refers to by looking at the rest of the question and the conversation history.<br />
					3. If the question contains an ambiguous word such as 'this', try to understand what is refers to by looking at the rest of the question, the user's active selection, and the conversation history.<br />
					4. After a `# Question` header, output a precise version of question that resolves all pronouns and ambiguous words like 'this' to the specific nouns they stand for. Be sure to preserve the exact meaning of the question by only changing ambiguous pronouns and words like 'this'.<br />
					5. Then after a `# Keywords` header, output a short markdown list of up to 8 relevant keywords that user could try searching for to answer their question. These keywords could used as file name, symbol names, abbreviations, or comments in the relevant code. Put the keywords most relevant to the question first. Do not include overly generic keywords. Do not repeat keywords.<br />
					6. For each keyword in the markdown list of related keywords, if applicable add a comma separated list of variations after it. For example: for 'encode' possible variations include 'encoding', 'encoded', 'encoder', 'encoders'. Consider synonyms and plural forms. Do not repeat variations.<br />
					<br />
					Examples<br />
					<br />
					User: Where's the code for base64 encoding?<br />
					<br />
					Assistant:<br />
					# Question<br />
					Where's the code for base64 encoding?<br />
					<br />
					# Keywords<br />
					- base64 encoding, base64 encoder, base64 encode<br />
					- base64, base 64<br />
					- encode, encoded, encoder, encoders
				</InstructionMessage>
			</HistoryWithInstructions>

			<UserMessage priority={700}>
				{
					scopedDirectories ?
						scopedDirectories.map(dir => <DirectoryStructure maxSize={1000 / scopedDirectories.length} directory={dir} />) :
						<WorkspaceStructure maxSize={1000} />
				}
			</UserMessage>

			<ChatVariablesAndQuery flexGrow={2} priority={1000} chatVariables={this.props.chatVariables} query={this.props.query} embeddedInsideUserMessage={false} sessionResource={undefined} />
		</>;
	}
}

export async function buildWorkspaceMetaPrompt(accessor: ServicesAccessor, { query, history, chatVariables }: IBuildPromptContext, endpoint: IChatEndpoint, scopedDirectories?: vscode.Uri[]): Promise<RenderPromptResult> {
	const editor = accessor.get(ITabsAndEditorsService).activeTextEditor;
	const renderer = PromptRenderer.create(accessor.get(IInstantiationService), endpoint, WorkspaceMetaPrompt, {
		chatVariables,
		query,
		history,
		scopedDirectories,
		document: editor ? TextDocumentSnapshot.create(editor?.document) : undefined,
		selection: editor?.selection
	});

	return renderer.render();
}

const keywordLineRegexp = /^[\*\-]\s*(.+)/m;

export function parseMetaPromptResponse(originalQuestion: string, response: string): MetaPromptResponse {
	const match = response.match(/#+\s*Question\n(?<question>.+?)#+\s*Keywords\n(?<keywords>.+)/si);
	if (!match?.groups) {
		return { rephrasedQuestion: originalQuestion.trim(), keywords: [] };
	}

	const keywords: KeywordItem[] = [];
	for (const line of match.groups['keywords'].trim().split('\n')) {
		const match = line.match(keywordLineRegexp);
		if (match) {
			const terms = match[1].split(/,/g).map(x => x.trim());
			if (terms.length) {
				keywords.unshift({ keyword: terms[0], variations: terms.slice(1) });
			}
		}
	}

	return { rephrasedQuestion: match.groups['question'].trim(), keywords };
}

export interface MetaPromptResponse {
	readonly rephrasedQuestion: string;
	readonly keywords: KeywordItem[];
}
