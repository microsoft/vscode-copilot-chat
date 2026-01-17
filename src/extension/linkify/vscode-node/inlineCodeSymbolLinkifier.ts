/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { collapseRangeToStart } from '../../../util/common/range';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { SymbolInformation } from '../../../vscodeTypes';
import { LinkifiedPart, LinkifiedText, LinkifySymbolAnchor } from '../common/linkifiedText';
import { IContributedLinkifier, LinkifierContext } from '../common/linkifyService';
import { resolveSymbolFromReferences } from './commands';
import { ReferencesSymbolResolver } from './findWord';

export const inlineCodeRegexp = /(?<!\[)`([^`\n]+)`(?!\])/g;

// Common escape sequences that should not be linkified as symbols
// Matches: \r, \n, \t, \b, \f, \v, \0, \', \", \\, or \r\n
const ESCAPE_SEQUENCE_REGEX = /^\\[rntbfv0'"\\]$|^\\r\\n$/;

const maxPotentialWordMatches = 8;

/**
 * Linkifies symbol names that appear as inline code.
 */
export class InlineCodeSymbolLinkifier implements IContributedLinkifier {
	private readonly resolver: ReferencesSymbolResolver;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this.resolver = instantiationService.createInstance(ReferencesSymbolResolver, { symbolMatchesOnly: true, maxResultCount: maxPotentialWordMatches });
	}

	async linkify(text: string, context: LinkifierContext, token: CancellationToken): Promise<LinkifiedText | undefined> {
		if (!context.references.length || vscode.version.startsWith('1.94')) {
			return;
		}

		const out: LinkifiedPart[] = [];

		let endLastMatch = 0;
		for (const match of text.matchAll(inlineCodeRegexp)) {
			const prefix = text.slice(endLastMatch, match.index);
			if (prefix) {
				out.push(prefix);
			}

			const symbolText = match[1];

			const loc = await this.tryResolveSymbol(symbolText, context, token);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			if (loc?.length) {
				const info: SymbolInformation = {
					name: symbolText,
					containerName: '',
					kind: vscode.SymbolKind.Variable,
					location: loc[0]
				};

				out.push(new LinkifySymbolAnchor(info, async (token) => {
					const dest = await resolveSymbolFromReferences(loc.map(loc => ({ uri: loc.uri, pos: loc.range.start })), symbolText, token);
					if (dest) {
						const selectionRange = dest.loc.targetSelectionRange ?? dest.loc.targetRange;
						info.location = new vscode.Location(dest.loc.targetUri, collapseRangeToStart(selectionRange));

						// TODO: Figure out how to get the actual symbol kind here and update it
					}

					return info;
				}));
			} else {
				out.push(match[0]);
			}

			endLastMatch = match.index + match[0].length;
		}

		const suffix = text.slice(endLastMatch);
		if (suffix) {
			out.push(suffix);
		}

		return { parts: out };
	}

	private async tryResolveSymbol(symbolText: string, context: LinkifierContext, token: CancellationToken): Promise<vscode.Location[] | undefined> {
		if (/^https?:\/\//i.test(symbolText)) {
			return;
		}

		// Don't linkify common escape sequences
		if (ESCAPE_SEQUENCE_REGEX.test(symbolText)) {
			return;
		}

		return this.resolver.resolve(symbolText, context.references, token);
	}
}
