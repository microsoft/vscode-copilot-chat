/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions } from '@github/copilot/sdk';
import type { CancellationToken, ChatParticipantToolToken, ChatResponseStream } from 'vscode';
import { createServiceIdentifier } from '../../../../util/common/services';

export type UserInputRequest = Parameters<NonNullable<SessionOptions['requestUserInput']>>[0];

export type UserInputResponse = ReturnType<NonNullable<SessionOptions['requestUserInput']>>;

export const IUserQuestionHandler = createServiceIdentifier<IUserQuestionHandler>('IUserQuestionHandler');

export interface IUserQuestionHandler {
	_serviceBrand: undefined;
	askUserQuestion(question: UserInputRequest, stream: ChatResponseStream, toolInvocationToken: ChatParticipantToolToken, token: CancellationToken): Promise<UserInputResponse | undefined>;
}
