/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatRequest } from '../../../vscodeTypes';
import * as l10n from '@vscode/l10n';

export interface IToolCallIterationIncrease {
	copilotRequestedRoundLimit: number;
}

const isToolCallIterationIncrease = (c: any): c is IToolCallIterationIncrease => c && typeof c.copilotRequestedRoundLimit === 'number';

export const getRequestedToolCallIterationLimit = (request: ChatRequest) => request.acceptedConfirmationData?.find(isToolCallIterationIncrease)?.copilotRequestedRoundLimit;

// todo@connor4312 improve with the choices API
export const cancelText = () => l10n.t('Pause');
export const isToolCallLimitCancellation = (request: ChatRequest) => !!getRequestedToolCallIterationLimit(request) && request.prompt.includes(cancelText());
export const isToolCallLimitAcceptance = (request: ChatRequest) => !!getRequestedToolCallIterationLimit(request) && !isToolCallLimitCancellation(request);
export interface IContinueOnErrorConfirmation {
	copilotContinueOnError: true;
}

function isContinueOnErrorConfirmation(c: unknown): c is IContinueOnErrorConfirmation {
	return !!(c && (c as IContinueOnErrorConfirmation).copilotContinueOnError === true);
}
export const isContinueOnError = (request: ChatRequest) => !!(request.acceptedConfirmationData?.some(isContinueOnErrorConfirmation));