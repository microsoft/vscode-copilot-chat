/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, describe, expect, test } from 'vitest';
import { CHAT_MODEL } from '../../../../platform/configuration/common/configurationService';
import { JsonSchema } from '../../../../platform/configuration/common/jsonSchema';
import { OpenAiFunctionTool } from '../../../../platform/networking/common/fetch';
import { normalizeToolSchema } from '../../common/toolSchemaNormalizer';

describe('ToolSchemaNormalizer', () => {
	const makeTool = (properties: Record<string, JsonSchema>): OpenAiFunctionTool[] => [{
		type: 'function',
		function: {
			name: 'test',
			description: 'test',
			parameters: {
				type: 'object',
				properties,
			}
		}
	}];

	test('throws an invalid primitive types', () => {
		assert.throws(() => normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			foo: {
				type: 'text',
				description: 'foo',
			}
		})), Error, /do not match JSON schema/);
	});

	test('fails on array without item specs', () => {
		assert.throws(() => normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			foo: {
				type: 'array',
			}
		})), Error, /array type must have items/);
	});

	test('trims extra properties', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			foo: {
				type: 'array',
				items: { type: 'string' },
				minItems: 2,
				maxItems: 2,
			}
		}));

		expect(schema![0].function.parameters).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "foo": {
			      "items": {
			        "type": "string",
			      },
			      "type": "array",
			    },
			  },
			  "type": "object",
			}
		`);
	});

	test('does not fail on "in true""', () => {
		normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			foo: {
				type: 'array',
				items: true
			}
		}));
	});

	test('removes undefined required properties', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			foo1: {
				type: 'object',
			},
			foo2: {
				type: 'object',
				properties: { a: { type: 'string' } },
			},
			foo3: {
				type: 'object',
				properties: { a: { type: 'string' }, b: { type: 'string' } },
				required: ['a', 'b', 'c'],
			}
		}));


		expect(schema![0].function.parameters).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "foo1": {
			      "type": "object",
			    },
			    "foo2": {
			      "properties": {
			        "a": {
			          "type": "string",
			        },
			      },
			      "type": "object",
			    },
			    "foo3": {
			      "properties": {
			        "a": {
			          "type": "string",
			        },
			        "b": {
			          "type": "string",
			        },
			      },
			      "required": [
			        "a",
			        "b",
			      ],
			      "type": "object",
			    },
			  },
			  "type": "object",
			}
		`);
	});


	test('ensures object parameters', () => {
		const n1: any = normalizeToolSchema(CHAT_MODEL.GPT41, [{
			type: 'function',
			function: {
				name: 'noParams',
				description: 'test',
			}
		}, {
			type: 'function',
			function: {
				name: 'wrongType',
				description: 'test',
				parameters: { type: 'string' },
			}
		}, {
			type: 'function',
			function: {
				name: 'missingProps',
				description: 'test',
				parameters: { type: 'object' },
			}
		}]);

		expect(n1).toMatchInlineSnapshot(`
			[
			  {
			    "function": {
			      "description": "test",
			      "name": "noParams",
			    },
			    "type": "function",
			  },
			  {
			    "function": {
			      "description": "test",
			      "name": "wrongType",
			      "parameters": {
			        "properties": {},
			        "type": "object",
			      },
			    },
			    "type": "function",
			  },
			  {
			    "function": {
			      "description": "test",
			      "name": "missingProps",
			      "parameters": {
			        "properties": {},
			        "type": "object",
			      },
			    },
			    "type": "function",
			  },
			]
		`);
	});

	test('normalizes arrays for draft 2020-12', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.CLAUDE_37_SONNET, makeTool({
			foo: {
				type: 'array',
				items: [{ type: 'string' }, { type: 'number' }],
				minItems: 2,
				maxItems: 2,
			},
			bar: {
				type: 'array',
				items: { type: 'string' },
				minItems: 2,
				maxItems: 2,
			}
		}));

		expect(schema![0]).toMatchInlineSnapshot(`
			{
			  "function": {
			    "description": "test",
			    "name": "test",
			    "parameters": {
			      "properties": {
			        "bar": {
			          "items": {
			            "type": "string",
			          },
			          "maxItems": 2,
			          "minItems": 2,
			          "type": "array",
			        },
			        "foo": {
			          "items": {
			            "anyOf": [
			              {
			                "type": "string",
			              },
			              {
			                "type": "number",
			              },
			            ],
			          },
			          "maxItems": 2,
			          "minItems": 2,
			          "type": "array",
			        },
			      },
			      "type": "object",
			    },
			  },
			  "type": "function",
			}
		`);
	});

	test('converts nullable types to OpenAPI format for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_FLASH, makeTool({
			nullableString: {
				type: ['string', 'null'] as any,
				description: 'A nullable string',
			},
			nullableNumber: {
				type: ['number', 'null'] as any,
				description: 'A nullable number',
			},
			regularString: {
				type: 'string',
				description: 'A regular string',
			}
		}));

		expect(schema![0].function.parameters).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "nullableNumber": {
			      "description": "A nullable number",
			      "nullable": true,
			      "type": "number",
			    },
			    "nullableString": {
			      "description": "A nullable string",
			      "nullable": true,
			      "type": "string",
			    },
			    "regularString": {
			      "description": "A regular string",
			      "type": "string",
			    },
			  },
			  "type": "object",
			}
		`);
	});

	test('converts nullable types in nested objects for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_25_PRO, makeTool({
			person: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
					},
					email: {
						type: ['string', 'null'] as any,
						description: 'Optional email',
					},
					age: {
						type: ['integer', 'null'] as any,
					}
				}
			}
		}));

		const personProp = (schema![0].function.parameters as any).properties.person;
		expect(personProp.properties.email).toEqual({
			type: 'string',
			nullable: true,
			description: 'Optional email',
		});
		expect(personProp.properties.age).toEqual({
			type: 'integer',
			nullable: true,
		});
		expect(personProp.properties.name).toEqual({
			type: 'string',
		});
	});

	test('converts nullable types in array items for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_20_PRO, makeTool({
			items: {
				type: 'array',
				items: {
					type: ['string', 'null'] as any,
					description: 'Nullable array items',
				}
			}
		}));

		const itemsProp = (schema![0].function.parameters as any).properties.items;
		expect(itemsProp.items).toEqual({
			type: 'string',
			nullable: true,
			description: 'Nullable array items',
		});
	});

	test('does not convert nullable types for non-Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			nullableString: {
				type: ['string', 'null'] as any,
				description: 'A nullable string',
			}
		}));

		// For non-Gemini models, the type array should remain unchanged
		expect((schema![0].function.parameters as any).properties.nullableString.type).toEqual(['string', 'null']);
		expect((schema![0].function.parameters as any).properties.nullableString.nullable).toBeUndefined();
	});

	test('handles multi-type union with null for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_FLASH, makeTool({
			multiType: {
				type: ['string', 'number', 'null'] as any,
				description: 'Multi-type with null',
			}
		}));

		// When there are multiple non-null types, we can't use nullable keyword
		// so we just remove null from the union
		expect((schema![0].function.parameters as any).properties.multiType.type).toEqual(['string', 'number']);
		expect((schema![0].function.parameters as any).properties.multiType.nullable).toBeUndefined();
	});

	test('strips unsupported schema keywords for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_FLASH, makeTool({
			field1: {
				type: 'string',
				description: 'A field',
				default: 'hello',
				title: 'Field 1',
				minLength: 1,
				maxLength: 100,
				pattern: '^[a-z]+$',
			} as any,
			field2: {
				type: 'object',
				properties: {
					nested: {
						type: 'number',
						minimum: 0,
						maximum: 100,
						exclusiveMinimum: 0,
						exclusiveMaximum: 100,
					} as any
				},
				additionalProperties: false,
			} as any,
		}));

		const props = (schema![0].function.parameters as any).properties;
		// Should keep supported keywords
		expect(props.field1.type).toBe('string');
		expect(props.field1.description).toBe('A field');
		// Should strip unsupported keywords
		expect(props.field1.default).toBeUndefined();
		expect(props.field1.title).toBeUndefined();
		expect(props.field1.minLength).toBeUndefined();
		expect(props.field1.maxLength).toBeUndefined();
		expect(props.field1.pattern).toBeUndefined();

		expect(props.field2.type).toBe('object');
		expect(props.field2.properties).toBeDefined();
		expect(props.field2.additionalProperties).toBeUndefined();

		// Nested properties should also be stripped
		expect(props.field2.properties.nested.type).toBe('number');
		expect(props.field2.properties.nested.minimum).toBeUndefined();
		expect(props.field2.properties.nested.maximum).toBeUndefined();
		expect(props.field2.properties.nested.exclusiveMinimum).toBeUndefined();
		expect(props.field2.properties.nested.exclusiveMaximum).toBeUndefined();
	});

	test('strips $schema, $defs, and $ref keywords for Gemini models', () => {
		const tools: any[] = [{
			type: 'function',
			function: {
				name: 'test',
				description: 'test',
				parameters: {
					type: 'object',
					$schema: 'https://json-schema.org/draft/2020-12/schema',
					$defs: { foo: { type: 'string' } },
					properties: {
						name: {
							type: 'string',
							$comment: 'some comment',
						}
					},
				}
			}
		}];

		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_FLASH, tools);
		const params = schema![0].function.parameters as any;
		expect(params.$schema).toBeUndefined();
		expect(params.$defs).toBeUndefined();
		expect(params.type).toBe('object');
		expect(params.properties.name.type).toBe('string');
		expect(params.properties.name.$comment).toBeUndefined();
	});

	test('does not strip Gemini-unsupported keywords for non-Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.CLAUDE_37_SONNET, makeTool({
			field: {
				type: 'string',
				description: 'A field',
				title: 'Field Title',
			} as any,
		}));

		// For non-Gemini models, title should be preserved
		expect((schema![0].function.parameters as any).properties.field.title).toBe('Field Title');
	});

	test('handles Directus-like MCP schema with mixed unsupported keywords for Gemini', () => {
		const tools: any[] = [{
			type: 'function',
			function: {
				name: 'create_item',
				description: 'Create a new item in Directus',
				parameters: {
					type: 'object',
					$schema: 'https://json-schema.org/draft/2020-12/schema',
					properties: {
						collection: {
							type: 'string',
							description: 'Collection name',
							title: 'Collection',
						},
						data: {
							type: 'object',
							description: 'Item data',
							additionalProperties: true,
							properties: {
								field1: {
									type: 'string',
									default: '',
									minLength: 0,
								},
								field2: {
									type: ['number', 'null'] as any,
									minimum: 0,
								}
							},
						},
					},
					required: ['collection', 'data'],
				}
			}
		}];

		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_FLASH, tools);
		const params = schema![0].function.parameters as any;

		// Top-level unsupported keywords stripped
		expect(params.$schema).toBeUndefined();
		expect(params.type).toBe('object');
		expect(params.required).toEqual(['collection', 'data']);

		// Property-level unsupported keywords stripped
		expect(params.properties.collection.title).toBeUndefined();
		expect(params.properties.collection.type).toBe('string');
		expect(params.properties.collection.description).toBe('Collection name');

		expect(params.properties.data.additionalProperties).toBeUndefined();
		expect(params.properties.data.properties.field1.default).toBeUndefined();
		expect(params.properties.data.properties.field1.minLength).toBeUndefined();

		// Nullable conversion should also work alongside keyword stripping
		expect(params.properties.data.properties.field2.type).toBe('number');
		expect(params.properties.data.properties.field2.nullable).toBe(true);
		expect(params.properties.data.properties.field2.minimum).toBeUndefined();
	});
});
