/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../lib/src/context';
import { collectCompletionDiagnostics, formatDiagnosticsAsMarkdown } from '../../lib/src/diagnostics';
import { telemetry, TelemetryData } from '../../lib/src/telemetry';
import { Command, commands, InlineCompletionItem, Uri } from 'vscode';
import { Disposable } from '../../../../../util/vs/base/common/lifecycle';
import { CMDSendCompletionsFeedback } from './constants';

export const sendCompletionFeedbackCommand: Command = {
	command: CMDSendCompletionsFeedback,
	title: 'Send Copilot Completion Feedback',
	tooltip: 'Send feedback about the last shown Copilot completion item',
};

export class CopilotCompletionFeedbackTracker extends Disposable {
	private lastShownCopilotCompletionItem: InlineCompletionItem | undefined;

	constructor(private readonly ctx: Context) {
		super();
		this._register(commands.registerCommand(sendCompletionFeedbackCommand.command, async () => {
			const commandArg: unknown = this.lastShownCopilotCompletionItem?.command?.arguments?.[0];
			let telemetryArg: TelemetryData | undefined;
			if (commandArg && typeof commandArg === 'object' && 'telemetry' in commandArg) {
				if (commandArg.telemetry instanceof TelemetryData) {
					telemetryArg = commandArg.telemetry;
				}
			}
			telemetry(this.ctx, 'ghostText.sentFeedback', telemetryArg);

			await openGitHubIssue(this.ctx, this.lastShownCopilotCompletionItem, telemetryArg);
		}));
	}

	trackItem(item: InlineCompletionItem) {
		this.lastShownCopilotCompletionItem = item;
	}
}

async function openGitHubIssue(
	ctx: Context,
	item: InlineCompletionItem | undefined,
	telemetry: TelemetryData | undefined
) {
	const body = generateGitHubIssueBody(ctx, item, telemetry);

	await commands.executeCommand('workbench.action.openIssueReporter', {
		extensionId: 'github.copilot',
		uri: Uri.parse('https://github.com/microsoft/vscode'),
		data: body,
	});
}

function generateGitHubIssueBody(
	ctx: Context,
	item: InlineCompletionItem | undefined,
	telemetry: TelemetryData | undefined
) {
	const diagnostics = collectCompletionDiagnostics(ctx, telemetry);
	const formattedDiagnostics = formatDiagnosticsAsMarkdown(diagnostics);
	if (typeof item?.insertText !== 'string') {
		return '';
	}

	return `## Copilot Completion Feedback
### Describe the issue, feedback, or steps to reproduce it:


### Completion text:
\`\`\`
${item.insertText}
\`\`\`

<details>
<summary>Diagnostics</summary>

${formattedDiagnostics}

</details>
`;
}
