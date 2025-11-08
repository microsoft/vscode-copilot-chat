/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { IAbortSignal } from '../networking';
import { assertShape } from '../util/typebox';

import { CompletionsCapiBridge } from '../../../bridge/src/completionsCapiBridge';
import * as Network from './network';
import * as Schema from './snippy.proto';
import { ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { ICompletionsContextService } from '../context';

export async function Match(accessor: ServicesAccessor, source: string, signal?: IAbortSignal) {
	const result = await Network.call<typeof Schema.MatchResponse>(
		accessor,
		accessor.get(ICompletionsContextService).get(CompletionsCapiBridge).capiClientService.snippyMatchPath,
		{
			method: 'POST',
			body: assertShape(Schema.MatchRequest, { source }),
		},
		signal
	);

	const payload = assertShape(Schema.MatchResponse, result);

	return payload;
}

export async function FilesForMatch(accessor: ServicesAccessor, { cursor }: Schema.FileMatchRequest, signal?: IAbortSignal) {
	const result = await Network.call<typeof Schema.FileMatchResponse>(
		accessor,
		accessor.get(ICompletionsContextService).get(CompletionsCapiBridge).capiClientService.snippyFilesForMatchPath,
		{
			method: 'POST',
			body: assertShape(Schema.FileMatchRequest, { cursor }),
		},
		signal
	);

	const payload = assertShape(Schema.FileMatchResponse, result);

	return payload;
}
