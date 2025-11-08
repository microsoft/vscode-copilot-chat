/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Diff, IGitDiffService } from './gitDiffService';

export class NullGitDiffService implements IGitDiffService {
	declare readonly _serviceBrand: undefined;

	async getChangeDiffs(): Promise<Diff[]> {
		return [];
	}

	async getWorkingTreeDiffsFromRef(): Promise<Diff[]> {
		return [];
	}
}
