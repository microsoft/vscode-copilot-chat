/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, beforeEach, describe, expect, it, suite, test } from 'vitest';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { ICustomInstructionsService, IInstructionIndexFile } from '../../../../platform/customInstructions/common/customInstructionsService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IIgnoreService, NullIgnoreService } from '../../../../platform/ignore/common/ignoreService';
import { MockCustomInstructionsService } from '../../../../platform/test/common/testCustomInstructionsService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService, NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { ResourceSet } from '../../../../util/vs/base/common/map';
import { posix } from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatVariablesCollection, CustomizationsIndexId, PromptFileIdPrefix } from '../../../prompt/common/chatVariablesCollection';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { encodeUrlHostname } from '../../common/toolUtils';
import { assertFileOkForTool, inputGlobToPattern, isDirExternalAndNeedsConfirmation, isFileExternalAndNeedsConfirmation } from '../toolUtils';

class TestIgnoreService extends NullIgnoreService {
	private readonly _ignoredUris = new Set<string>();

	setIgnoredUris(uris: URI[]): void {
		this._ignoredUris.clear();
		for (const uri of uris) {
			this._ignoredUris.add(uri.toString());
		}
	}

	override async isCopilotIgnored(file: URI, _token?: CancellationToken): Promise<boolean> {
		return this._ignoredUris.has(file.toString());
	}
}

