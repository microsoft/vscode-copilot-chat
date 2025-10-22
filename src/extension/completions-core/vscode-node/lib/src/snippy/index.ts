/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Context } from '../context';
import type { IAbortSignal } from '../networking';
import { assertShape } from '../util/typebox';

import * as Network from './network';
import * as Schema from './snippy.proto';
import { CompletionsCapiBridge } from '../../../bridge/src/completionsCapiBridge';

export async function Match(ctx: Context, source: string, signal?: IAbortSignal) {
	const result = await Network.call<typeof Schema.MatchResponse>(
		ctx,
		ctx.get(CompletionsCapiBridge).capiClientService.snippyMatchPath,
		{
			method: 'POST',
			body: assertShape(Schema.MatchRequest, { source }),
		},
		signal
	);

	const payload = assertShape(Schema.MatchResponse, result);

	return payload;
}

export async function FilesForMatch(ctx: Context, { cursor }: Schema.FileMatchRequest, signal?: IAbortSignal) {
	const result = await Network.call<typeof Schema.FileMatchResponse>(
		ctx,
		ctx.get(CompletionsCapiBridge).capiClientService.snippyFilesForMatchPath,
		{
			method: 'POST',
			body: assertShape(Schema.FileMatchRequest, { cursor }),
		},
		signal
	);

	const payload = assertShape(Schema.FileMatchResponse, result);

	return payload;
}
