/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatResponseStream } from 'vscode';
import { MarkdownString } from '../../../vscodeTypes';
import { ResponseStreamParticipant } from '../../prompt/common/conversation';
import { IChatTipService } from '../common/chatTipService';

/**
 * Response stream participant that adds educational tips while chat is working.
 * Tips are shown as progress messages during response generation.
 */
export class ChatTipStreamParticipant {

	constructor(
		private readonly _tipService: IChatTipService
	) { }

	/**
	 * Create a response stream participant that shows tips during processing.
	 */
	createParticipant(): ResponseStreamParticipant {
		return (inStream: ChatResponseStream) => {
			const tip = this._tipService.getNextTip();
			
			if (!tip) {
				// No tip to show, just pass through
				return inStream;
			}

			// Show tip immediately as a progress message
			// This appears while Copilot is working on the response
			// Note: tips come from DEFAULT_TIPS (static trusted content), not user input
			const tipMarkdown = new MarkdownString(`$(lightbulb) **Tip:** ${tip}`);
			inStream.progress(tipMarkdown.value);

			// Return the original stream - tip has already been shown
			return inStream;
		};
	}
}
