/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it } from 'vitest';
import { PromptFileParser } from '../../../util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser';
import { URI } from '../../../util/vs/base/common/uri';
import { assert } from 'chai';

describe('Model array parsing order', () => {
	it('should preserve model array order - inline format', () => {
		const content = `---
model: [GPT-4.1, GPT-4o, Claude-3.5-Sonnet]
---
Test agent content`;

		const parser = new PromptFileParser();
		const parsed = parser.parse(URI.file('/test.agent.md'), content);

		const models = parsed.header?.model;
		assert.isDefined(models);
		assert.equal(models?.length, 3);
		assert.equal(models?.[0], 'GPT-4.1', 'First model should be GPT-4.1');
		assert.equal(models?.[1], 'GPT-4o', 'Second model should be GPT-4o');
		assert.equal(models?.[2], 'Claude-3.5-Sonnet', 'Third model should be Claude-3.5-Sonnet');
	});

	it('should preserve model array order - block format', () => {
		const content = `---
model:
  - GPT-4.1
  - GPT-4o
  - Claude-3.5-Sonnet
---
Test agent content`;

		const parser = new PromptFileParser();
		const parsed = parser.parse(URI.file('/test.agent.md'), content);

		const models = parsed.header?.model;
		assert.isDefined(models);
		assert.equal(models?.length, 3);
		assert.equal(models?.[0], 'GPT-4.1', 'First model should be GPT-4.1');
		assert.equal(models?.[1], 'GPT-4o', 'Second model should be GPT-4o');
		assert.equal(models?.[2], 'Claude-3.5-Sonnet', 'Third model should be Claude-3.5-Sonnet');
	});
});
