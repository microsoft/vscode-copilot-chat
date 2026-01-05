/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { LogEntry } from '../../../../../platform/workspaceRecorder/common/workspaceLog';
import { filterLogForSensitiveFiles } from '../inlineEditDebugComponent';

suite('filter recording for sensitive files', () => {
	test('should filter out settings.json files', () => {
		const log: LogEntry[] = [
			{
				documentType: 'workspaceRecording@1.0',
				kind: 'header',
				repoRootUri: 'file:///path/to/repo',
				time: 1733253792609,
				uuid: '233d78f2-202a-4d3e-9b90-0f1acc058125'
			},
			{
				kind: 'documentEncountered',
				id: 1,
				relativePath: 'package.json',
				time: 1733253735332
			},
			{
				kind: 'documentEncountered',
				id: 2,
				relativePath: '.vscode/settings.json',
				time: 1733253735340
			},
			{
				kind: 'setContent',
				id: 1,
				v: 1,
				content: '{ "name": "example" }',
				time: 1733253735332
			},
			{
				kind: 'setContent',
				id: 2,
				v: 1,
				content: '{ "sensitive": "data" }',
				time: 1733253735340
			}
		];

		const result = filterLogForSensitiveFiles(log);

		expect(result).toMatchInlineSnapshot(`
			[
			  {
			    "documentType": "workspaceRecording@1.0",
			    "kind": "header",
			    "repoRootUri": "file:///path/to/repo",
			    "time": 1733253792609,
			    "uuid": "233d78f2-202a-4d3e-9b90-0f1acc058125",
			  },
			  {
			    "id": 1,
			    "kind": "documentEncountered",
			    "relativePath": "package.json",
			    "time": 1733253735332,
			  },
			  {
			    "content": "{ "name": "example" }",
			    "id": 1,
			    "kind": "setContent",
			    "time": 1733253735332,
			    "v": 1,
			  },
			]
		`);
	});

});
