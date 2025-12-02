/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';

export class EditorIntegrationRules extends PromptElement {
	render() {
		return (
			<>
				Use Markdown formatting in your answers.<br />
				Make sure to include the programming language name at the start of the Markdown code blocks.<br />
				Avoid wrapping the whole response in triple backticks.<br />
				<MathIntegrationRules />
				The user works in an IDE called Visual Studio Code which has a concept for editors with open files, integrated unit test support, an output pane that shows the output of running the code as well as an integrated terminal.<br />
				The active document is the source code the user is looking at right now.<br />
				You can only give one reply for each conversation turn.<br />
			</>
		);
	}
}

export class MathIntegrationRules extends PromptElement {

	constructor(
		props: BasePromptElementProps,
		@IConfigurationService private readonly configService: IConfigurationService
	) {
		super(props);
	}

	render() {
		const mathEnabled = this.configService.getNonExtensionConfig<boolean>('chat.math.enabled');
		if (mathEnabled) {
			return (
				<>
					Use KaTeX for math equations in your answers.<br />
					Wrap inline math equations in $.<br />
					Wrap more complex blocks of math equations in $$.<br />
				</>
			);
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Tag } from '../base/tag';

export class FileLinkificationInstructions extends PromptElement<{}> {
	render() {
		return <Tag name='fileLinkification'>
			When mentioning files or line numbers, always convert them to markdown links using workspace-relative paths and 1-based line numbers.<br />
			NO BACKTICKS ANYWHERE:<br />
			- Never wrap file names, paths, or links in backticks.<br />
			- Never use inline-code formatting for any file reference.<br />
			<br />

			REQUIRED FORMATS:<br />
			- File: [path/file.ts](path/file.ts)<br />
			- Line: [file.ts](file.ts#L10)<br />
			- Range: [file.ts](file.ts#L10-L12)<br />
			<br />

			PATH RULES:<br />
			- Without line numbers: Display text must match the target path.<br />
			- With line numbers: Display text can be either the path or descriptive text.<br />
			- Use '/' only; strip drive letters and external folders.<br />
			- Do not use these URI schemes: file://, vscode://<br />
			- Encode spaces only in the target (My File.md → My%20File.md).<br />
			- Non-contiguous lines require separate links. NEVER use comma-separated line references like #L10-L12, L20.<br />
			- Valid formats: [file.ts](file.ts#L10) or [file.ts#L10] only. Invalid: ([file.ts#L10]) or [file.ts](file.ts)#L10<br />
			<br />

			USAGE EXAMPLES:<br />
			- With path as display: The handler is in [src/handler.ts](src/handler.ts#L10).<br />
			- With descriptive text: The [widget initialization](src/widget.ts#L321) runs on startup.<br />
			- Bullet list: [Init widget](src/widget.ts#L321)<br />
			- File only: See [src/config.ts](src/config.ts) for settings.<br />
			<br />

			FORBIDDEN (NEVER OUTPUT):<br />
			- Inline code: `file.ts`, `src/file.ts`, `L86`.<br />
			- Plain text file names: file.ts, chatService.ts.<br />
			- References without links when mentioning specific file locations.<br />
			- Specific line citations without links ("Line 86", "at line 86", "on line 25").<br />
			- Combining multiple line references in one link: [file.ts#L10-L12, L20](file.ts#L10-L12, L20)<br />
			<br />
		</Tag>;
	}
}
