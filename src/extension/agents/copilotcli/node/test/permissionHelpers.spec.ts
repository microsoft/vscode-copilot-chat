/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest';
import { ToolName } from '../../../../tools/common/toolNames';
import { getConfirmationToolParams } from '../permissionHelpers';

describe('permissionHelpers.getConfirmationToolParams', () => {
	it('maps shell requests to terminal confirmation tool', () => {
		const result = getConfirmationToolParams({ kind: 'shell', fullCommandText: 'rm -rf /tmp/test', canOfferSessionApproval: true, commands: [], hasWriteFileRedirection: true, intention: '', possiblePaths: [] });
		expect(result.tool).toBe(ToolName.CoreTerminalConfirmationTool);
	});

	it('maps write requests with filename', () => {
		const result = getConfirmationToolParams({ kind: 'write', fileName: 'foo.ts', diff: '', intention: '' });
		expect(result.tool).toBe(ToolName.CoreConfirmationTool);
		const input = result.input as any;
		expect(input.message).toContain('Edit foo.ts');
	});

	it('maps mcp requests', () => {
		const result = getConfirmationToolParams({ kind: 'mcp', serverName: 'srv', toolTitle: 'Tool', toolName: 'run', args: { a: 1 }, readOnly: false });
		expect(result.tool).toBe(ToolName.CoreConfirmationTool);
	});
});
