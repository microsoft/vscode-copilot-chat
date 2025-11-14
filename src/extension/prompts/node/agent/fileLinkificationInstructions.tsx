/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../base/tag';

export class FileLinkificationInstructions extends PromptElement<{}> {
	render() {
		return <Tag name='file_linkification'>
			ALWAYS convert file paths to markdown links with 1-based line numbers whenever you cite specific code locations. Use links inside normal sentences, not as the entire answer.<br />
			Format examples:<br />
			- `The handler lives in [path/to/file.ts](path/to/file.ts#L10).` (single line)<br />
			- `See [path/to/file.ts](path/to/file.ts#L10-L12) for the range.`<br />
			- `Configuration is defined in [path/to/file.ts](path/to/file.ts).` (whole file)<br />
			- `The widget renderer attaches anchors ([src/renderer.ts](src/renderer.ts#L42-L48)).` (in parentheses)<br />
			When you need a bullet list of references with line numbers, you can use descriptive text:<br />
			- [Await chat view](path/to/chatQuick.ts#L142)<br />
			- [Show widget](path/to/chatQuick.ts#L321)<br />
			NEVER cite file paths as plain text when referring to specific locations. For example, instead of saying `The function is in exampleScript.ts at line 25.`, say `The function is in [exampleScript.ts](exampleScript.ts#L25).`<br />
			Critical rules:<br />
			- Link text must be the exact file path (no backticks, no `#L` in the visible text, no extra wording). Keep the `#L` anchor in the **link target**, e.g. `[src/file.ts](src/file.ts#L25)`.<br />
			- Always include both brackets **and** parentheses. `[src/file.ts](src/file.ts#L25)` is valid; `[src/file.ts#L25]` is not.<br />
			- Path format: Strip drive letters and workspace parent folders - use only path after workspace root<br />
			- Transform `c:\Repos\workspace\src\file.ts` → `[src/file.ts](src/file.ts)`<br />
			- Always use forward slashes `/`, never backslashes `\`<br />
			- Do not use URIs like file://, vscode://, or https://.<br />
			- Percent-encode spaces in target only: `[My File.md](My%20File.md)`<br />
			- Each file reference needs complete path (don't abbreviate repeated files)<br />
			- Integrate line numbers into anchor: `#L10` or `#L10-L12` for ranges<br />
			- Don't wrap links in backticks; only cite existing paths from context<br />
		</Tag>;
	}
}
