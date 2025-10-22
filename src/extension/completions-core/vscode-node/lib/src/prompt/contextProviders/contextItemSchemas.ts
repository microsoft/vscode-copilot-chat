/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../context';
import { logger } from '../../logger';
import { ResolvedContextItem } from '../contextProviderRegistry';
import {
	CodeSnippet,
	SupportedContextItem,
	SupportedContextItemType,
	Trait,
} from '../../../../types/src';
import { Type } from '@sinclair/typebox';
import { TypeCheck, TypeCompiler } from '@sinclair/typebox/compiler';
import { generateUuid } from '../../../../../../../util/vs/base/common/uuid';

/**
 * Redefine all the types from contextProviderV1 as typebox schema and verify equality.
 * None of these types should be exported, they are only used for type checking.
 */
const _ContextItemSchema = Type.Object({
	importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
	id: Type.Optional(Type.String()),
	origin: Type.Optional(Type.Union([Type.Literal('request'), Type.Literal('update')])),
});
const _TraitSchema = Type.Intersect([
	Type.Object({
		name: Type.String(),
		value: Type.String(),
	}),
	_ContextItemSchema,
]);
const _CodeSnippetSchema = Type.Intersect([
	Type.Object({
		uri: Type.String(),
		value: Type.String(),
		additionalUris: Type.Optional(Type.Array(Type.String())),
	}),
	_ContextItemSchema,
]);
const _SupportedContextItemSchema = [_TraitSchema, _CodeSnippetSchema];
const _SupportedContextItemSchemaUnion = Type.Union(_SupportedContextItemSchema);
type _SupportedContextItemSchemas =
	| (typeof _SupportedContextItemSchema)[number]
	| typeof _SupportedContextItemSchemaUnion;

const supportedContextItemValidators = new Map<SupportedContextItemType, TypeCheck<_SupportedContextItemSchemas>>([
	['Trait', TypeCompiler.Compile(_TraitSchema)],
	['CodeSnippet', TypeCompiler.Compile(_CodeSnippetSchema)],
]);

/**
 *
 * Internal types and validation functions for context items
 */

/**
 * Construct the final types, which may include required properties that the base types do not have.
 */

export type TraitWithId = Trait & { id: string; type: 'Trait' };
export type CodeSnippetWithId = CodeSnippet & { id: string; type: 'CodeSnippet' };
export type SupportedContextItemWithId = TraitWithId | CodeSnippetWithId;

export function filterContextItemsByType<S extends SupportedContextItemType>(
	resolvedContextItems: ResolvedContextItem[],
	type: S
): ResolvedContextItem<Extract<SupportedContextItemWithId, { type: S }>>[] {
	return resolvedContextItems
		.map(item => {
			const filteredData = item.data.filter(data => data.type === type) as Extract<
				SupportedContextItemWithId,
				{ type: S }
			>[];

			return filteredData.length > 0 ? { ...item, data: filteredData } : undefined;
		})
		.filter(r => r !== undefined) as ResolvedContextItem<Extract<SupportedContextItemWithId, { type: S }>>[];
}

type SupportedContextItemWithType = SupportedContextItem & { type: SupportedContextItemType };

export function filterSupportedContextItems(
	contextItems: SupportedContextItem[]
): [SupportedContextItemWithType[], number] {
	const filteredItems: SupportedContextItemWithType[] = [];
	let invalidItemsCounter = 0;

	contextItems.forEach(item => {
		let matched = false;
		for (const [type, validator] of supportedContextItemValidators.entries()) {
			if (validator.Check(item)) {
				filteredItems.push({
					...item,
					type,
				});
				matched = true;
				break;
			}
		}

		if (!matched) {
			invalidItemsCounter++;
		}
	});

	return [filteredItems, invalidItemsCounter];
}

/**
 *
 * Only allow alphanumeric characters and hyphens to remove symbols that could
 * be problematic when used as prompt components keys.
 */
function validateContextItemId(id: string): boolean {
	return id.length > 0 && id.replaceAll(/[^a-zA-Z0-9-]/g, '').length === id.length;
}

/**
 * Assigns a random ID if it wasn't assigned by the context provider.
 * Invalid or duplicate IDs are replaced with valid ones and logged to avoid dropping the context
 * and worsen the user experience.
 */
export function addOrValidateContextItemsIDs(
	ctx: Context,
	contextItems: SupportedContextItemWithType[]
): SupportedContextItemWithId[] {
	const seenIds = new Set<string>();

	const contextItemsWithId: SupportedContextItemWithId[] = [];
	for (const item of contextItems) {
		let id = item.id ?? generateUuid();
		if (!validateContextItemId(id)) {
			const newID = generateUuid();
			logger.error(ctx, `Invalid context item ID ${id}, replacing with ${newID}`);
			id = newID;
		}
		if (seenIds.has(id)) {
			const newID = generateUuid();
			logger.error(ctx, `Duplicate context item ID ${id}, replacing with ${newID}`);
			id = newID;
		}
		seenIds.add(id);
		contextItemsWithId.push({ ...item, id } as SupportedContextItemWithId);
	}
	return contextItemsWithId;
}
