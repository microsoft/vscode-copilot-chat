/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface INesConfigs {
	isAsyncCompletions: boolean;
	isRevisedCacheStrategy: boolean;
	isCacheTracksRejections: boolean;
	isRecentlyShownCacheEnabled: boolean;
	debounceUseCoreRequestTime: boolean;
}
