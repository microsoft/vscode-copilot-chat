/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { TestChatRequest } from '../../../../test/node/testHelpers';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { NullWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { CopilotCLISession } from '../copilotcliAgentManager';

describe('CopilotCLISession workspace handling', () => {
	const store = new DisposableStore();
	let instantiationService: IInstantiationService;
	let workspaceService: IWorkspaceService;

	beforeEach(() => {
		const services = store.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		workspaceService = accessor.get(IWorkspaceService);
	});

	afterEach(() => {
		store.clear();
		vi.resetAllMocks();
	});

	describe('getWorkingDirectory', () => {
		it('returns undefined when no workspace folders exist', () => {
			// Create session with empty workspace
			const emptyWorkspaceService = new NullWorkspaceService([]);
			const session = new (CopilotCLISession as any)({} as any, {} as any, emptyWorkspaceService, {} as any, {} as any);

			const result = session['getWorkingDirectory']();
			expect(result).toBeUndefined();
		});

		it('returns first workspace folder when no request context provided', () => {
			const workspaceUri = URI.file('/workspace/folder1');
			const workspaceService = new NullWorkspaceService([workspaceUri]);
			const session = new (CopilotCLISession as any)({} as any, {} as any, workspaceService, {} as any, {} as any);

			const result = session['getWorkingDirectory']();
			expect(result).toBe(workspaceUri.fsPath);
		});

		it('returns first workspace folder when request has no location2', () => {
			const workspaceUri = URI.file('/workspace/folder1');
			const workspaceService = new NullWorkspaceService([workspaceUri]);
			const session = new (CopilotCLISession as any)({} as any, {} as any, workspaceService, {} as any, {} as any);

			const request = new TestChatRequest('test');
			const result = session['getWorkingDirectory'](request);
			expect(result).toBe(workspaceUri.fsPath);
		});

		it('determines workspace from editor document context', () => {
			const workspace1 = URI.file('/workspace/folder1');
			const workspace2 = URI.file('/workspace/folder2');
			const docUri = URI.file('/workspace/folder2/file.ts');

			const workspaceService = new NullWorkspaceService([workspace1, workspace2]);
			const session = new (CopilotCLISession as any)({} as any, {} as any, workspaceService, {} as any, {} as any);

			// Create a request with editor context pointing to folder2
			const request = {
				...new TestChatRequest('test'),
				location2: {
					document: {
						uri: docUri
					}
				}
			} as any;

			const result = session['getWorkingDirectory'](request);
			// Should select workspace2 since the document is in folder2
			expect(result).toBe(workspace2.fsPath);
		});

		it('determines workspace from notebook cell context', () => {
			const workspace1 = URI.file('/workspace/folder1');
			const workspace2 = URI.file('/workspace/folder2');
			const cellUri = URI.file('/workspace/folder2/notebook.ipynb');

			const workspaceService = new NullWorkspaceService([workspace1, workspace2]);
			const session = new (CopilotCLISession as any)({} as any, {} as any, workspaceService, {} as any, {} as any);

			// Create a request with notebook context pointing to folder2
			const request = {
				...new TestChatRequest('test'),
				location2: {
					cell: {
						uri: cellUri
					}
				}
			} as any;

			const result = session['getWorkingDirectory'](request);
			// Should select workspace2 since the cell is in folder2
			expect(result).toBe(workspace2.fsPath);
		});

		it('falls back to first workspace when document is not in any workspace', () => {
			const workspace1 = URI.file('/workspace/folder1');
			const workspace2 = URI.file('/workspace/folder2');
			const docUri = URI.file('/outside/file.ts');

			const workspaceService = new NullWorkspaceService([workspace1, workspace2]);
			const session = new (CopilotCLISession as any)({} as any, {} as any, workspaceService, {} as any, {} as any);

			const request = {
				...new TestChatRequest('test'),
				location2: {
					document: {
						uri: docUri
					}
				}
			} as any;

			const result = session['getWorkingDirectory'](request);
			// Should fall back to first workspace
			expect(result).toBe(workspace1.fsPath);
		});
	});
});
