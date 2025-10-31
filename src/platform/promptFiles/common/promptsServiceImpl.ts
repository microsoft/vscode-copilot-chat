/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { URI } from '../../../util/vs/base/common/uri';
import { PromptFileParser } from '../../../util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser';
import { IFileSystemService } from '../../filesystem/common/fileSystemService';
import { IPromptsService, ParsedPromptFile } from './promptsService';

export class PromptsServiceImpl implements IPromptsService {

	constructor(
		@IFileSystemService private readonly fileService: IFileSystemService
	) { }

	public async parseFile(uri: URI, token: CancellationToken): Promise<ParsedPromptFile> {
		const fileContent = await this.fileService.readFile(uri);
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		const text = new TextDecoder().decode(fileContent);
		return new PromptFileParser().parse(uri, text);
	}
}