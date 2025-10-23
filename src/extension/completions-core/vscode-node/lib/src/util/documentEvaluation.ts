/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotContentExclusionManager } from '../contentExclusion/contentExclusionManager';
import { Context } from '../context';
import { TextDocumentIdentifier } from '../textDocument';

/**
 * Evaluate document uri to see if it's valid for copilot to process
 */
export async function isDocumentValid(
	ctx: Context,
	document: TextDocumentIdentifier,
	text: string
): Promise<{ status: 'valid' } | { status: 'invalid'; reason: string }> {
	const rcmResult = await ctx.get(CopilotContentExclusionManager).evaluate(document.uri, text);
	if (rcmResult.isBlocked) {
		return {
			status: 'invalid',
			reason: 'Document is blocked by repository policy',
		};
	}

	return { status: 'valid' };
}
