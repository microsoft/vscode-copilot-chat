/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, expect, it, suite, vi } from 'vitest';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { ITestingServicesAccessor } from '../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { CreateFileTool, ICreateFileParams } from '../../../node/createFileTool';

vi.mock('../../../../../platform/env/common/envService', async (importOriginal) => {
	const original = await importOriginal() as Record<string, unknown>;
	return { ...original, isScenarioAutomation: true };
});

suite('CreateFile Tool', () => {
	let accessor: ITestingServicesAccessor;
	const testDirUri = URI.file('/tmp/test-create-file');

	beforeEach(function () {
		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService, [[testDirUri], []]
		));
		accessor = services.createTestingAccessor();
	});

	it('creates file without stream (headless mode)', async () => {
		const tool = accessor.get(IInstantiationService).createInstance(CreateFileTool);
		const filePath = '/tmp/test-create-file/hello.txt';

		const input: ICreateFileParams = {
			filePath,
			content: 'Hello world\nLine 2\n',
		};

		// Do NOT call resolveInput — simulates headless/tool-call-service mode
		const result = await tool.invoke({ input, toolInvocationToken: undefined }, CancellationToken.None);

		expect(result).toBeDefined();
		expect(result.content).toBeDefined();

		// Verify file was written to mock filesystem
		const mockFs = accessor.get(IFileSystemService) as MockFileSystemService;
		const written = await mockFs.readFile(URI.file(filePath));
		const text = new TextDecoder().decode(written);
		expect(text).toBe('Hello world\nLine 2\n');
	});

	it('creates file with empty content without stream (headless mode)', async () => {
		const tool = accessor.get(IInstantiationService).createInstance(CreateFileTool);
		const filePath = '/tmp/test-create-file/empty.txt';

		const input: ICreateFileParams = {
			filePath,
			content: '',
		};

		// Do NOT call resolveInput — simulates headless/tool-call-service mode
		const result = await tool.invoke({ input, toolInvocationToken: undefined }, CancellationToken.None);

		expect(result).toBeDefined();
		expect(result.content).toBeDefined();

		const mockFs = accessor.get(IFileSystemService) as MockFileSystemService;
		const written = await mockFs.readFile(URI.file(filePath));
		const text = new TextDecoder().decode(written);
		expect(text).toBe('');
	});
});
