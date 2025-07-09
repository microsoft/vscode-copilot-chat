/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export enum ParticipantIds {
	Ask = 'github.copilot.default',
	Agent = 'github.copilot.editsAgent',
	Edit = 'github.copilot.editingSession',
	Edit2 = 'github.copilot.editingSession2',
}

export function participantIdToName(participantId: string): string {
	switch (participantId) {
		case ParticipantIds.Ask:
			return 'ask';
		case ParticipantIds.Agent:
			return 'agent';
		case ParticipantIds.Edit:
		case ParticipantIds.Edit2:
			return 'edit';
		default:
			return participantId;
	}
}