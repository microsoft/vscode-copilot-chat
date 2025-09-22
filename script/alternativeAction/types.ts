/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { LogEntry } from '../../src/platform/workspaceRecorder/common/workspaceLog';

export namespace NextUserEdit {
	export type t = {
		edit: [start: number, endEx: number, text: string][];
		relativePath: string;
		originalOpIdx: number;
	};
}

export namespace Recording {
	export type t = {
		log: LogEntry[];
		nextUserEdit: {
			edit: [start: number, endEx: number, text: string][];
			relativePath: string;
			originalOpIdx: number;
		};
	}
}

export namespace Scoring {
	export type t = {
		"$web-editor.format-json": true;
		"$web-editor.default-url": "https://microsoft.github.io/vscode-workbench-recorder-viewer/?editRating";
		edits: any[];
		scoringContext: {
			kind: 'recording';
			recording: Recording.t;
		};
	};

	export function create(recording: Recording.t): Scoring.t {
		return {
			"$web-editor.format-json": true,
			"$web-editor.default-url": "https://microsoft.github.io/vscode-workbench-recorder-viewer/?editRating",
			edits: [],
			scoringContext: {
				kind: 'recording',
				recording
			}
		};
	}
}

