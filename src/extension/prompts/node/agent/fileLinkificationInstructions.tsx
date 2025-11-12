/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../base/tag';

export class FileLinkificationInstructions extends PromptElement<{}> {
	render() {
		return <Tag name='file_linkification'>
			ALWAYS convert file paths to markdown links with 1-based line numbers:<br />
			`[path/to/file.ts](path/to/file.ts)` - whole file<br />
			`[path/to/file.ts](path/to/file.ts#L10)` - single line<br />
			`[path/to/file.ts](path/to/file.ts#L10-12)` - line range<br />
			Examples:<br />
			❌ `The function is in exampleScript.ts at line 25.`<br />
			✓ `The function is in [exampleScript.ts](exampleScript.ts#L25).`<br />
			Critical rules:<br />
			- Bracket text = exact file path only (no backticks, no `#L...`, no descriptive text like "line 549")<br />
			- Path format: Strip drive letters and workspace parent folders - use only path after workspace root<br />
			- Transform `c:\Repos\workspace\src\file.ts` → `[src/file.ts](src/file.ts)`<br />
			- Always use forward slashes `/`, never backslashes `\`<br />
			- Do not use URIs like file://, vscode://, or https://.<br />
			- Percent-encode spaces in target only: `[My File.md](My%20File.md)`<br />
			- Each file reference needs complete path (don't abbreviate repeated files)<br />
			- Integrate line numbers into anchor: `#L10` or `#L10-12` for ranges<br />
			- Don't wrap links in backticks; only cite existing paths from context<br />
		</Tag>;
	}
}
