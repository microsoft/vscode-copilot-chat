/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export {
	registerAddFileReferenceCommand,
	ADD_FILE_REFERENCE_COMMAND,
} from './addFileReference';

export {
	ADD_FILE_REFERENCE_NOTIFICATION,
	FileReferenceInfo,
	sendToSession,
	sendEditorContextToSession,
	sendUriToSession,
} from './sendContext';

export {
	registerAddSelectionCommand,
	ADD_SELECTION_COMMAND,
} from './addSelection';

export {
	registerDiffCommands,
	ACCEPT_DIFF_COMMAND,
	REJECT_DIFF_COMMAND,
} from './diffCommands';
