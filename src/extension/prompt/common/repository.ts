/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface RecentCommitMessages {
	readonly repository: string[];
	readonly user: string[];
}

export interface GitCommitRepoContext {
	readonly repositoryName?: string;
	readonly owner?: string;
	readonly headBranchName?: string;
	readonly defaultBranch?: string;
	readonly pullRequest?: { title: string; url: string };
}
