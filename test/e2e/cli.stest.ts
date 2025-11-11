/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as path from 'path';
import type { ChatPromptReference } from 'vscode';
import { CopilotCLIModels, CopilotCLISDK, ICopilotCLIModels, ICopilotCLISDK } from '../../src/extension/agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../src/extension/agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../src/extension/agents/copilotcli/node/copilotcliSession';
import { CopilotCLISessionService, ICopilotCLISessionService } from '../../src/extension/agents/copilotcli/node/copilotcliSessionService';
import { PermissionRequest } from '../../src/extension/agents/copilotcli/node/permissionHelpers';
import { ILanguageModelServer, LanguageModelServer } from '../../src/extension/agents/node/langModelServer';
import { MockChatResponseStream, TestChatRequest } from '../../src/extension/test/node/testHelpers';
import { TestingServiceCollection } from '../../src/platform/test/node/services';
import { disposableTimeout, IntervalTimer } from '../../src/util/vs/base/common/async';
import { CancellationToken } from '../../src/util/vs/base/common/cancellation';
import { DisposableStore, IReference } from '../../src/util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../src/util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../src/util/vs/platform/instantiation/common/instantiation';
import { ChatRequest, ChatSessionStatus, Uri } from '../../src/vscodeTypes';
import { ssuite, stest } from '../base/stest';

function registerChatServices(testingServiceCollection: TestingServiceCollection) {
	class TestCopilotCLISDK extends CopilotCLISDK {
		override async ensureNodePtyShim(): Promise<void> {
			// Override to do nothing in tests
		}
	}
	class TestCopilotCLISessionService extends CopilotCLISessionService {
		override async monitorSessionFiles() {
			// Override to do nothing in tests
		}
	}

	testingServiceCollection.define(ICopilotCLISessionService, new SyncDescriptor(TestCopilotCLISessionService));
	testingServiceCollection.define(ICopilotCLIModels, new SyncDescriptor(CopilotCLIModels));
	testingServiceCollection.define(ICopilotCLISDK, new SyncDescriptor(TestCopilotCLISDK));
	testingServiceCollection.define(ILanguageModelServer, new SyncDescriptor(LanguageModelServer));

	const accessor = testingServiceCollection.createTestingAccessor();
	const copilotCLISessionService = accessor.get(ICopilotCLISessionService);
	const instaService = accessor.get(IInstantiationService);
	const promptResolver = instaService.createInstance(CopilotCLIPromptResolver);

	return { sessionService: copilotCLISessionService, promptResolver };
}

function testRunner(cb: (services: { sessionService: ICopilotCLISessionService; promptResolver: CopilotCLIPromptResolver }, stream: MockChatResponseStream, disposables: DisposableStore) => Promise<void>) {
	return async (testingServiceCollection: TestingServiceCollection) => {
		const disposables = new DisposableStore();
		try {
			const services = registerChatServices(testingServiceCollection);
			const stream = new MockChatResponseStream();

			await cb(services, stream, disposables);
		} finally {
			disposables.dispose();
		}
	};
}

const scenariosPath = path.join(__dirname, '..', 'test/scenarios/test-cli');

