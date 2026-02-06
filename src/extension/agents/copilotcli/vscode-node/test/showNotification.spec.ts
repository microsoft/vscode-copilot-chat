/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';
import { MockMcpServer, parseToolResult } from './testHelpers';

vi.mock('vscode', () => ({
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
}));

import * as vscode from 'vscode';
import { registerShowNotificationTool } from '../tools/showNotification';

interface NotificationResult {
	dismissed: boolean;
	clicked_button: string | null;
}

describe('showNotification tool', () => {
	const logger = new TestLogService();
	let server: MockMcpServer;

	beforeEach(() => {
		vi.clearAllMocks();
		server = new MockMcpServer();
		registerShowNotificationTool(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, logger);
	});

	it('should register the show_notification tool', () => {
		expect(server.hasToolRegistered('show_notification')).toBe(true);
	});

	it('should call showInformationMessage for information type', async () => {
		vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined!);

		const handler = server.getToolHandler('show_notification')!;
		const result = parseToolResult<NotificationResult>(await handler({ message: 'Hello', type: 'information' }));

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Hello');
		expect(result.dismissed).toBe(true);
		expect(result.clicked_button).toBe(null);
	});

	it('should call showWarningMessage for warning type', async () => {
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined!);

		const handler = server.getToolHandler('show_notification')!;
		await handler({ message: 'Warning!', type: 'warning' });

		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Warning!');
	});

	it('should call showErrorMessage for error type', async () => {
		vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined!);

		const handler = server.getToolHandler('show_notification')!;
		await handler({ message: 'Error!', type: 'error' });

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Error!');
	});

	it('should pass button labels to the notification function', async () => {
		vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Yes' as unknown as undefined);

		const handler = server.getToolHandler('show_notification')!;
		const result = parseToolResult<NotificationResult>(await handler({
			message: 'Continue?',
			type: 'information',
			buttons: ['Yes', 'No'],
		}));

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Continue?', 'Yes', 'No');
		expect(result.dismissed).toBe(false);
		expect(result.clicked_button).toBe('Yes');
	});

	it('should return dismissed=true when user dismisses notification', async () => {
		vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined!);

		const handler = server.getToolHandler('show_notification')!;
		const result = parseToolResult<NotificationResult>(await handler({
			message: 'Dismiss me',
			type: 'information',
			buttons: ['OK'],
		}));

		expect(result.dismissed).toBe(true);
		expect(result.clicked_button).toBe(null);
	});

	it('should handle notification with no buttons', async () => {
		vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined!);

		const handler = server.getToolHandler('show_notification')!;
		const result = parseToolResult<NotificationResult>(await handler({ message: 'Simple error', type: 'error' }));

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Simple error');
		expect(result.dismissed).toBe(true);
	});
});
