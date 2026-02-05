/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, expect, suite, test } from 'vitest';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ContributedToolName } from '../../common/toolNames';
import { IToolsService } from '../../common/toolsService';
import { toolResultToString } from './toolTestUtils';

interface IVSCodeCommitMemoryParams {
subject: string;
fact: string;
citations: string;
reason: string;
category: string;
suggestedContext?: string;
}

suite('VSCodeCommitMemoryTool', () => {
let accessor: ITestingServicesAccessor;
let workspaceFolder: URI;

beforeAll(async () => {
const services = createExtensionUnitTestingServices();

// Set up a test workspace folder
workspaceFolder = URI.file('/tmp/test-workspace');
services.define(IWorkspaceService, new SyncDescriptor(TestWorkspaceService, [[workspaceFolder]]));

accessor = services.createTestingAccessor();
});

afterAll(() => {
accessor.dispose();
});

test('commit memory successfully', async () => {
const toolsService = accessor.get(IToolsService);

const input: IVSCodeCommitMemoryParams = {
subject: 'build-command',
fact: 'npm run build',
citations: 'package.json:10',
reason: 'Build command for the project. This is important for CI/CD and development workflows.',
category: 'bootstrap_and_build'
};

const result = await toolsService.invokeTool(
ContributedToolName.VSCodeCommitMemory,
{ input, toolInvocationToken: null as never },
CancellationToken.None
);
const resultStr = await toolResultToString(accessor, result);

expect(resultStr).toContain('Successfully committed memory');
expect(resultStr).toContain('build-command');
expect(resultStr).toMatch(/memory-\d+-[a-f0-9]{8}\.json/);
});

test('commit memory with suggested context', async () => {
const toolsService = accessor.get(IToolsService);

const input: IVSCodeCommitMemoryParams = {
subject: 'test-pattern',
fact: 'Jest is used for testing',
citations: 'package.json:15',
reason: 'Testing framework preference. This should be documented for new contributors.',
category: 'testing',
suggestedContext: '.github/instructions/testing.instructions.md'
};

const result = await toolsService.invokeTool(
ContributedToolName.VSCodeCommitMemory,
{ input, toolInvocationToken: null as never },
CancellationToken.None
);
const resultStr = await toolResultToString(accessor, result);

expect(resultStr).toContain('Successfully committed memory');
expect(resultStr).toContain('test-pattern');
});

test('verify memory file structure', async () => {
const toolsService = accessor.get(IToolsService);
const fileSystemService = accessor.get(IFileSystemService);

const input: IVSCodeCommitMemoryParams = {
subject: 'indentation',
fact: 'Uses tabs for indentation',
citations: '.editorconfig:3',
reason: 'Coding style preference that must be followed consistently.',
category: 'user_preferences'
};

const result = await toolsService.invokeTool(
ContributedToolName.VSCodeCommitMemory,
{ input, toolInvocationToken: null as never },
CancellationToken.None
);
const resultStr = await toolResultToString(accessor, result);

expect(resultStr).toContain('Successfully committed memory');

// Extract filename from result
const filenameMatch = resultStr.match(/memory-\d+-[a-f0-9]{8}\.json/);
expect(filenameMatch).toBeTruthy();

if (filenameMatch) {
const filename = filenameMatch[0];
const memoriesDir = URI.joinPath(workspaceFolder, '.github', 'pending-memories');
const filePath = URI.joinPath(memoriesDir, filename);

// Verify file exists
const stat = await fileSystemService.stat(filePath);
expect(stat).toBeDefined();

// Read and verify file content
const content = await fileSystemService.readFile(filePath);
const contentStr = new TextDecoder().decode(content);
const memory = JSON.parse(contentStr);

expect(memory.subject).toBe('indentation');
expect(memory.fact).toBe('Uses tabs for indentation');
expect(memory.citations).toBe('.editorconfig:3');
expect(memory.reason).toBe('Coding style preference that must be followed consistently.');
expect(memory.category).toBe('user_preferences');
expect(memory.timestamp).toBeDefined();
expect(memory.id).toBeDefined();
}
});

test('commit multiple memories', async () => {
const toolsService = accessor.get(IToolsService);

const inputs: IVSCodeCommitMemoryParams[] = [
{
subject: 'logging',
fact: 'Use Winston for logging',
citations: 'src/logger.ts:5',
reason: 'Consistent logging framework for the entire project.',
category: 'general'
},
{
subject: 'authentication',
fact: 'Use JWT for authentication',
citations: 'src/auth.ts:10',
reason: 'Authentication mechanism used across all services.',
category: 'general'
}
];

for (const input of inputs) {
const result = await toolsService.invokeTool(
ContributedToolName.VSCodeCommitMemory,
{ input, toolInvocationToken: null as never },
CancellationToken.None
);
const resultStr = await toolResultToString(accessor, result);

expect(resultStr).toContain('Successfully committed memory');
expect(resultStr).toContain(input.subject);
}
});
});

suite('VSCodeCommitMemoryTool without workspace', () => {
let accessor: ITestingServicesAccessor;

beforeAll(() => {
const services = createExtensionUnitTestingServices();
// Mock workspace service to return no folders
const mockWorkspaceService: IWorkspaceService = {
_serviceBrand: undefined,
getWorkspaceFolders: () => [],
getWorkspaceFolderName: () => '',
onDidChangeWorkspaceFolders: () => ({ dispose: () => { } })
} as IWorkspaceService;
services.define(IWorkspaceService, mockWorkspaceService);

accessor = services.createTestingAccessor();
});

afterAll(() => {
accessor.dispose();
});

test('returns error when no workspace folder', async () => {
const toolsService = accessor.get(IToolsService);

const input: IVSCodeCommitMemoryParams = {
subject: 'test',
fact: 'test fact',
citations: 'file.ts:1',
reason: 'test reason for storing this fact.',
category: 'general'
};

const result = await toolsService.invokeTool(
ContributedToolName.VSCodeCommitMemory,
{ input, toolInvocationToken: null as never },
CancellationToken.None
);
const resultStr = await toolResultToString(accessor, result);

expect(resultStr).toContain('Error');
expect(resultStr).toContain('No workspace folder found');
});
});
