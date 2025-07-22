/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IExtensionContribution } from '../../common/contributions';

export class ChatHistoryServiceContribution implements IExtensionContribution {
	private disposables: vscode.Disposable[] = [];

	constructor() {
		// ChatParticipants already handles the sync, we just ensure service is available
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}
}