suite('toolUtils - additionalReadAccessPaths', () => {
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;
	let configService: InMemoryConfigurationService;
	let ignoreService: TestIgnoreService;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService,
			[[URI.file('/workspace')], []]
		));
		ignoreService = new TestIgnoreService();
		services.define(IIgnoreService, ignoreService);
		accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
	});

	afterAll(() => {
		accessor.dispose();
	});

	beforeEach(async () => {
		await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, []);
		ignoreService.setIgnoredUris([]);
	});

	function invokeAssertFileOkForTool(uri: URI, readOnly?: boolean) {
		return instantiationService.invokeFunction(acc => assertFileOkForTool(acc, uri, undefined, readOnly ? { readOnly } : undefined));
	}

	function invokeIsFileExternalAndNeedsConfirmation(uri: URI, readOnly?: boolean) {
		return instantiationService.invokeFunction(acc => isFileExternalAndNeedsConfirmation(acc, uri, undefined, readOnly ? { readOnly } : undefined));
	}

	function invokeIsDirExternalAndNeedsConfirmation(uri: URI, readOnly?: boolean) {
		return instantiationService.invokeFunction(acc => isDirExternalAndNeedsConfirmation(acc, uri, undefined, readOnly ? { readOnly } : undefined));
	}

	describe('assertFileOkForTool', () => {
		test('workspace files are always allowed', async () => {
			await expect(invokeAssertFileOkForTool(URI.file('/workspace/file.ts'))).resolves.toBeUndefined();
		});

		test('external file throws without additionalReadAccessPaths', async () => {
			await expect(invokeAssertFileOkForTool(URI.file('/external/file.ts'), true))
				.rejects.toThrow(/outside of the workspace/);
		});

		test('external file allowed when under additionalReadAccessPaths with readOnly', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			await expect(invokeAssertFileOkForTool(URI.file('/external/file.ts'), true)).resolves.toBeUndefined();
		});

		test('nested file under additionalReadAccessPaths is allowed', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			await expect(invokeAssertFileOkForTool(URI.file('/external/deep/nested/file.ts'), true)).resolves.toBeUndefined();
		});

		test('exact folder path is allowed', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external/folder']);
			await expect(invokeAssertFileOkForTool(URI.file('/external/folder'), true)).resolves.toBeUndefined();
		});

		test('sibling of additional path is not allowed', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external/folder']);
			await expect(invokeAssertFileOkForTool(URI.file('/external/other/file.ts'), true))
				.rejects.toThrow(/outside of the workspace/);
		});

		test('parent of additional path is not allowed', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external/folder/sub']);
			await expect(invokeAssertFileOkForTool(URI.file('/external/folder/file.ts'), true))
				.rejects.toThrow(/outside of the workspace/);
		});

		test('additional paths are NOT honored without readOnly flag', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			await expect(invokeAssertFileOkForTool(URI.file('/external/file.ts'), false))
				.rejects.toThrow(/outside of the workspace/);
		});

		test('additional paths are NOT honored when readOnly is undefined', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			await expect(invokeAssertFileOkForTool(URI.file('/external/file.ts')))
				.rejects.toThrow(/outside of the workspace/);
		});

		test('multiple additional paths are checked', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/path1', '/path2', '/path3']);
			await expect(invokeAssertFileOkForTool(URI.file('/path2/file.ts'), true)).resolves.toBeUndefined();
			await expect(invokeAssertFileOkForTool(URI.file('/path3/deep/file.ts'), true)).resolves.toBeUndefined();
		});

		test('copilotignore overrides additionalReadAccessPaths', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			ignoreService.setIgnoredUris([URI.file('/external/secret.ts')]);
			await expect(invokeAssertFileOkForTool(URI.file('/external/secret.ts'), true))
				.rejects.toThrow(/configured to be ignored by Copilot/);
		});

		test('copilotignore overrides workspace membership', async () => {
			ignoreService.setIgnoredUris([URI.file('/workspace/secret.ts')]);
			await expect(invokeAssertFileOkForTool(URI.file('/workspace/secret.ts')))
				.rejects.toThrow(/configured to be ignored by Copilot/);
		});

		test('empty additional paths array has no effect', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, []);
			await expect(invokeAssertFileOkForTool(URI.file('/external/file.ts'), true))
				.rejects.toThrow(/outside of the workspace/);
		});
	});

	describe('isFileExternalAndNeedsConfirmation', () => {
		test('workspace file does not need confirmation', async () => {
			expect(await invokeIsFileExternalAndNeedsConfirmation(URI.file('/workspace/file.ts'))).toBe(false);
		});

		test('external file that does not exist throws', async () => {
			await expect(invokeIsFileExternalAndNeedsConfirmation(URI.file('/external/file.ts')))
				.rejects.toThrow(/does not exist/);
		});

		test('non-existent file throws', async () => {
			await expect(invokeIsFileExternalAndNeedsConfirmation(URI.file('/nonexistent/file.ts')))
				.rejects.toThrow(/does not exist/);
		});

		test('non-existent workspace file does not need confirmation', async () => {
			// Non-existent files within the workspace should also not trigger confirmation
			expect(await invokeIsFileExternalAndNeedsConfirmation(URI.file('/workspace/nonexistent.ts'))).toBe(false);
		});

		test('external file under additional paths with readOnly does not need confirmation', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			expect(await invokeIsFileExternalAndNeedsConfirmation(URI.file('/external/file.ts'), true)).toBe(false);
		});

		test('nested file under additional paths with readOnly does not need confirmation', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			expect(await invokeIsFileExternalAndNeedsConfirmation(URI.file('/external/deep/nested/file.ts'), true)).toBe(false);
		});

		test('external file under additional paths without readOnly throws when file does not exist', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			await expect(invokeIsFileExternalAndNeedsConfirmation(URI.file('/external/file.ts'), false))
				.rejects.toThrow(/does not exist/);
		});

		test('file outside additional paths throws when file does not exist', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/allowed']);
			await expect(invokeIsFileExternalAndNeedsConfirmation(URI.file('/disallowed/file.ts'), true))
				.rejects.toThrow(/does not exist/);
		});
	});

	describe('isDirExternalAndNeedsConfirmation', () => {
		test('workspace dir does not need confirmation', () => {
			expect(invokeIsDirExternalAndNeedsConfirmation(URI.file('/workspace/subdir'))).toBe(false);
		});

		test('external dir needs confirmation by default', () => {
			expect(invokeIsDirExternalAndNeedsConfirmation(URI.file('/external/dir'))).toBe(true);
		});

		test('external dir under additional paths with readOnly does not need confirmation', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			expect(invokeIsDirExternalAndNeedsConfirmation(URI.file('/external/dir'), true)).toBe(false);
		});

		test('subdirectory under additional paths does not need confirmation', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			expect(invokeIsDirExternalAndNeedsConfirmation(URI.file('/external/a/b/c'), true)).toBe(false);
		});

		test('external dir under additional paths still needs confirmation without readOnly', async () => {
			await configService.setConfig(ConfigKey.AdditionalReadAccessPaths, ['/external']);
			expect(invokeIsDirExternalAndNeedsConfirmation(URI.file('/external/dir'), false)).toBe(true);
		});
	});
});

