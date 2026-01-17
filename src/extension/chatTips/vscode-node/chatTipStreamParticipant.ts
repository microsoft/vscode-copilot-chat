/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatResponseStream } from 'vscode';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
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

			// Create a wrapped stream that shows the tip as progress
			let tipShown = false;

			return ChatResponseStreamImpl.spy(
				inStream,
				(part) => {
					// Show tip once when we start receiving content
					// This ensures the tip appears while Copilot is working
					if (!tipShown) {
						tipShown = true;
						// Show tip as a progress message with a lightbulb icon
						const tipMarkdown = new MarkdownString(`$(lightbulb) **Tip:** ${tip}`);
						inStream.progress(tipMarkdown.value);
					}
				}
			);
		};
	}
}