ssuite.skip({ title: '@cli', location: 'external' }, async (_) => {
	stest({ description: 'can start a session' },
		testRunner(async ({ sessionService }, stream, disposables) => {
			const session = await sessionService.createSession('What is 1+8?', {}, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('What is 1+8?', [], undefined, CancellationToken.None);

			// Verify we have a response of 9.
			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assert.ok(stream.output.join('\n').includes('9'), 'Expected response to include "9"');

			// Can send a subsequent request.
			await session.object.handleRequest('What is 11+25?', [], undefined, CancellationToken.None);
			// Verify we have a response of 36.
			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assert.ok(stream.output.join('\n').includes('36'), 'Expected response to include "36"');
		})
	);

	stest({ description: 'can resume a session' },
		testRunner(async ({ sessionService }, stream, disposables) => {
			let sessionId = '';
			{
				const session = await sessionService.createSession('What is 1+8?', {}, CancellationToken.None);
				sessionId = session.object.sessionId;

				await session.object.handleRequest('What is 1+8?', [], undefined, CancellationToken.None);
				session.dispose();
			}

			{
				const session = await new Promise<IReference<ICopilotCLISession>>((resolve, reject) => {
					const interval = disposables.add(new IntervalTimer());
					interval.cancelAndSet(async () => {
						const session = await sessionService.getSession(sessionId, { readonly: false }, CancellationToken.None);
						if (session) {
							interval.dispose();
							resolve(session);
						}
					}, 50);
					disposables.add(disposableTimeout(() => reject(new Error('Timed out waiting for session')), 5_000));
				});
				disposables.add(session);
				disposables.add(session.object.attachStream(stream));

				await session.object.handleRequest('What was my previous question?', [], undefined, CancellationToken.None);

				// Verify we have a response of 9.
				assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
				assert.ok(stream.output.join('\n').includes('8'), 'Expected response to include "8"');
			}
		})
	);
	stest({ description: 'can read file without permission' },
		testRunner(async ({ sessionService }, stream, disposables) => {
			const workingDirectory = path.join(scenariosPath, 'wkspc1');
			const file = path.join(workingDirectory, 'sample.js');
			const prompt = `Explain the contents of the file '${path.basename(file)}'. There is no need to check for contents in the directory. This file exists on disc.`;
			const session = await sessionService.createSession(prompt, { workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest(prompt, [], undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assert.ok(stream.output.join('\n').includes('add'), 'Expected response to include "add"');
		})
	);
	stest({ description: 'request permission when reading file outside workspace' },
		testRunner(async ({ sessionService }, stream, disposables) => {
			const workingDirectory = path.join(scenariosPath, 'wkspc1');
			const externalFile = path.join(scenariosPath, 'wkspc2', 'foobar.js');
			const prompt = `Explain the contents of the file '${path.basename(externalFile)}'. This file exists on disc but not in the current working directory.`;
			const session = await sessionService.createSession(prompt, { workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));
			let permissionRequested = false;

			session.object.attachPermissionHandler(async (permission: PermissionRequest) => {
				if (permission.kind === 'read' && permission.path.toLowerCase() === externalFile.toLowerCase()) {
					permissionRequested = true;
					return true;
				} else if (permission.kind === 'shell' && (permission.intention.toLowerCase().includes('search') || permission.intention.toLowerCase().includes('find'))) {
					permissionRequested = true;
					return true;
				} else {
					return false;
				}
			});

			await session.object.handleRequest(prompt, [], undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assert.ok(permissionRequested, 'Expected permission to be requested for external file');
		})
	);
	stest({ description: 'can read attachment without permission' },
		testRunner(async ({ sessionService, promptResolver }, stream, disposables) => {
			const workingDirectory = path.join(scenariosPath, 'wkspc1');
			const file = path.join(workingDirectory, 'sample.js');
			const { prompt, attachments } = await resolvePromptWithFileReferences(
				`Explain the contents of the attached file. There is no need to check for contents in the directory. This file exists on disc.`,
				[file],
				promptResolver
			);

			const session = await sessionService.createSession(prompt, { workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest(prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assert.ok(stream.output.join('\n').includes('add'), 'Expected response to include "add"');
		})
	);
});

function createWithRequestWithFileReference(prompt: string, files: string[]): ChatRequest {
	const request = new TestChatRequest(prompt);
	request.references = files.map(file => ({
		id: `file-${file}`,
		name: path.basename(file),
		value: Uri.file(file),
	} satisfies ChatPromptReference));
	return request;
}

function resolvePromptWithFileReferences(prompt: string, files: string[], promptResolver: CopilotCLIPromptResolver): Promise<{ prompt: string; attachments: any[] }> {
	return promptResolver.resolvePrompt(
		createWithRequestWithFileReference(prompt, files),
		CancellationToken.None
	);
}