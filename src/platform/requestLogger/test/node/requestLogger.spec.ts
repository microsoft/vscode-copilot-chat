/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { ChatLocation } from '../../../chat/common/commonTypes';
import type { IChatEndpoint } from '../../../networking/common/networking';
import { LoggedInfoKind, LoggedRequestKind, type ILoggedRequestInfo } from '../../node/requestLogger';
import { TestRequestLogger } from './testRequestLogger';

describe('RequestLogger custom metadata', () => {
	test('preserves metadata values on logged requests', () => {
		const logger = new TestRequestLogger();
		const endpoint = {
			model: 'test-model',
			family: 'test-family',
		} as IChatEndpoint;

		const pending = logger.logChatRequest('debug-request', endpoint, {
			messages: [],
			ourRequestId: 'request-1',
			model: 'test-model',
			location: ChatLocation.Panel,
			customMetadata: {
				vscModelOverrideFamily: 'vscModelC',
				extraFlag: true,
			},
		});

		pending.resolveWithCancelation();

		const requestInfo = logger.getRequests().find(entry => entry.kind === LoggedInfoKind.Request);
		expect(requestInfo).toBeDefined();

		const request = requestInfo as ILoggedRequestInfo;
		expect(request.entry.type).toBe(LoggedRequestKind.ChatMLCancelation);
		if (request.entry.type !== LoggedRequestKind.ChatMLCancelation) {
			throw new Error('Expected a canceled request entry');
		}

		expect(request.entry.customMetadata).toEqual({
			vscModelOverrideFamily: 'vscModelC',
			extraFlag: true,
		});
	});
});
