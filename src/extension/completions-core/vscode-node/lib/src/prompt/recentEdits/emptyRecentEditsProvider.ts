/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RecentEditsProvider } from './recentEditsProvider';
import { RecentEdit } from './recentEditsReducer';

export class EmptyRecentEditsProvider extends RecentEditsProvider {
	override isEnabled(): boolean {
		return false;
	}

	override start(): void {
		return;
	}

	override getRecentEdits(): RecentEdit[] {
		return [];
	}

	override getEditSummary(edit: RecentEdit): string | null {
		return null;
	}
}
