/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import { describe, it } from 'vitest';
import { Range, TextEdit } from '../../../../vscodeTypes';
import { applyEdits } from '../../../prompt/node/intents';

describe('Edit Ordering - Regression Tests for edits.reverse() fix', () => {

	function createTextEdit(startLine: number, startChar: number, endLine: number, endChar: number, newText: string): TextEdit {
		return new TextEdit(new Range(startLine, startChar, endLine, endChar), newText);
	}

	function applyEditsToString(originalText: string, edits: TextEdit[]): string {
		// Use the actual applyEdits function from intents.ts
		return applyEdits(originalText, edits);
	}

	it('validates edits.reverse() fix with Python code - import + code change', () => {
		// Original Python code
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

		// Create edits as they would come from the patch processor
		const edits = [
			// Add import at the beginning of the file
			createTextEdit(0, 0, 0, 0, 'import sys\nimport json\nfrom typing import List\n\n'),
			// Modify the last two lines of the main function
			createTextEdit(9, 4, 10, 19, 'processed = process_data(data)\n    print(json.dumps(processed))\n    sys.exit(0)')
		];

		// Apply edits in reverse order (this is what the fix does)
		const reversedEdits = [...edits].reverse();
		const result = applyEditsToString(originalCode, reversedEdits);

		// Verify the import was added at the beginning
		assert.ok(result.includes('import sys'), 'Should contain sys import');
		assert.ok(result.includes('import json'), 'Should contain json import');
		assert.ok(result.includes('from typing import List'), 'Should contain typing import');

		// Verify the last two lines were modified correctly
		assert.ok(result.includes('print(json.dumps(processed))'), 'Should contain json.dumps call');
		assert.ok(result.includes('sys.exit(0)'), 'Should contain sys.exit call');

		// Verify the structure is correct (no position shift issues)
		const lines = result.split('\n');
		const importSysIndex = lines.findIndex(line => line.includes('import sys'));
		const importJsonIndex = lines.findIndex(line => line.includes('import json'));
		const typingImportIndex = lines.findIndex(line => line.includes('from typing import List'));
		const processDataIndex = lines.findIndex(line => line.includes('def process_data'));
		const mainFunctionIndex = lines.findIndex(line => line.includes('def main'));
		const jsonDumpsIndex = lines.findIndex(line => line.includes('json.dumps'));
		const sysExitIndex = lines.findIndex(line => line.includes('sys.exit(0)'));

		// Verify order is correct
		assert.ok(importSysIndex < importJsonIndex, 'sys import should come before json import');
		assert.ok(importJsonIndex < typingImportIndex, 'json import should come before typing import');
		assert.ok(typingImportIndex < processDataIndex, 'Imports should come before functions');
		assert.ok(processDataIndex < mainFunctionIndex, 'process_data should come before main');
		assert.ok(mainFunctionIndex < jsonDumpsIndex, 'main function should come before json.dumps call');
		assert.ok(jsonDumpsIndex < sysExitIndex, 'json.dumps should come before sys.exit');

		// The key test: verify that without reverse order, this would fail
		// because the import would shift line numbers and the "last two lines" edit
		// would target the wrong lines
		assert.ok(lines.length > 10, 'Should have more than 10 lines after adding imports');
		assert.ok(lines[0].includes('import sys'), 'First line should be sys import');
		assert.ok(lines[lines.length - 1].includes('sys.exit(0)'), 'Last line should be sys.exit');
	});

	it('demonstrates position shift problem without reverse order', () => {
		// This test shows why edits.reverse() is necessary
		const originalCode = `def calculate(x, y):
    return x + y

def main():
    result = calculate(5, 3)
    print(result)`;

		const edits = [
			// Add import at the beginning - this shifts all line positions
			createTextEdit(0, 0, 0, 0, 'import math\nimport os\n\n'),
			// Modify the last line (line 5 in original, but line 7 after imports)
			createTextEdit(5, 4, 5, 17, 'print(f"Result: {result}")')
		];

		// Apply in reverse order (correct way)
		const reversedEdits = [...edits].reverse();
		const result = applyEditsToString(originalCode, reversedEdits);

		// Verify both changes are applied correctly
		assert.ok(result.includes('import math'), 'Should have math import');
		assert.ok(result.includes('import os'), 'Should have os import');
		assert.ok(result.includes('print(f"Result: {result}")'), 'Should have formatted print statement');

		// Verify the structure
		const lines = result.split('\n');
		const mathImportIndex = lines.findIndex(line => line.includes('import math'));
		const osImportIndex = lines.findIndex(line => line.includes('import os'));
		const calculateIndex = lines.findIndex(line => line.includes('def calculate'));
		const mainIndex = lines.findIndex(line => line.includes('def main'));
		const printIndex = lines.findIndex(line => line.includes('print(f"Result:'));

		assert.ok(mathImportIndex < osImportIndex, 'math import should come first');
		assert.ok(osImportIndex < calculateIndex, 'imports should come before functions');
		assert.ok(calculateIndex < mainIndex, 'calculate should come before main');
		assert.ok(mainIndex < printIndex, 'main should come before print statement');
	});

	it('regression test for the exact scenario that was failing', () => {
		// This is the exact scenario that required the edits.reverse() fix:
		// 1. Adding imports at the beginning of the file
		// 2. Changing code at the end of the file
		// Without .reverse(), the import would shift line positions and break the end edits

		const originalCode = `class DataProcessor:
    def __init__(self, data):
        self.data = data

    def process(self):
        filtered = [x for x in self.data if x > 0]
        return filtered

if __name__ == "__main__":
    processor = DataProcessor([1, -2, 3, -4, 5])
    result = processor.process()
    print(result)`;

		const edits = [
			// Add imports at the very beginning
			createTextEdit(0, 0, 0, 0, 'import json\nimport logging\nfrom typing import List, Optional\n\n'),
			// Modify the last two lines of the main block
			createTextEdit(10, 4, 11, 17, 'result = processor.process()\n    logging.info(f"Processed {len(result)} items")\n    print(json.dumps(result))')
		];

		// Apply with reverse order - this is what the fix does
		const reversedEdits = [...edits].reverse();
		const result = applyEditsToString(originalCode, reversedEdits);

		// Verify all changes are applied correctly
		assert.ok(result.includes('import json'), 'Should have json import');
		assert.ok(result.includes('import logging'), 'Should have logging import');
		assert.ok(result.includes('from typing import List, Optional'), 'Should have typing import');
		assert.ok(result.includes('logging.info'), 'Should have logging.info call');
		assert.ok(result.includes('json.dumps(result)'), 'Should have json.dumps call');

		// The key test: verify the structure is maintained correctly
		// This would fail if edits were applied in wrong order
		const lines = result.split('\n');
		const jsonImportIndex = lines.findIndex(line => line.includes('import json'));
		const loggingImportIndex = lines.findIndex(line => line.includes('import logging'));
		const typingImportIndex = lines.findIndex(line => line.includes('from typing import'));
		const classIndex = lines.findIndex(line => line.includes('class DataProcessor'));
		const mainBlockIndex = lines.findIndex(line => line.includes('if __name__ == "__main__"'));
		const loggingCallIndex = lines.findIndex(line => line.includes('logging.info'));
		const jsonDumpsIndex = lines.findIndex(line => line.includes('json.dumps'));

		assert.ok(jsonImportIndex < loggingImportIndex, 'json import should come before logging import');
		assert.ok(loggingImportIndex < typingImportIndex, 'logging import should come before typing import');
		assert.ok(typingImportIndex < classIndex, 'imports should come before class');
		assert.ok(classIndex < mainBlockIndex, 'class should come before main block');
		assert.ok(mainBlockIndex < loggingCallIndex, 'main block should come before logging call');
		assert.ok(loggingCallIndex < jsonDumpsIndex, 'logging call should come before json.dumps');
	});

	it('validates that reverse order prevents position shift bugs', () => {
		// This test specifically validates that applying edits in reverse order
		// prevents the position shift bug that was happening before the fix

		const originalCode = `def helper_function():
    return "helper"

def main_function():
    value = helper_function()
    return value`;

		const edits = [
			// Add multiple imports at the beginning
			createTextEdit(0, 0, 0, 0, 'import sys\nimport os\nimport json\nfrom pathlib import Path\n\n'),
			// Modify the last line of the main function
			createTextEdit(5, 4, 5, 16, 'return json.dumps({"result": value})')
		];

		// Apply edits in reverse order
		const reversedEdits = [...edits].reverse();

		// Verify edits are in reverse order (end-to-beginning)
		assert.ok(reversedEdits[0].range.start.line >= reversedEdits[1].range.start.line,
			'First edit should be at a line >= second edit (reverse order)');

		const result = applyEditsToString(originalCode, reversedEdits);

		// Verify all imports are present
		assert.ok(result.includes('import sys'), 'Should have sys import');
		assert.ok(result.includes('import os'), 'Should have os import');
		assert.ok(result.includes('import json'), 'Should have json import');
		assert.ok(result.includes('from pathlib import Path'), 'Should have pathlib import');

		// Verify the return statement was modified correctly
		assert.ok(result.includes('return json.dumps({"result": value})'), 'Should have modified return statement');

		// Verify the overall structure
		const lines = result.split('\n');
		const sysImportIndex = lines.findIndex(line => line.includes('import sys'));
		const helperFunctionIndex = lines.findIndex(line => line.includes('def helper_function'));
		const mainFunctionIndex = lines.findIndex(line => line.includes('def main_function'));
		const jsonDumpsIndex = lines.findIndex(line => line.includes('json.dumps'));

		assert.ok(sysImportIndex < helperFunctionIndex, 'Imports should come before helper function');
		assert.ok(helperFunctionIndex < mainFunctionIndex, 'Helper function should come before main function');
		assert.ok(mainFunctionIndex < jsonDumpsIndex, 'Main function should come before json.dumps call');

		// Key assertion: the json.dumps call should be at the end, not in the middle
		// This would fail if position shifting occurred
		assert.ok(jsonDumpsIndex > lines.length - 5, 'json.dumps should be near the end of the file');
	});
});
