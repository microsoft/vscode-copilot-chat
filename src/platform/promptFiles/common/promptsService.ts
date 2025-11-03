/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { ParsedPromptFile } from '../../../util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser';

export * from '../../../util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser';

export const IPromptsService = createServiceIdentifier<IPromptsService>('IPromptsService');

/**
 * A service that provides prompt file related functionalities: agents, instructions and prompt files.
 */
export interface IPromptsService {
	/**
	 * Reads and parses the provided URI
	 * @param uris
	 */
	parseFile(uri: URI, token: CancellationToken): Promise<ParsedPromptFile>;

}
