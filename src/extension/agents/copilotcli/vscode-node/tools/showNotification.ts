/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeTextResult } from './utils';
import { ILogger } from '../../../../../platform/log/common/logService';

const NotificationType = z.enum(['information', 'warning', 'error']);

export function registerShowNotificationTool(server: McpServer, logger: ILogger): void {
	const schema = {
		message: z.string().describe('The notification message to display'),
		type: NotificationType.describe('The notification type: information, warning, or error'),
		buttons: z.array(z.string()).optional().describe('Optional array of action button labels'),
	};
	server.tool(
		'show_notification',
		'Shows a VS Code notification with optional action buttons. Blocks until the user clicks a button or dismisses the notification.',
		schema,
		// @ts-expect-error - zod type instantiation too deep for server.tool() generics
		async (args: { message: string; type: 'information' | 'warning' | 'error'; buttons?: string[] }) => {
			const { message, type, buttons } = args;
			logger.info(`Showing ${type} notification: ${message}`);
			const buttonLabels = buttons ?? [];
			if (buttonLabels.length > 0) {
				logger.trace(`Notification buttons: ${buttonLabels.join(', ')}`);
			}

			let showFn: typeof vscode.window.showInformationMessage;
			switch (type) {
				case 'warning':
					showFn = vscode.window.showWarningMessage;
					break;
				case 'error':
					showFn = vscode.window.showErrorMessage;
					break;
				case 'information':
				default:
					showFn = vscode.window.showInformationMessage;
					break;
			}

			const clickedButton = await showFn(message, ...buttonLabels);
			logger.debug(`Notification result: ${clickedButton ?? 'dismissed'}`);

			return makeTextResult({
				dismissed: clickedButton === undefined,
				clicked_button: clickedButton ?? null,
			});
		}
	);
}
