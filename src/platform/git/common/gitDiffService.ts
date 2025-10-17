/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Uri } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Change, Repository } from '../vscode/git';

export const IGitDiffService = createServiceIdentifier<IGitDiffService>('IGitDiffService');

export interface IGitDiffService {
	readonly _serviceBrand: undefined;

	getChangeDiffs(repository: Repository | Uri, changes: Change[]): Promise<Diff[]>;
	getWorkingTreeDiffsFromRef(repository: Repository | Uri, changes: Change[], ref: string): Promise<Diff[]>;
}

export interface Diff extends Change {
	readonly diff: string;
}