suite('toolUtils - external file existence', () => {
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;
	let mockFs: MockFileSystemService;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService,
			[[URI.file('/workspace')], []]
		));
		mockFs = new MockFileSystemService();
		services.define(IFileSystemService, mockFs);
		accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
	});

	afterAll(() => {
		accessor.dispose();
	});

	function invokeIsFileExternalAndNeedsConfirmation(uri: URI) {
		return instantiationService.invokeFunction(acc => isFileExternalAndNeedsConfirmation(acc, uri));
	}

	test('external file that exists needs confirmation', async () => {
		// Mock an external file that actually exists
		mockFs.mockFile(URI.file('/external/existing-file.ts'), 'content');
		expect(await invokeIsFileExternalAndNeedsConfirmation(URI.file('/external/existing-file.ts'))).toBe(true);
	});

	test('external file that does not exist throws', async () => {
		// File doesn't exist in mock file system
		await expect(invokeIsFileExternalAndNeedsConfirmation(URI.file('/external/nonexistent.ts')))
			.rejects.toThrow(/does not exist/);
	});

	test('workspace file does not need confirmation even if it exists', async () => {
		// Mock a workspace file
		mockFs.mockFile(URI.file('/workspace/file.ts'), 'content');
		expect(await invokeIsFileExternalAndNeedsConfirmation(URI.file('/workspace/file.ts'))).toBe(false);
	});

	test('workspace file does not need confirmation even if it does not exist', async () => {
		// Non-existent workspace file
		expect(await invokeIsFileExternalAndNeedsConfirmation(URI.file('/workspace/nonexistent.ts'))).toBe(false);
	});
});

