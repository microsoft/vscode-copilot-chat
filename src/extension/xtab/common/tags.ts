/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export namespace PromptTags {
	export const CURSOR = "<|cursor|>";

	type Tag = {
		start: string;
		end: string;
	};

	function createTag(key: string): Tag {
		return {
			start: `<|${key}|>`,
			end: `<|/${key}|>`
		};
	}

	export const EDIT_WINDOW = createTag("code_to_edit");

	export const AREA_AROUND = createTag("area_around_code_to_edit");

	export const CURRENT_FILE = createTag("current_file_content");

	export const EDIT_HISTORY = createTag("edit_diff_history");

	export const RECENT_FILES = createTag("recently_viewed_code_snippets");

	export const RECENT_FILE = createTag("recently_viewed_code_snippet");
}

