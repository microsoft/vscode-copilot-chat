/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Session } from '@github/copilot/sdk';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { TestChatRequest } from '../../../../test/node/testHelpers';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { NullWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { ILogService, NullLogService } from '../../../../../platform/log/common/logService';
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import { IToolsService } from '../../../../tools/common/toolsService';
import { CopilotCLISession } from '../copilotcliAgentManager';

/**
 * Helper to create a minimal CopilotCLISession for testing private methods
 */
function createTestSession(workspaceService: IWorkspaceService): CopilotCLISession {
	const mockSdkSession: Session = { sessionId: 'test-session' } as Session;
	const mockLogService: ILogService = new NullLogService();
	const mockAuthService = {} as IAuthenticationService;
	const mockToolsService = {} as IToolsService;

	return new CopilotCLISession(
		mockSdkSession,
		mockLogService,
		workspaceService,
		mockAuthService,
		mockToolsService
	);
}

/**
 * Helper to create a test request with location2 context
 */
function createRequestWithLocation(documentUri: URI, isNotebook: boolean = false): vscode.ChatRequest {
	const baseRequest = new TestChatRequest('test');
	const location2 = isNotebook
		? { cell: { uri: documentUri } }
		: { document: { uri: documentUri } };

	return {
		...baseRequest,
		location2
	} as vscode.ChatRequest;
}

describe('CopilotCLISession workspace handling', () => {
	const store = new DisposableStore();

	afterEach(() => {
		store.clear();
		vi.resetAllMocks();
	});

	describe('getWorkingDirectory', () => {
		it('returns undefined when no workspace folders exist', () => {
			const emptyWorkspaceService = new NullWorkspaceService([]);
			const session = createTestSession(emptyWorkspaceService);

			const result = (session as any)['getWorkingDirectory']();
			expect(result).toBeUndefined();
		});

		it('returns first workspace folder when no request context provided', () => {
			const workspaceUri = URI.file('/workspace/folder1');
			const workspaceService = new NullWorkspaceService([workspaceUri]);
			const session = createTestSession(workspaceService);

			const result = (session as any)['getWorkingDirectory']();
			expect(result).toBe(workspaceUri.fsPath);
		});

		it('returns first workspace folder when request has no location2', () => {
			const workspaceUri = URI.file('/workspace/folder1');
			const workspaceService = new NullWorkspaceService([workspaceUri]);
			const session = createTestSession(workspaceService);

			const request = new TestChatRequest('test');
			const result = (session as any)['getWorkingDirectory'](request);
			expect(result).toBe(workspaceUri.fsPath);
		});

		it('determines workspace from editor document context', () => {
			const workspace1 = URI.file('/workspace/folder1');
			const workspace2 = URI.file('/workspace/folder2');
			const docUri = URI.file('/workspace/folder2/file.ts');

			const workspaceService = new NullWorkspaceService([workspace1, workspace2]);
			const session = createTestSession(workspaceService);

			const request = createRequestWithLocation(docUri, false);

			const result = (session as any)['getWorkingDirectory'](request);
			// Should select workspace2 since the document is in folder2
			expect(result).toBe(workspace2.fsPath);
		});

		it('determines workspace from notebook cell context', () => {
			const workspace1 = URI.file('/workspace/folder1');
			const workspace2 = URI.file('/workspace/folder2');
			const cellUri = URI.file('/workspace/folder2/notebook.ipynb');

			const workspaceService = new NullWorkspaceService([workspace1, workspace2]);
			const session = createTestSession(workspaceService);

			const request = createRequestWithLocation(cellUri, true);

			const result = (session as any)['getWorkingDirectory'](request);
			// Should select workspace2 since the cell is in folder2
			expect(result).toBe(workspace2.fsPath);
		});

		it('falls back to first workspace when document is not in any workspace', () => {
			const workspace1 = URI.file('/workspace/folder1');
			const workspace2 = URI.file('/workspace/folder2');
			const docUri = URI.file('/outside/file.ts');

			const workspaceService = new NullWorkspaceService([workspace1, workspace2]);
			const session = createTestSession(workspaceService);

			const request = createRequestWithLocation(docUri, false);

			const result = (session as any)['getWorkingDirectory'](request);
			// Should fall back to first workspace
			expect(result).toBe(workspace1.fsPath);
		});
	});
});
