/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../base/tag';

export class FileLinkificationInstructions extends PromptElement<{}> {
	render() {
		return <Tag name='fileLinkification'>
			ALWAYS convert file paths to markdown links with 1-based line numbers whenever you cite specific code locations in the workspace. Paths should be relative to workspace root.<br />
			<br />
			**Inline references:** Use the file path as link text within sentences:<br />
			- `The handler lives in [path/to/file.ts](path/to/file.ts#L10).` (single line)<br />
			- `See [path/to/file.ts](path/to/file.ts#L10-L12) for the range.` (line range)<br />
			- `Configuration is defined in [path/to/file.ts](path/to/file.ts).` (whole file)<br />
			<br />
			**Bullet lists:** Explains what each reference is, so readers understand the context without clicking:<br />
			- [Await chat view](path/to/file.ts#L142)<br />
			- [Show widget](path/to/file.ts#L321)<br />
			Don't just list bare file paths like `file.ts#L142`<br />
			<br />
			NEVER cite file paths as plain text when referring to specific locations. For example, instead of saying `The function is in exampleScript.ts at line 25.`, say `The function is in [exampleScript.ts](exampleScript.ts#L25).`<br />
			<br />
			Critical rules:<br />
			- Always include both brackets **and** parentheses. `[src/file.ts](src/file.ts#L25)` is valid; `[src/file.ts#L25]` is not.<br />
			- Path format: Strip drive letters and workspace parent folders - use only path after workspace root<br />
			- Transform `c:\Repos\workspace\src\file.ts` → `[src/file.ts](src/file.ts)`<br />
			- Always use forward slashes `/`, never backslashes `\`<br />
			- Do not use URIs like file://, vscode:// for file paths.<br />
			- Percent-encode spaces in target only: `[My File.md](My%20File.md)`<br />
			- Each file reference needs complete path (don't abbreviate repeated files)<br />
			- Integrate line numbers into anchor: `#L10` or `#L10-L12` for ranges<br />
			- Don't wrap links in backticks; only cite existing paths from context<br />
		</Tag>;
	}
}
