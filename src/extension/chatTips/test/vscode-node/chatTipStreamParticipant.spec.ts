/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponseStream } from 'vscode';
import { ChatResponseStreamImpl } from '../../../../util/common/chatResponseStreamImpl';
import { ChatResponseMarkdownPart } from '../../../../vscodeTypes';
import { IChatTipService } from '../../common/chatTipService';
import { ChatTipService } from '../../vscode-node/chatTipServiceImpl';
import { ChatTipStreamParticipant } from '../../vscode-node/chatTipStreamParticipant';

describe('ChatTipStreamParticipant', () => {
	let tipService: IChatTipService;
	let participant: ChatTipStreamParticipant;

	beforeEach(() => {
		tipService = new ChatTipService();
		participant = new ChatTipStreamParticipant(tipService);
	});

	describe('createParticipant', () => {
		it('should show a tip when wrapping a stream', () => {
			const progressMessages: string[] = [];
			
			// Create a mock stream that captures progress messages
			const mockStream: ChatResponseStream = {
				progress: (message: string) => {
					progressMessages.push(message);
				},
				markdown: vi.fn(),
				anchor: vi.fn(),
				button: vi.fn(),
				filetree: vi.fn(),
				push: vi.fn(),
				reference: vi.fn(),
				codeCitation: vi.fn(),
				externalEdit: vi.fn(),
			} as any;

			const streamParticipant = participant.createParticipant();
			streamParticipant(mockStream);

			// Verify that a progress message was shown
			expect(progressMessages.length).toBe(1);
			expect(progressMessages[0]).toContain('Tip:');
			expect(progressMessages[0]).toContain('$(lightbulb)');
		});

		it('should not show a tip when tips are disabled', () => {
			const progressMessages: string[] = [];
			
			// Create a tip service that returns no tips
			const mockTipService: IChatTipService = {
				_serviceBrand: undefined,
				getNextTip: () => undefined,
				shouldShowTips: () => false,
			};

			const customParticipant = new ChatTipStreamParticipant(mockTipService);

			const mockStream: ChatResponseStream = {
				progress: (message: string) => {
					progressMessages.push(message);
				},
				markdown: vi.fn(),
				anchor: vi.fn(),
				button: vi.fn(),
				filetree: vi.fn(),
				push: vi.fn(),
				reference: vi.fn(),
				codeCitation: vi.fn(),
				externalEdit: vi.fn(),
			} as any;

			const streamParticipant = customParticipant.createParticipant();
			streamParticipant(mockStream);

			// Verify that no progress message was shown
			expect(progressMessages.length).toBe(0);
		});

		it('should pass through stream correctly', () => {
			const parts: any[] = [];
			
			const mockStream = new ChatResponseStreamImpl(
				(part) => parts.push(part),
				() => {},
			);

			const streamParticipant = participant.createParticipant();
			const wrappedStream = streamParticipant(mockStream);

			// Use the wrapped stream
			wrappedStream.markdown('Test message');

			// Verify that content flows through
			// First part should be the progress (tip), second should be the markdown
			expect(parts.length).toBeGreaterThanOrEqual(2);
			expect(parts[parts.length - 1]).toBeInstanceOf(ChatResponseMarkdownPart);
			expect((parts[parts.length - 1] as ChatResponseMarkdownPart).value.value).toBe('Test message');
		});
	});
});
