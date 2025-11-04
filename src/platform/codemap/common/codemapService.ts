/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { TextDocumentSnapshot } from '../../editing/common/textDocumentSnapshot';

export const ICodemapService = createServiceIdentifier<ICodemapService>('ICodemapService');

/**
 * Represents a structural element in the code (class, function, etc.)
 */
export interface CodemapNode {
	readonly type: string;
	readonly name?: string;
	readonly range?: { start: number; end: number };
	readonly children?: CodemapNode[];
}

/**
 * Represents a structured map of the code showing its high-level organization
 */
export interface Codemap {
	readonly structure: CodemapNode | undefined;
	readonly summary: string;
}

/**
 * Service for generating codemaps of documents to provide structural context
 */
export interface ICodemapService {
	readonly _serviceBrand: undefined;

	/**
	 * Generate a codemap for the given document
	 * @param document The document to generate a codemap for
	 * @param token Cancellation token
	 * @returns A codemap containing the document structure
	 */
	getCodemap(document: TextDocumentSnapshot, token: CancellationToken): Promise<Codemap | undefined>;
}
