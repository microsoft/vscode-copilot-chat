/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { describe, it } from 'vitest';
import { NullEnvService } from '../../../../platform/env/common/nullEnvService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { ChatResponseAnchorPart, ChatResponseMarkdownPart } from '../../../../vscodeTypes';
import { LinkifySymbolAnchor } from '../../common/linkifiedText';
import { LinkifyService } from '../../common/linkifyService';
import { ResponseStreamWithLinkification } from '../../common/responseStreamWithLinkification';
import { createMockFsService, createMockWorkspaceService, workspaceFile } from '../node/util';

class MockChatResponseStream {
	public readonly items: any[] = [];

	markdown(value: string | vscode.MarkdownString): vscode.ChatResponseStream {
		this.items.push(new ChatResponseMarkdownPart(value));
		return this as any;
	}

	anchor(value: vscode.Uri | vscode.Location, title?: string): vscode.ChatResponseStream {
		this.items.push(new ChatResponseAnchorPart(value, title));
		return this as any;
	}

	push(part: vscode.ChatResponsePart): vscode.ChatResponseStream {
		this.items.push(part);
		return this as any;
	}

	// Stub implementations for other required methods
	button(): vscode.ChatResponseStream { return this as any; }
	filetree(): vscode.ChatResponseStream { return this as any; }
	progress(): vscode.ChatResponseStream { return this as any; }
	thinkingProgress(): vscode.ChatResponseStream { return this as any; }
	warning(): vscode.ChatResponseStream { return this as any; }
	reference(): vscode.ChatResponseStream { return this as any; }
	reference2(): vscode.ChatResponseStream { return this as any; }
	codeCitation(): vscode.ChatResponseStream { return this as any; }
	textEdit(): vscode.ChatResponseStream { return this as any; }
	notebookEdit(): vscode.ChatResponseStream { return this as any; }
	markdownWithVulnerabilities(): vscode.ChatResponseStream { return this as any; }
	confirmation(): vscode.ChatResponseStream { return this as any; }
	beginToolInvocation(): vscode.ChatResponseStream { return this as any; }
	updateToolInvocation(): vscode.ChatResponseStream { return this as any; }
	externalEdit(): any { return Promise.resolve(''); }
	clearToPreviousToolInvocation(): void { }
}

describe('ResponseStreamWithLinkification', () => {

	it('Should set both value and value2 for symbol anchors', async () => {
		const fs = createMockFsService([]);
		const workspaceService = createMockWorkspaceService();
		const linkifyService = new LinkifyService(fs, workspaceService, NullEnvService.Instance);

		const mockProgress = new MockChatResponseStream();
		const stream = new ResponseStreamWithLinkification(
			{ requestId: 'test', references: [] },
			mockProgress as any,
			[],
			CancellationToken.None,
			linkifyService,
			workspaceService
		);

		// Create a symbol anchor
		const symbolInfo: vscode.SymbolInformation = {
			name: 'testSymbol',
			containerName: '',
			kind: vscode.SymbolKind.Function,
			location: new vscode.Location(workspaceFile('test.ts'), new vscode.Position(10, 5))
		};

		const linkifyPart = new LinkifySymbolAnchor(symbolInfo);

		// Simulate what linkifier does - output the linkified part
		await (stream as any).outputMarkdown({ parts: [linkifyPart] });

		// Verify the anchor part was created correctly
		assert.strictEqual(mockProgress.items.length, 1);
		const anchorPart = mockProgress.items[0];
		assert(anchorPart instanceof ChatResponseAnchorPart);

		// Verify value is set to the location (for backward compatibility)
		assert(anchorPart.value instanceof vscode.Location);
		assert.strictEqual(anchorPart.value.uri.toString(), symbolInfo.location.uri.toString());

		// Verify value2 is set to the symbol information (for proper rendering)
		assert.strictEqual((anchorPart as any).value2, symbolInfo);
	});

	it('Should handle regular location anchors without setting value2', async () => {
		const fs = createMockFsService([]);
		const workspaceService = createMockWorkspaceService();
		const linkifyService = new LinkifyService(fs, workspaceService, NullEnvService.Instance);

		const mockProgress = new MockChatResponseStream();
		const stream = new ResponseStreamWithLinkification(
			{ requestId: 'test', references: [] },
			mockProgress as any,
			[],
			CancellationToken.None,
			linkifyService,
			workspaceService
		);

		// Use anchor method directly (not through linkifier)
		const uri = workspaceFile('test.ts');
		stream.anchor(uri, 'Test File');
		await stream.finalize();

		// Verify the anchor was added correctly
		assert.strictEqual(mockProgress.items.length, 1);
		const anchorPart = mockProgress.items[0];
		assert(anchorPart instanceof ChatResponseAnchorPart);
		assert.strictEqual(anchorPart.value.toString(), uri.toString());
		assert.strictEqual(anchorPart.title, 'Test File');

		// value2 should not be set for regular anchors
		assert.strictEqual((anchorPart as any).value2, undefined);
	});
});
