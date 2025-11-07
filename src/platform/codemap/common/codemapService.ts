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
 * Language-specific metadata for enhanced suggestions
 */
export interface LanguageMetadata {
	/** React hooks used (useState, useEffect, etc.) */
	reactHooks?: string[];
	/** Is this an async function/method? */
	isAsync?: boolean;
	/** Does this return JSX? */
	returnsJSX?: boolean;
	/** Decorators (Python/TypeScript) */
	decorators?: string[];
}

/**
 * Structured representation of code organization for LLM consumption
 */
export interface StructuredCodemap {
	readonly classes: Array<{
		name: string;
		range: { start: number; end: number };
		methods: Array<{ name: string; line: number; metadata?: LanguageMetadata }>;
		properties: Array<{ name: string; line: number }>;
	}>;
	readonly functions: Array<{ name: string; line: number; metadata?: LanguageMetadata }>;
	readonly interfaces: Array<{ name: string; range: { start: number; end: number } }>;
	/** Language-specific patterns detected */
	readonly patterns?: {
		/** Total React hooks found in file */
		reactHooksCount?: number;
		/** Async functions/methods count */
		asyncFunctionsCount?: number;
		/** JSX/TSX components count */
		componentsCount?: number;
	};
}

/**
 * Represents a structured map of the code showing its high-level organization
 */
export interface Codemap {
	readonly structure: CodemapNode | undefined;
	readonly summary: string;
	/** Structured data optimized for LLM consumption */
	readonly structured?: StructuredCodemap;
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

	/**
	 * Get the code segment for a specific structural element by name
	 * @param document The document
	 * @param elementName The name of the element (e.g., "handleClick", "UserService")
	 * @param codemap Pre-computed codemap (optional)
	 * @returns The code text and line range for that element
	 */
	getElementCode(document: TextDocumentSnapshot, elementName: string, codemap?: Codemap): Promise<{ code: string; lineRange: { start: number; end: number } } | undefined>;
}
