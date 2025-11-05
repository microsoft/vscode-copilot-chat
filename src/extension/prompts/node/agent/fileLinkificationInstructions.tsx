/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../base/tag';

export class FileLinkificationInstructions extends PromptElement<{}> {
	render() {
		return <Tag name='file_linkification'>
			ALWAYS convert file paths to markdown links. Use workspace-relative POSIX paths with 1-based line numbers:<br />
			`[path/to/file.ts](path/to/file.ts)` - whole file<br />
			`[path/to/file.ts](path/to/file.ts#L10)` - single line<br />
			`[path/to/file.ts](path/to/file.ts#L10-12)` - line range (inclusive)<br />
			Examples:<br />
			❌ `The function is in exampleScript.ts at line 25.`<br />
			✓ `The function is in [exampleScript.ts](exampleScript.ts#L25).`<br />
			❌ `See src/utils/math.ts lines 40-44`<br />
			✓ `See [src/utils/math.ts](src/utils/math.ts#L40-44)`<br />
			❌ `Config in docs/My File.md`<br />
			✓ `Config in [docs/My File.md](docs/My%20File.md)`<br />
			Critical rules:<br />
			- Bracket text = file path only (no `#L...`). Wrong: `[file.ts#L10](...)`; Correct: `[file.ts](...#L10)`<br />
			- Only cite existing paths from context; don't invent paths<br />
			- Immediately fold any cited line(s)/range into the anchor (not separate prose)<br />
			- Use ranges (`#L10-12`) for 2+ consecutive lines; single line form otherwise<br />
			- Percent-encode spaces in link target only: `[My File.md](My%20File.md)` (leave bracket text unencoded)<br />
			- Backticks only for plain non-linked paths; never wrap the markdown link itself in backticks<br />
			- No bare filenames left unlinked (exception: verbatim user input you will transform next)<br />
			- If uncertain about exact lines, link whole file (no anchor) and gather more context before adding anchors<br />
			- Missed conversion? Correct it in your very next message<br />
			Goal: High link coverage; fallback rarely triggers.<br />
		</Tag>;
	}
}
