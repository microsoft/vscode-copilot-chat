/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import { describe, it } from 'vitest';
import { IResponsePart } from '../../../../platform/chat/common/chatMLFetcher';

import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { Range, TextEdit } from '../../../../vscodeTypes';
import { OutcomeAnnotation } from '../../../inlineChat/node/promptCraftingTypes';
import { IResponseProcessorContext } from '../../../prompt/node/intents';
import { PatchEditFixReplyInterpreter } from '../inline/inlineChatFix3Prompt';
import { ProjectedDocument } from '../inline/summarizedDocument/summarizeDocument';

describe('Edit Ordering - Regression Tests for edits.reverse() fix', () => {

	// Mock classes for testing
	class MockLogger {
		trace() { }
		debug() { }
		info() { }
		warn() { }
		error() { }
		flush() { }
		show() { }
	}
	class MockLogService {
		_serviceBrand = undefined;
		logger = new MockLogger();
		showPublicLog = () => { };
		info() { }
		warn() { }
		error() { }
	}
	class MockPromptPathRepresentationService {
		_serviceBrand = undefined;
		getPromptPathRepresentation(uri: URI) { return uri.fsPath; }
		getFilePath(uri: URI) { return uri.fsPath; }
		resolveFilePath() { return URI.file(''); }
		getExampleFilePath() { return ''; }
	}
	class MockChatResponseStream {
		private _textEdits: { uri: URI; edits: TextEdit[] | boolean }[] = [];
		private _markdown: string[] = [];
		private _warnings: string[] = [];

		markdown(text: string): void { this._markdown.push(text); }
		progress(text: string): void { this._markdown.push(text); }
		warning(text: string): void { this._warnings.push(text); }
		textEdit(uri: URI, edits: TextEdit[] | boolean): void { this._textEdits.push({ uri, edits }); }
		codeblockUri(uri: URI): void { }
		getTextEdits(): TextEdit[] {
			const textEditEntry = this._textEdits.find(entry => Array.isArray(entry.edits));
			return textEditEntry ? textEditEntry.edits as TextEdit[] : [];
		}
		getWarnings(): string[] { return this._warnings; }
	}

	class MockResponseProcessorContext implements IResponseProcessorContext {
		private _annotations: OutcomeAnnotation[] = [];

		addAnnotations(annotations: OutcomeAnnotation[]): void { this._annotations.push(...annotations); }
		storeInInlineSession(): void { }
		get chatSessionId(): string { return 'test-session'; }
		get turn(): any { return null; }
		get messages(): any[] { return []; }
		getAnnotations(): OutcomeAnnotation[] { return this._annotations; }
	}

	function createMockInputStreamFromPatchResponse(response: string): AsyncIterable<IResponsePart> {
		const parts: IResponsePart[] = [
			{
				text: response,
				delta: { text: response }
			}
		];
		return {
			async *[Symbol.asyncIterator]() {
				for (const part of parts) {
					yield part;
				}
			}
		};
	}

	it('validates edits.reverse() fix for Python code multi-line edits, import change + code change', async () => {
		// Setup: Create a projected document
		const originalCode = `def process_data(items):
    results = []
    for item in items:
        if item > 0:
            results.append(item * 2)
    return results

def main():
    data = [1, 2, 3, 4, 5]
    processed = process_data(data)
    print(processed)`;

		const projectedDocument = new ProjectedDocument(originalCode, StringEdit.empty, 'python');
		const documentUri = URI.file('/test/file.py');
		const adjustedSelection = new Range(0, 0, 0, 0);

		// Create the interpreter with mocked dependencies
		const interpreter = new PatchEditFixReplyInterpreter(
			projectedDocument,
			documentUri,
			adjustedSelection,
			new MockLogService(),
			new MockPromptPathRepresentationService()
		);

		// Mock AI response that contains patches for imports and code changes
		let aiResponse = `I'll add the necessary imports and modify the print statement to use JSON formatting.

---FILEPATH
{documentUri}
---FIND
def process_data(items):
---REPLACE
import sys
import json
from typing import List

def process_data(items):
---FILEPATH
{documentUri}
---FIND
    processed = process_data(data)
    print(processed)
---REPLACE
    processed = process_data(data)
    print(json.dumps(processed))
    sys.exit(0)
---COMPLETE`;

		// Create input stream and output stream
		aiResponse = aiResponse.replace(/{documentUri}/g, documentUri.fsPath);
		const inputStream = createMockInputStreamFromPatchResponse(aiResponse);
		const outputStream = new MockChatResponseStream();
		const context = new MockResponseProcessorContext();

		// Process the response
		await interpreter.processResponse(context, inputStream, outputStream as any, CancellationToken.None);

		// Get the actual edits that were applied
		const edits = outputStream.getTextEdits();

		// The key test: verify that edits were applied in reverse order
		assert.ok(edits.length > 0, 'Should have edits');

		// Verify that the edits are in reverse order (end-to-beginning)
		// The import edit should come AFTER the code change edit in the array
		// because edits.reverse() was called
		if (edits.length >= 2) {
			// The first edit in the reversed array should be the one with the higher line number
			assert.ok(edits[0].range.start.line >= edits[1].range.start.line,
				'First edit should have line number >= second edit (reverse order)');
		}

		// Verify no warnings were generated (successful edit application)
		const warnings = outputStream.getWarnings();
		assert.ok(warnings.length === 0, `Should have no warnings, but got: ${warnings.join(', ')}`);

		// Verify no error annotations
		const annotations = context.getAnnotations();
		const errorAnnotations = annotations.filter(a => a.severity === 'error');
		assert.ok(errorAnnotations.length === 0,
			`Should have no error annotations, but got: ${errorAnnotations.map(a => a.message).join(', ')}`);
	});

});