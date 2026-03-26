/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { PromptFileParser } from '../../../util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser';
import { IWorkspaceService } from '../../workspace/common/workspaceService';
import { IPromptsService, ParsedPromptFile } from './promptsService';

export class PromptsServiceImpl implements IPromptsService {
	declare _serviceBrand: undefined;
	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService
	) { }

	public async parseFile(uri: URI, token: CancellationToken): Promise<ParsedPromptFile> {
		const doc = await raceCancellationError(this.workspaceService.openTextDocument(uri), token);
		return new PromptFileParser().parse(uri, doc.getText());
	}
}