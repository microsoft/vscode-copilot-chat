/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { URI } from '../../../../util/vs/base/common/uri';
import { TestLogService } from '../../../testing/common/testLogService';
import { PromptPathRepresentationServiceNode } from '../../node/promptPathRepresentationServiceNode';

/**
 * Test subclass that mocks shell resolution and simulates Windows environment.
 */
class TestPromptPathRepresentationServiceNode extends PromptPathRepresentationServiceNode {
	readonly shellCalls: string[] = [];
	private readonly _resolutions: Map<string, string>;

	constructor(resolutions: Record<string, string> = {}) {
		super(new TestLogService());
		this._resolutions = new Map(Object.entries(resolutions));
	}

	override isWindows(): boolean {
		return true;
	}

	protected override _resolveLongPathViaShell(shortPath: string): string {
		this.shellCalls.push(shortPath);
		const resolved = this._resolutions.get(shortPath);
		if (resolved === undefined) {
			throw new Error(`No resolution configured for: ${shortPath}`);
		}
		return resolved;
	}
}

describe('PromptPathRepresentationServiceNode', () => {
	if (isWindows) { // on posix the fsPath transformations are different
		describe('8.3 short path resolution', () => {
			it('returns path unchanged when no short segments present', () => {
				const service = new TestPromptPathRepresentationServiceNode();
				const result = service.resolveFilePath('C:\\Program Files\\app\\file.txt');

				expect(result?.fsPath).toBe('c:\\Program Files\\app\\file.txt');
				expect(service.shellCalls).toHaveLength(0);
			});

			it('resolves single short segment', () => {
				const service = new TestPromptPathRepresentationServiceNode({
					'C:\\PROGRA~1': 'C:\\Program Files',
				});

				const result = service.resolveFilePath('C:\\PROGRA~1\\app\\file.txt');

				expect(result?.fsPath).toBe('c:\\Program Files\\app\\file.txt');
				expect(service.shellCalls).toEqual(['C:\\PROGRA~1']);
			});

			it('resolves multiple short segments with separate shell calls', () => {
				const service = new TestPromptPathRepresentationServiceNode({
					'C:\\PROGRA~1': 'C:\\Program Files',
					'C:\\Program Files\\MICROS~1': 'C:\\Program Files\\Microsoft Office',
				});

				const result = service.resolveFilePath('C:\\PROGRA~1\\MICROS~1\\file.txt');

				expect(result?.fsPath).toBe('c:\\Program Files\\Microsoft Office\\file.txt');
				expect(service.shellCalls).toEqual([
					'C:\\PROGRA~1',
					'C:\\Program Files\\MICROS~1',
				]);
			});

			it('caches resolved prefixes across multiple calls', () => {
				const service = new TestPromptPathRepresentationServiceNode({
					'C:\\PROGRA~1': 'C:\\Program Files',
				});

				service.resolveFilePath('C:\\PROGRA~1\\foo.txt');
				service.resolveFilePath('C:\\PROGRA~1\\bar.txt');
				service.resolveFilePath('C:\\PROGRA~1\\subdir\\baz.txt');

				expect(service.shellCalls).toEqual(['C:\\PROGRA~1']);
			});

			it('handles short segment with file extension', () => {
				const service = new TestPromptPathRepresentationServiceNode({
					'C:\\MYFILE~1.TXT': 'C:\\MyLongFileName.txt',
				});

				const result = service.resolveFilePath('C:\\MYFILE~1.TXT');

				expect(result?.fsPath).toBe('c:\\MyLongFileName.txt');
			});

			it('falls back to original path on resolution error', () => {
				const service = new TestPromptPathRepresentationServiceNode({});

				const result = service.resolveFilePath('C:\\PROGRA~1\\file.txt');

				expect(result?.fsPath).toBe('c:\\PROGRA~1\\file.txt');
				expect(service.shellCalls).toEqual(['C:\\PROGRA~1']);
			});

			it('caches failed resolutions to avoid repeated attempts', () => {
				const service = new TestPromptPathRepresentationServiceNode({});

				service.resolveFilePath('C:\\PROGRA~1\\foo.txt');
				service.resolveFilePath('C:\\PROGRA~1\\bar.txt');

				expect(service.shellCalls).toEqual(['C:\\PROGRA~1']);
			});

			it('works with getFilePath for file URIs', () => {
				const service = new TestPromptPathRepresentationServiceNode({
					'c:\\PROGRA~1': 'c:\\Program Files',
				});

				const uri = URI.file('C:\\PROGRA~1\\app\\file.txt');
				const result = service.getFilePath(uri);

				expect(result).toBe('c:\\Program Files\\app\\file.txt');
			});
		});
	} else {
		test('nothing', () => {
			// avoid failing on posix
		});
	}
});
