/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UserInputRequestedEvent } from '@github/copilot/sdk';
import type { CancellationToken, ChatParticipantToolToken } from 'vscode';
import { createServiceIdentifier } from '../../../../util/common/services';

export type UserInputRequest = Omit<UserInputRequestedEvent['data'], 'requestId'>;

export type UserInputResponse = { answer: string; wasFreeform: boolean };

export const IUserQuestionHandler = createServiceIdentifier<IUserQuestionHandler>('IUserQuestionHandler');

export interface IUserQuestionHandler {
	_serviceBrand: undefined;
	askUserQuestion(question: UserInputRequest, toolInvocationToken: ChatParticipantToolToken, token: CancellationToken): Promise<UserInputResponse | undefined>;
}
