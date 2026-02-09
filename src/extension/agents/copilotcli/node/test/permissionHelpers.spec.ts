/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assert } from '../../../../../util/vs/base/common/assert';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ToolName } from '../../../../tools/common/toolNames';
import { getConfirmationToolParams, PermissionRequest } from '../permissionHelpers';


describe('CopilotCLI permissionHelpers', () => {
	const disposables = new DisposableStore();
	let instaService: IInstantiationService;
	beforeEach(() => {
		const services = disposables.add(createExtensionUnitTestingServices());
		instaService = services.seal();
	});

	afterEach(() => {
		disposables.clear();
	});

	describe('getConfirmationToolParams', () => {
		it('shell: uses intention over command text and sets terminal confirmation tool', async () => {
			const req: PermissionRequest = { kind: 'shell', intention: 'List workspace files', fullCommandText: 'ls -la' } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			if (result.tool !== ToolName.CoreTerminalConfirmationTool) {
				expect.fail('Expected CoreTerminalConfirmationTool');
			}
			expect(result.tool).toBe(ToolName.CoreTerminalConfirmationTool);
			expect(result.input.message).toBe('List workspace files');
			expect(result.input.command).toBe('ls -la');
			expect(result.input.isBackground).toBe(false);
		});

		it('shell: falls back to fullCommandText when no intention', async () => {
			const req: PermissionRequest = { kind: 'shell', fullCommandText: 'echo "hi"' } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			if (result.tool !== ToolName.CoreTerminalConfirmationTool) {
				expect.fail('Expected CoreTerminalConfirmationTool');
			}
			expect(result.tool).toBe(ToolName.CoreTerminalConfirmationTool);
			expect(result.input.message).toBe('echo "hi"');
			expect(result.input.command).toBe('echo "hi"');
		});

		it('shell: falls back to codeBlock when neither intention nor command text provided', async () => {
			const req: PermissionRequest = { kind: 'shell' } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			if (result.tool !== ToolName.CoreTerminalConfirmationTool) {
				expect.fail('Expected CoreTerminalConfirmationTool');
			}
			expect(result.tool).toBe(ToolName.CoreTerminalConfirmationTool);
			// codeBlock starts with two newlines then ```
			expect(result.input.message).toMatch(/^\n\n```/);
		});

		it('write: uses intention as title and fileName for message', async () => {
			const req: PermissionRequest = { kind: 'write', intention: 'Modify configuration', fileName: 'config.json' } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			if (result.tool !== ToolName.CoreConfirmationTool) {
				expect.fail('Expected CoreConfirmationTool');
			}
			expect(result.tool).toBe(ToolName.CoreConfirmationTool);
			expect(result.input.title).toBe('Allow edits to sensitive files?');
			expect(result.input.message).toContain(`The model wants to edit`);
			expect(result.input.confirmationType).toBe('basic');
		});

		it('write: falls back to default title and codeBlock message when no intention and no fileName', async () => {
			const req: PermissionRequest = { kind: 'write' } as any;
			const result = await getConfirmationToolParams(instaService, req);
			expect(result).toBeUndefined();
		});

		it('mcp: formats with serverName, toolTitle and args JSON', async () => {
			const req: PermissionRequest = { kind: 'mcp', serverName: 'files', toolTitle: 'List Files', toolName: 'list', args: { path: '/tmp' } } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			expect(result.tool).toBe(ToolName.CoreConfirmationTool);
			if (result.tool !== ToolName.CoreConfirmationTool) {
				expect.fail('Expected CoreConfirmationTool');
			}
			expect(result.input.title).toBe('List Files');
			expect(result.input.message).toContain('Server: files');
			expect(result.input.message).toContain('"path": "/tmp"');
		});

		it('mcp: falls back to generated title and full JSON when no serverName', async () => {
			const req: PermissionRequest = { kind: 'mcp', toolName: 'info', args: { detail: true } } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			if (result.tool !== ToolName.CoreConfirmationTool) {
				expect.fail('Expected CoreConfirmationTool');
			}
			expect(result.input.title).toBe('MCP Tool: info');
			expect(result.input.message).toMatch(/```json/);
			expect(result.input.message).toContain('"detail": true');
		});

		it('mcp: uses Unknown when neither toolTitle nor toolName provided', async () => {
			const req: PermissionRequest = { kind: 'mcp', args: {} } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			if (result.tool !== ToolName.CoreConfirmationTool) {
				expect.fail('Expected CoreConfirmationTool');
			}
			expect(result.input.title).toBe('MCP Tool: Unknown');
		});

		it('read: returns specialized title and intention message', async () => {
			const req: PermissionRequest = { kind: 'read', intention: 'Read 2 files', path: '/tmp/a' } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			expect(result.tool).toBe(ToolName.CoreConfirmationTool);
			if (result.tool !== ToolName.CoreConfirmationTool) {
				expect.fail('Expected CoreConfirmationTool');
			}
			expect(result.input.title).toBe('Read file(s)');
			expect(result.input.message).toBe('Read 2 files');
		});

		it('read: falls through to default when intention empty string', async () => {
			const req: PermissionRequest = { kind: 'read', intention: '', path: '/tmp/a' } as any;
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			if (result.tool !== ToolName.CoreConfirmationTool) {
				expect.fail('Expected CoreConfirmationTool');
			}
			expect(result.input.title).toBe('Background Agent Permission Request');
			expect(result.input.message).toMatch(/"kind": "read"/);
		});

		it('default: unknown kind uses generic confirmation and wraps JSON in code block', async () => {
			const req: any = { kind: 'some_new_kind', extra: 1 };
			const result = await getConfirmationToolParams(instaService, req);
			assert(!!result);
			if (result.tool !== ToolName.CoreConfirmationTool) {
				expect.fail('Expected CoreConfirmationTool');
			}
			expect(result.tool).toBe(ToolName.CoreConfirmationTool);
			expect(result.input.title).toBe('Background Agent Permission Request');
			expect(result.input.message).toMatch(/^\n\n```/);
			expect(result.input.message).toContain('"some_new_kind"');
		});
	});

	describe('getConfirmationToolParams', () => {
		it('maps shell requests to terminal confirmation tool', async () => {
			const result = await getConfirmationToolParams(instaService, { kind: 'shell', fullCommandText: 'rm -rf /tmp/test', canOfferSessionApproval: true, commands: [], hasWriteFileRedirection: true, intention: '', possiblePaths: [], possibleUrls: [] });
			assert(!!result);
			expect(result.tool).toBe(ToolName.CoreTerminalConfirmationTool);
		});

		it('maps write requests with filename', async () => {
			const result = await getConfirmationToolParams(instaService, { kind: 'write', fileName: 'foo.ts', diff: '', intention: '' });
			assert(!!result);
			expect(result.tool).toBe(ToolName.CoreConfirmationTool);
			const input = result.input as any;
			expect(input.message).toContain('The model wants to edit');
		});

		it('maps mcp requests', async () => {
			const result = await getConfirmationToolParams(instaService, { kind: 'mcp', serverName: 'srv', toolTitle: 'Tool', toolName: 'run', args: { a: 1 }, readOnly: false });
			assert(!!result);
			expect(result.tool).toBe(ToolName.CoreConfirmationTool);
		});
	});
});