describe('encodeUrlHostname', () => {
	describe('ASCII URLs', () => {
		it('handles standard ASCII domain', () => {
			const result = encodeUrlHostname('https://example.com');
			expect(result.encoded).toBe('https://example.com');
			expect(result.isDifferent).toBe(false);
		});

		it('handles ASCII domain with path', () => {
			const result = encodeUrlHostname('https://example.com/path/to/page');
			expect(result.encoded).toBe('https://example.com/path/to/page');
			expect(result.isDifferent).toBe(false);
		});

		it('handles ASCII domain with query string', () => {
			const result = encodeUrlHostname('https://example.com/page?foo=bar&baz=qux');
			expect(result.encoded).toBe('https://example.com/page?foo=bar&baz=qux');
			expect(result.isDifferent).toBe(false);
		});

		it('handles ASCII domain with fragment', () => {
			const result = encodeUrlHostname('https://example.com/page#section');
			expect(result.encoded).toBe('https://example.com/page#section');
			expect(result.isDifferent).toBe(false);
		});

		it('handles http scheme', () => {
			const result = encodeUrlHostname('http://example.com');
			expect(result.encoded).toBe('http://example.com');
			expect(result.isDifferent).toBe(false);
		});
	});

	describe('internationalized domain names (IDN)', () => {
		it('encodes Cyrillic domain', () => {
			const result = encodeUrlHostname('https://пример.рф');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});

		it('encodes Chinese domain', () => {
			const result = encodeUrlHostname('https://例え.jp');
			expect(result.encoded).toBe('https://xn--r8jz45g.jp');
			expect(result.isDifferent).toBe(true);
		});

		it('encodes German domain with umlaut', () => {
			const result = encodeUrlHostname('https://müller.de');
			expect(result.encoded).toBe('https://xn--mller-kva.de');
			expect(result.isDifferent).toBe(true);
		});

		it('encodes Arabic domain', () => {
			const result = encodeUrlHostname('https://مثال.السعودية');
			expect(result.encoded).toBe('https://xn--mgbh0fb.xn--mgberp4a5d4ar');
			expect(result.isDifferent).toBe(true);
		});

		it('preserves path when encoding IDN', () => {
			const result = encodeUrlHostname('https://пример.рф/path/to/page');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai/path/to/page');
			expect(result.isDifferent).toBe(true);
		});

		it('preserves query string when encoding IDN', () => {
			const result = encodeUrlHostname('https://пример.рф?foo=bar');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai?foo=bar');
			expect(result.isDifferent).toBe(true);
		});
	});

	describe('URLs with port', () => {
		it('handles ASCII domain with port', () => {
			const result = encodeUrlHostname('https://example.com:8080');
			expect(result.encoded).toBe('https://example.com:8080');
			expect(result.isDifferent).toBe(false);
		});

		it('encodes IDN with port', () => {
			const result = encodeUrlHostname('https://пример.рф:8080');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai:8080');
			expect(result.isDifferent).toBe(true);
		});

		it('handles port with path', () => {
			const result = encodeUrlHostname('https://пример.рф:8080/path');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai:8080/path');
			expect(result.isDifferent).toBe(true);
		});
	});

	describe('URLs with userinfo', () => {
		it('handles userinfo with ASCII domain', () => {
			const result = encodeUrlHostname('https://user:pass@example.com');
			expect(result.encoded).toBe('https://user:pass@example.com');
			expect(result.isDifferent).toBe(false);
		});

		it('encodes IDN with userinfo', () => {
			const result = encodeUrlHostname('https://user:pass@пример.рф');
			expect(result.encoded).toBe('https://user:pass@xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});

		it('handles userinfo with port', () => {
			const result = encodeUrlHostname('https://user:pass@пример.рф:8080');
			expect(result.encoded).toBe('https://user:pass@xn--e1afmkfd.xn--p1ai:8080');
			expect(result.isDifferent).toBe(true);
		});

		it('handles username without password', () => {
			const result = encodeUrlHostname('https://user@пример.рф');
			expect(result.encoded).toBe('https://user@xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});
	});

	describe('subdomain handling', () => {
		it('encodes subdomain with non-ASCII characters', () => {
			const result = encodeUrlHostname('https://поддомен.пример.рф');
			expect(result.encoded).toBe('https://xn--d1aad1agbce.xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});

		it('handles mixed ASCII and non-ASCII subdomains', () => {
			const result = encodeUrlHostname('https://www.пример.рф');
			expect(result.encoded).toBe('https://www.xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});
	});

	describe('edge cases', () => {
		it('handles localhost', () => {
			const result = encodeUrlHostname('http://localhost:3000');
			expect(result.encoded).toBe('http://localhost:3000');
			expect(result.isDifferent).toBe(false);
		});

		it('handles IP address', () => {
			const result = encodeUrlHostname('http://192.168.1.1:8080');
			expect(result.encoded).toBe('http://192.168.1.1:8080');
			expect(result.isDifferent).toBe(false);
		});

		it('handles IPv6 address', () => {
			const result = encodeUrlHostname('http://[::1]:8080');
			expect(result.encoded).toBe('http://[::1]:8080');
			expect(result.isDifferent).toBe(false);
		});

		it('handles empty authority gracefully', () => {
			const result = encodeUrlHostname('file:///path/to/file');
			expect(result.encoded).toBe('file:///path/to/file');
			expect(result.isDifferent).toBe(false);
		});

		it('handles invalid URL gracefully', () => {
			const result = encodeUrlHostname('not a url');
			expect(result.encoded).toBe('not a url');
			expect(result.isDifferent).toBe(false);
		});
	});

	describe('homograph attack prevention', () => {
		it('encodes Cyrillic "a" that looks like Latin "a"', () => {
			// Cyrillic а (U+0430) vs Latin a (U+0061)
			const result = encodeUrlHostname('https://exаmple.com'); // Contains Cyrillic а
			expect(result.isDifferent).toBe(true);
			expect(result.encoded).toContain('xn--');
		});

		it('encodes Greek omicron that looks like Latin "o"', () => {
			// Greek ο (U+03BF) vs Latin o (U+006F)
			const result = encodeUrlHostname('https://gοοgle.com'); // Contains Greek ο
			expect(result.isDifferent).toBe(true);
			expect(result.encoded).toContain('xn--');
		});
	});
});

class MultiRootWorkspaceService extends NullWorkspaceService {
	override getWorkspaceFolderName(workspaceFolderUri: URI): string {
		return posix.basename(workspaceFolderUri.path);
	}
}

describe('inputGlobToPattern - multi-root workspace', () => {
	const folder1 = URI.file('/workspace/vscode');
	const folder2 = URI.file('/workspace/vscode-copilot-chat');
	const workspaceService = new MultiRootWorkspaceService([folder1, folder2]);

	// Absolute path cases
	test('absolute path to workspace folder root resolves to empty relative pattern', () => {
		const result = inputGlobToPattern('/workspace/vscode', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder1, pattern: '' });
		expect(result.folderName).toBe('vscode');
		expect(result.folderRelativePattern).toBe('');
	});

	test('absolute path to workspace folder root with trailing slash', () => {
		const result = inputGlobToPattern('/workspace/vscode/', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ pattern: '' });
		expect(result.folderName).toBe('vscode');
	});

	test('absolute path with subdirectory', () => {
		const result = inputGlobToPattern('/workspace/vscode/src', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder1, pattern: 'src' });
		expect(result.folderName).toBe('vscode');
		expect(result.folderRelativePattern).toBe('src');
	});

	test('absolute path with glob pattern', () => {
		const result = inputGlobToPattern('/workspace/vscode/src/**/*.ts', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder1, pattern: 'src/**/*.ts' });
		expect(result.folderName).toBe('vscode');
		expect(result.folderRelativePattern).toBe('src/**/*.ts');
	});

	// Folder name cases (multi-root only)
	test('bare folder name resolves to ** pattern', () => {
		const result = inputGlobToPattern('vscode', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder1, pattern: '**' });
		expect(result.folderName).toBe('vscode');
	});

	test('folder name with glob suffix', () => {
		const result = inputGlobToPattern('vscode/**', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder1, pattern: '**' });
		expect(result.folderName).toBe('vscode');
	});

	test('folder name with subdirectory pattern', () => {
		const result = inputGlobToPattern('vscode/src/**/*.ts', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder1, pattern: 'src/**/*.ts' });
		expect(result.folderName).toBe('vscode');
		expect(result.folderRelativePattern).toBe('src/**/*.ts');
	});

	test('**/folderName resolves to folder', () => {
		const result = inputGlobToPattern('**/vscode', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder1, pattern: '**' });
		expect(result.folderName).toBe('vscode');
	});

	test('**/folderName/rest resolves to folder with pattern', () => {
		const result = inputGlobToPattern('**/vscode/src/**/*.ts', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder1, pattern: 'src/**/*.ts' });
		expect(result.folderName).toBe('vscode');
	});

	test('second folder name resolves correctly', () => {
		const result = inputGlobToPattern('vscode-copilot-chat/src/**', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toMatchObject({ baseUri: folder2, pattern: 'src/**' });
		expect(result.folderName).toBe('vscode-copilot-chat');
	});

	// Non-folder cases
	test('does not rewrite when folder name is unknown', () => {
		const result = inputGlobToPattern('**/unknown-folder/src/**', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toBe('**/unknown-folder/src/**');
		expect(result.folderName).toBeUndefined();
	});

	test('does not rewrite wildcard-only patterns', () => {
		const result = inputGlobToPattern('**/*.ts', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toBe('**/*.ts');
		expect(result.folderName).toBeUndefined();
	});

	test('does not rewrite folder names in single-root workspace', () => {
		const singleRoot = new MultiRootWorkspaceService([folder1]);
		const result = inputGlobToPattern('**/vscode/src/**', singleRoot, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toBe('**/vscode/src/**');
		expect(result.folderName).toBeUndefined();
	});

	test('absolute path outside workspace is not rewritten', () => {
		const result = inputGlobToPattern('/other/path', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toBe('/other/path');
		expect(result.folderName).toBeUndefined();
	});

	test('plain glob pattern passes through', () => {
		const result = inputGlobToPattern('src/**/*.ts', workspaceService, undefined);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]).toBe('src/**/*.ts');
		expect(result.folderName).toBeUndefined();
	});
});

suite('toolUtils - external instructions and skills', () => {
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;
	let mockFs: MockFileSystemService;
	let mockCustomInstructions: MockCustomInstructionsService;
	let testRequestCounter: number;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService,
			[[URI.file('/workspace')], []]
		));
		mockFs = new MockFileSystemService();
		services.define(IFileSystemService, mockFs);
		mockCustomInstructions = new MockCustomInstructionsService();
		services.define(ICustomInstructionsService, mockCustomInstructions);
		accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		testRequestCounter = 0;
	});

	afterAll(() => {
		accessor.dispose();
	});

	function nextRequestId(): string {
		return `test-request-${++testRequestCounter}`;
	}

	function makeBuildPromptContext(options: {
		requestId?: string;
		indexContent?: string;
		promptFileUris?: URI[];
	}): IBuildPromptContext {
		const refs: import('vscode').ChatPromptReference[] = [];
		if (options.indexContent !== undefined) {
			refs.push({
				id: CustomizationsIndexId,
				name: 'customizations',
				value: options.indexContent,
			});
		}
		if (options.promptFileUris) {
			for (const uri of options.promptFileUris) {
				refs.push({
					id: `${PromptFileIdPrefix}.${uri.fsPath}`,
					name: uri.fsPath,
					value: uri,
				});
			}
		}
		return {
			requestId: options.requestId ?? nextRequestId(),
			query: 'test',
			history: [],
			chatVariables: new ChatVariablesCollection(refs),
		} as unknown as IBuildPromptContext;
	}

	function makeIndexFileWithInstructionAndSkill(instructionUri: URI, skillUri: URI): IInstructionIndexFile {
		return {
			instructions: new ResourceSet([instructionUri]),
			skills: new ResourceSet([skillUri]),
			skillFolders: new ResourceSet([URI.file(posix.dirname(skillUri.path))]),
			agents: new Set<string>(),
		};
	}

	function invokeIsFileExternalAndNeedsConfirmation(uri: URI, buildPromptContext?: IBuildPromptContext) {
		return instantiationService.invokeFunction(acc => isFileExternalAndNeedsConfirmation(acc, uri, buildPromptContext));
	}

	function invokeAssertFileOkForTool(uri: URI, buildPromptContext?: IBuildPromptContext) {
		return instantiationService.invokeFunction(acc => assertFileOkForTool(acc, uri, buildPromptContext));
	}

	function invokeIsDirExternalAndNeedsConfirmation(uri: URI, buildPromptContext?: IBuildPromptContext) {
		return instantiationService.invokeFunction(acc => isDirExternalAndNeedsConfirmation(acc, uri, buildPromptContext));
	}

	describe('isFileExternalAndNeedsConfirmation with custom instructions index', () => {
		const instructionUri = URI.file('/home/user/.github/copilot-instructions.md');
		const skillUri = URI.file('/home/user/.agents/skills/my-skill/SKILL.md');

		test('instruction file listed in index does not need confirmation', async () => {
			const indexFile = makeIndexFileWithInstructionAndSkill(instructionUri, skillUri);
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;
			mockFs.mockFile(instructionUri, '# Instructions');

			const ctx = makeBuildPromptContext({ indexContent: '<instructions></instructions>' });
			expect(await invokeIsFileExternalAndNeedsConfirmation(instructionUri, ctx)).toBe(false);
		});

		test('skill file listed in index does not need confirmation', async () => {
			const indexFile = makeIndexFileWithInstructionAndSkill(instructionUri, skillUri);
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;
			mockFs.mockFile(skillUri, '# Skill');

			const ctx = makeBuildPromptContext({ indexContent: '<skills></skills>' });
			expect(await invokeIsFileExternalAndNeedsConfirmation(skillUri, ctx)).toBe(false);
		});

		test('nested file under a skill folder does not need confirmation', async () => {
			const nestedFile = URI.file('/home/user/.agents/skills/my-skill/primitives/agents.md');
			const indexFile = makeIndexFileWithInstructionAndSkill(instructionUri, skillUri);
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;
			mockFs.mockFile(nestedFile, '# Nested skill file');

			const ctx = makeBuildPromptContext({ indexContent: '<skills></skills>' });
			expect(await invokeIsFileExternalAndNeedsConfirmation(nestedFile, ctx)).toBe(false);
		});

		test('external file NOT in index still needs confirmation', async () => {
			const unrelatedFile = URI.file('/home/user/random/file.ts');
			const indexFile = makeIndexFileWithInstructionAndSkill(instructionUri, skillUri);
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;
			mockFs.mockFile(unrelatedFile, 'content');

			const ctx = makeBuildPromptContext({ indexContent: '<instructions></instructions>' });
			expect(await invokeIsFileExternalAndNeedsConfirmation(unrelatedFile, ctx)).toBe(true);
		});
	});

	describe('isFileExternalAndNeedsConfirmation with attached prompt files', () => {
		test('attached prompt file does not need confirmation', async () => {
			const promptFileUri = URI.file('/home/user/prompts/my-prompt.prompt.md');
			mockFs.mockFile(promptFileUri, '# My Prompt');

			const ctx = makeBuildPromptContext({ promptFileUris: [promptFileUri] });
			expect(await invokeIsFileExternalAndNeedsConfirmation(promptFileUri, ctx)).toBe(false);
		});

		test('file not attached as prompt still needs confirmation', async () => {
			const otherFile = URI.file('/home/user/prompts/other.md');
			const promptFileUri = URI.file('/home/user/prompts/my-prompt.prompt.md');
			mockFs.mockFile(otherFile, '# Other');

			const ctx = makeBuildPromptContext({ promptFileUris: [promptFileUri] });
			expect(await invokeIsFileExternalAndNeedsConfirmation(otherFile, ctx)).toBe(true);
		});
	});

	describe('isFileExternalAndNeedsConfirmation with special URI schemes', () => {
		test('vscode-chat-internal scheme does not need confirmation', async () => {
			const uri = URI.from({ scheme: 'vscode-chat-internal', path: '/some/resource' });
			expect(await invokeIsFileExternalAndNeedsConfirmation(uri)).toBe(false);
		});

		test('copilot-skill scheme does not need confirmation', async () => {
			const uri = URI.from({ scheme: 'copilot-skill', path: '/my-skill/SKILL.md' });
			expect(await invokeIsFileExternalAndNeedsConfirmation(uri)).toBe(false);
		});
	});

	describe('isFileExternalAndNeedsConfirmation without buildPromptContext (fallback)', () => {
		test('file recognized by customInstructionsService does not need confirmation', async () => {
			const externalInstructionUri = URI.file('/home/user/.github/copilot-instructions.md');
			mockCustomInstructions.setExternalFiles([externalInstructionUri]);
			mockFs.mockFile(externalInstructionUri, '# Instructions');

			expect(await invokeIsFileExternalAndNeedsConfirmation(externalInstructionUri)).toBe(false);
			mockCustomInstructions.setExternalFiles([]);
		});

		test('file not recognized by customInstructionsService needs confirmation', async () => {
			const randomUri = URI.file('/home/user/random-file.ts');
			mockCustomInstructions.setExternalFiles([]);
			mockFs.mockFile(randomUri, 'content');

			expect(await invokeIsFileExternalAndNeedsConfirmation(randomUri)).toBe(true);
		});
	});

	describe('assertFileOkForTool with custom instructions index', () => {
		const instructionUri = URI.file('/external/instructions/guidelines.instructions.md');
		const skillUri = URI.file('/external/skills/my-skill/SKILL.md');

		test('instruction file in index is allowed', async () => {
			const indexFile = makeIndexFileWithInstructionAndSkill(instructionUri, skillUri);
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;

			const ctx = makeBuildPromptContext({ indexContent: '<instructions></instructions>' });
			await expect(invokeAssertFileOkForTool(instructionUri, ctx)).resolves.toBeUndefined();
		});

		test('skill file in index is allowed', async () => {
			const indexFile = makeIndexFileWithInstructionAndSkill(instructionUri, skillUri);
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;

			const ctx = makeBuildPromptContext({ indexContent: '<skills></skills>' });
			await expect(invokeAssertFileOkForTool(skillUri, ctx)).resolves.toBeUndefined();
		});

		test('file under skill folder is allowed', async () => {
			const nestedFile = URI.file('/external/skills/my-skill/helpers/utils.md');
			const indexFile = makeIndexFileWithInstructionAndSkill(instructionUri, skillUri);
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;

			const ctx = makeBuildPromptContext({ indexContent: '<skills></skills>' });
			await expect(invokeAssertFileOkForTool(nestedFile, ctx)).resolves.toBeUndefined();
		});

		test('external file not in index throws', async () => {
			const unrelatedFile = URI.file('/external/random/file.ts');
			const indexFile = makeIndexFileWithInstructionAndSkill(instructionUri, skillUri);
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;

			const ctx = makeBuildPromptContext({ indexContent: '<instructions></instructions>' });
			await expect(invokeAssertFileOkForTool(unrelatedFile, ctx))
				.rejects.toThrow(/outside of the workspace/);
		});
	});

	describe('isDirExternalAndNeedsConfirmation with skill folders', () => {
		test('skill folder from index does not need confirmation', () => {
			const skillUri = URI.file('/external/skills/my-skill/SKILL.md');
			const skillFolderUri = URI.file('/external/skills/my-skill');
			const indexFile: IInstructionIndexFile = {
				instructions: new ResourceSet(),
				skills: new ResourceSet([skillUri]),
				skillFolders: new ResourceSet([skillFolderUri]),
				agents: new Set<string>(),
			};
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;

			const ctx = makeBuildPromptContext({ indexContent: '<skills></skills>' });
			expect(invokeIsDirExternalAndNeedsConfirmation(skillFolderUri, ctx)).toBe(false);
		});

		test('external dir not in skill folders needs confirmation', () => {
			const otherDir = URI.file('/external/other-dir');
			const skillFolderUri = URI.file('/external/skills/my-skill');
			const indexFile: IInstructionIndexFile = {
				instructions: new ResourceSet(),
				skills: new ResourceSet(),
				skillFolders: new ResourceSet([skillFolderUri]),
				agents: new Set<string>(),
			};
			mockCustomInstructions.parseInstructionIndexFile = () => indexFile;

			const ctx = makeBuildPromptContext({ indexContent: '<skills></skills>' });
			expect(invokeIsDirExternalAndNeedsConfirmation(otherDir, ctx)).toBe(true);
		});

		test('without buildPromptContext, falls back to customInstructionsService', () => {
			const externalFolderUri = URI.file('/external/skills/my-skill');
			mockCustomInstructions.setExternalFolders([externalFolderUri]);

			expect(invokeIsDirExternalAndNeedsConfirmation(externalFolderUri)).toBe(false);
			mockCustomInstructions.setExternalFolders([]);
		});
	});
});
