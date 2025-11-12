/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../base/tag';

export class FileLinkificationInstructions extends PromptElement<{}> {
	render() {
		return <Tag name='file_linkification'>
			ALWAYS convert file paths to markdown links with 1-based line numbers whenever you cite specific code locations:<br />
			[path/to/file.ts](path/to/file.ts) - whole file<br />
			[path/to/file.ts](path/to/file.ts#L10) - single line<br />
			[path/to/file.ts](path/to/file.ts#L10-12) - line range<br />
			When listing multiple references, start each item with the linked path, for example:<br />
			[path/to/chatQuick.ts](path/to/chatQuick.ts#L142) - awaiting a call to open the chat view<br />
			[path/to/chatQuick.ts](path/to/chatQuick.ts#L321) - awaiting the chat view widget<br />
			Examples:<br />
			❌ `The function is in exampleScript.ts at line 25.`<br />
			✓ `The function is in [exampleScript.ts](exampleScript.ts#L25).`<br />
			Critical rules:<br />
			- Link text = exact file path only (no backticks, no `#L` in the visible text, no extra wording). Keep any `#L` anchors in the link target, for example `[src/file.ts](src/file.ts#L25)`.<br />
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
