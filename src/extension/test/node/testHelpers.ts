/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatPromptReference, ChatRequest } from 'vscode';
import * as vscodeTypes from '../../../vscodeTypes';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { MarkdownString } from '../../../util/vs/base/common/htmlContent';
import { URI } from '../../../util/vs/base/common/uri';

export class TestChatRequest implements ChatRequest {
	public command: string | undefined;
	public references: readonly ChatPromptReference[];
	public location: vscodeTypes.ChatLocation;
	public location2 = undefined;
	public attempt: number;
	public enableCommandDetection: boolean;
	public isParticipantDetected: boolean;
	public toolReferences = [];
	public toolInvocationToken: never = undefined as never;
	public model = null!;
	public tools = new Map();
	public id = generateUuid();

	constructor(
		public prompt: string
	) {
		this.references = [];
		this.location = vscodeTypes.ChatLocation.Panel;
		this.attempt = 0;
		this.enableCommandDetection = false;
		this.isParticipantDetected = false;
	}
}

export class MockChatResponseStream extends ChatResponseStreamImpl {

	public output: string[] = [];
	public uris: string[] = [];

	constructor() {
		super(() => { }, () => { });
	}
	override markdown(content: string | MarkdownString): void {
		this.output.push(typeof content === 'string' ? content : content.value);
	}
	override codeblockUri(uri: URI): void {
		this.uris.push(uri.toString());
	}
}