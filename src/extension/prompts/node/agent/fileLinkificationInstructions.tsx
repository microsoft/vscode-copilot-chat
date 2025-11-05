/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../base/tag';

export class FileLinkificationInstructions extends PromptElement<{}> {
	render() {
		return <Tag name='file_linkification'>
			ALWAYS convert any filename or path mention into a markdown link using one of these canonical forms (1-based line numbers):<br />
			`[path/to/file.ts](path/to/file.ts)` whole file<br />
			`[path/to/file.ts](path/to/file.ts#L10)` single line<br />
			`[path/to/file.ts](path/to/file.ts#L10-12)` inclusive line range<br />
			Transformation examples (apply this rewriting proactively):<br />
			Bad: `The main function is in exampleScript.ts at line 25.`<br />
			Good: `The main function is in [exampleScript.ts](exampleScript.ts#L25).`<br />
			Bad: `See src/utils/math.ts lines 40-44 for the loop.`<br />
			Good: `See [src/utils/math.ts](src/utils/math.ts#L40-44) for the loop.`<br />
			Bad: `Config lives in docs/My File.md`<br />
			Good: `Config lives in [docs/My File.md](docs/My%20File.md)`<br />
			Rules (enforced):<br />
			- Bracket text MUST exactly equal the file path portion before any `#` anchor (omit line hash from text).<br />
			- Use workspace-relative POSIX paths (forward slashes). Do NOT invent paths; only cite existing ones or ones already shown in context. If uncertain about directory, prefer reading context before guessing.<br />
			- If you state a line or range in prose, IMMEDIATELY integrate it into the link anchor instead of leaving it separate.<br />
			- Only add an anchor when certain; if unsure about exact lines, emit the whole-file link (no anchor) and optionally gather more context before citing lines.<br />
			- For multiple disjoint ranges from one file, emit separate links (one per range).<br />
			- Do NOT wrap these links themselves in backticks; they are plain markdown links (the code fences/backticks rule applies only to ordinary inline path references, not these links).<br />
			- Percent-encode spaces ONLY in the target; bracket text remains unencoded (e.g. `[docs/My File.md](docs/My%20File.md)`).<br />
			- Prefer citing a range (`#L10-12`) if you reference ≥2 consecutive lines; otherwise single line anchor (`#L10`).<br />
			- Never leave a bare filename like `exampleScript.ts` in prose without converting it to a link unless you are explicitly quoting user input you will transform next.<br />
			Self-correction: If you output a filename without the required link format, immediately correct yourself in the very next message by restating it with the proper link.<br />
			Goal: Maximize model-emitted links so fallback legacy linkifier rarely triggers.<br />
		</Tag>;
	}
}
