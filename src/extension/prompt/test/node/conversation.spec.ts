/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ChatResult } from 'vscode';
import { ChatVariablesCollection } from '../../common/chatVariablesCollection';
import { IResultMetadata, normalizeSummariesOnRounds, TokenUsageMetadata, Turn, TurnMessage, TurnStatus } from '../../common/conversation';
import { ToolCallRound } from '../../common/toolCallRound';

describe('Turn', () => {
	describe('setResponse', () => {
		it('should set the response message and status correctly', () => {
			const request: TurnMessage = { type: 'user', message: 'Hello' };
			const turn = new Turn('1', request, new ChatVariablesCollection([]));

			const result: ChatResult = { metadata: {} };
			const response: TurnMessage = { type: 'model', message: 'Hi there!' };
			turn.setResponse(TurnStatus.Success, response, undefined, result);

			expect(turn.responseMessage).to.equal(response);
			expect(turn.responseStatus).to.equal(TurnStatus.Success);
			expect(turn.responseChatResult === result);
		});

		it('should throw an error if setResponse is called more than once', () => {
			const request: TurnMessage = { type: 'user', message: 'Hello' };
			const turn = new Turn('1', request, new ChatVariablesCollection([]));

			const response: TurnMessage = { type: 'model', message: 'Hi there!' };
			turn.setResponse(TurnStatus.Success, response, undefined, undefined);

			expect(() => turn.setResponse(TurnStatus.Success, response, undefined, undefined)).to.throw();
		});

		it('should default status to InProgress if not set', () => {
			const request: TurnMessage = { type: 'user', message: 'Hello' };
			const turn = new Turn('1', request, new ChatVariablesCollection([]));

			expect(turn.responseStatus).to.equal(TurnStatus.InProgress);
		});

		const genericToolCall = { id: 'id', name: 'name', arguments: '{}' };
		it('should restore summaries from metadata to current turns', () => {
			const turn1 = new Turn('1', { type: 'user', message: 'Hello' });
			const turn1Meta: Partial<IResultMetadata> = {
				summary: {
					text: 'summary 1',
					toolCallRoundId: 'round1'
				},
				toolCallRounds: [
					new ToolCallRound('Hello', [genericToolCall], undefined, 'round1'),
					new ToolCallRound('Hello', [], undefined, 'round2'),
				]
			};
			turn1.setResponse(TurnStatus.Success, { type: 'model', message: 'Hi there!' }, undefined, { metadata: turn1Meta });
			normalizeSummariesOnRounds([turn1]);
			expect(turn1.rounds[0].summary).to.equal('summary 1');
		});

		it('should restore summaries from metadata to previous turns', () => {
			const turn1 = new Turn('1', { type: 'user', message: 'Hello' });
			const turn1Meta: Partial<IResultMetadata> = {
				toolCallRounds: [
					new ToolCallRound('Hello', [genericToolCall], undefined, 'round1'),
					new ToolCallRound('Hello', [], undefined, 'round2'),
				]
			};
			turn1.setResponse(TurnStatus.Success, { type: 'model', message: 'Hi there!' }, undefined, { metadata: turn1Meta });

			const turn2 = new Turn('2', { type: 'user', message: 'Hello' });
			const turn2Meta: Partial<IResultMetadata> = {
				summary: {
					text: 'summary',
					toolCallRoundId: 'round1'
				},
				toolCallRounds: [
					new ToolCallRound('Hello', [genericToolCall], undefined, 'round3'),
					new ToolCallRound('Hello', [], undefined, 'round4'),
				]
			};
			turn2.setResponse(TurnStatus.Success, { type: 'model', message: 'Hi there!' }, undefined, { metadata: turn2Meta });

			normalizeSummariesOnRounds([turn1, turn2]);
			expect(turn1.rounds[0].summary).to.equal('summary');
			expect(turn2.rounds[0].summary).to.equal(undefined);
		});
	});
});

describe('TokenUsageMetadata', () => {
	describe('constructor', () => {
		it('should accept valid token counts', () => {
			const metadata = new TokenUsageMetadata(100, 50);
			expect(metadata.promptTokens).to.equal(100);
			expect(metadata.outputTokens).to.equal(50);
		});

		it('should accept zero token counts', () => {
			const metadata = new TokenUsageMetadata(0, 0);
			expect(metadata.promptTokens).to.equal(0);
			expect(metadata.outputTokens).to.equal(0);
		});

		it('should accept maximum valid token counts', () => {
			const metadata = new TokenUsageMetadata(10_000_000, 10_000_000);
			expect(metadata.promptTokens).to.equal(10_000_000);
			expect(metadata.outputTokens).to.equal(10_000_000);
		});

		it('should throw error for negative prompt tokens', () => {
			expect(() => new TokenUsageMetadata(-1, 50)).to.throw('Token counts cannot be negative.');
		});

		it('should throw error for negative output tokens', () => {
			expect(() => new TokenUsageMetadata(100, -1)).to.throw('Token counts cannot be negative.');
		});

		it('should throw error for non-finite prompt tokens (NaN)', () => {
			expect(() => new TokenUsageMetadata(NaN, 50)).to.throw('Token counts must be finite numbers.');
		});

		it('should throw error for non-finite output tokens (NaN)', () => {
			expect(() => new TokenUsageMetadata(100, NaN)).to.throw('Token counts must be finite numbers.');
		});

		it('should throw error for non-finite prompt tokens (Infinity)', () => {
			expect(() => new TokenUsageMetadata(Infinity, 50)).to.throw('Token counts must be finite numbers.');
		});

		it('should throw error for non-finite output tokens (Infinity)', () => {
			expect(() => new TokenUsageMetadata(100, Infinity)).to.throw('Token counts must be finite numbers.');
		});

		it('should throw error for prompt tokens exceeding maximum', () => {
			expect(() => new TokenUsageMetadata(10_000_001, 50)).to.throw('Token counts exceed maximum allowed value.');
		});

		it('should throw error for output tokens exceeding maximum', () => {
			expect(() => new TokenUsageMetadata(100, 10_000_001)).to.throw('Token counts exceed maximum allowed value.');
		});
	});
});
