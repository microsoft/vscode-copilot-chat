/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionOptions } from '@github/copilot/sdk';
import assert from 'assert';
import * as path from 'path';
import type { ChatPromptReference } from 'vscode';
import { CopilotCLIModels, CopilotCLISDK, CopilotCLISessionOptions, ICopilotCLIModels, ICopilotCLISDK } from '../../src/extension/agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../src/extension/agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../src/extension/agents/copilotcli/node/copilotcliSession';
import { CopilotCLISessionService, ICopilotCLISessionService } from '../../src/extension/agents/copilotcli/node/copilotcliSessionService';
import { CopilotCLIMCPHandler, ICopilotCLIMCPHandler } from '../../src/extension/agents/copilotcli/node/mcpHandler';
import { PermissionRequest } from '../../src/extension/agents/copilotcli/node/permissionHelpers';
import { OpenAIAdapterFactoryForSTests } from '../../src/extension/agents/node/adapters/openaiAdapterForSTests';
import { ILanguageModelServer, ILanguageModelServerConfig, LanguageModelServer } from '../../src/extension/agents/node/langModelServer';
import { MockChatResponseStream, TestChatRequest } from '../../src/extension/test/node/testHelpers';
import { IEndpointProvider } from '../../src/platform/endpoint/common/endpointProvider';
import { ILogService } from '../../src/platform/log/common/logService';
import { TestingServiceCollection } from '../../src/platform/test/node/services';
import { createServiceIdentifier } from '../../src/util/common/services';
import { disposableTimeout, IntervalTimer } from '../../src/util/vs/base/common/async';
import { CancellationToken } from '../../src/util/vs/base/common/cancellation';
import { Lazy } from '../../src/util/vs/base/common/lazy';
import { DisposableStore, IReference } from '../../src/util/vs/base/common/lifecycle';
import { Mutable } from '../../src/util/vs/base/common/types';
import { SyncDescriptor } from '../../src/util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../src/util/vs/platform/instantiation/common/instantiation';
import { ChatRequest, ChatSessionStatus, Uri } from '../../src/vscodeTypes';
import { ssuite, stest } from '../base/stest';

function registerChatServices(testingServiceCollection: TestingServiceCollection) {
	const ITestSessionOptionsProvider = createServiceIdentifier<TestSessionOptionsProvider>('ITestSessionOptionsProvider');
	class TestSessionOptionsProvider {
		declare _serviceBrand: undefined;

		private readonly langModelServerConfig: Lazy<Promise<ILanguageModelServerConfig>>;

		constructor(
			@ILanguageModelServer private readonly languageModelServer: ILanguageModelServer,
		) {
			this.langModelServerConfig = new Lazy<Promise<ILanguageModelServerConfig>>(async () => {
				await this.languageModelServer.start();
				return this.languageModelServer.getConfig();
			});
		}

		public async getOptions(): Promise<Pick<SessionOptions, 'authInfo' | 'copilotUrl'>> {
			const serverConfig = await this.langModelServerConfig.value;

			const url = `http://localhost:${serverConfig.port}`;
			const ghToken = serverConfig.nonce;
			process.env.COPILOT_ENABLE_ALT_PROVIDERS = "true";
			process.env.COPILOT_AGENT_MODEL = "sweagent-capi:gpt-5";
			process.env.GH_TOKEN = ghToken;
			process.env.COPILOT_API_URL = url;
			process.env.GITHUB_COPILOT_API_TOKEN = ghToken;
			return {
				authInfo: {
					type: 'env',
					login: '',
					envVar: 'GH_TOKEN',
					token: ghToken,
					host: url
				},
				copilotUrl: url,
			};
		}
	}

	class TestCopilotCLISessionOptions extends CopilotCLISessionOptions {
		constructor(options: { model?: string; isolationEnabled?: boolean; workingDirectory?: string; mcpServers?: SessionOptions['mcpServers'] }, logger: ILogService, private readonly testOptions: Pick<SessionOptions, 'authInfo' | 'copilotUrl' | 'enableStreaming'>) {
			super(options, logger);
		}
		override toSessionOptions() {
			const options = super.toSessionOptions();
			const mutableOptions = options as Mutable<typeof options>;
			mutableOptions.authInfo = this.testOptions.authInfo ?? options.authInfo;
			mutableOptions.copilotUrl = this.testOptions.copilotUrl ?? options.copilotUrl;
			mutableOptions.enableStreaming = true;
			mutableOptions.skipCustomInstructions = true;
			mutableOptions.disableHttpLogging = true;
			return options;
		}
	}

	class TestCopilotCLISDK extends CopilotCLISDK {
		protected override async ensureShims(): Promise<void> {
			// Override to do nothing in tests
		}
		override async getAuthInfo(): Promise<SessionOptions['authInfo']> {
			const testOptionsProvider = this.instantiationService.invokeFunction((accessor) => accessor.get(ITestSessionOptionsProvider));
			const options = await testOptionsProvider.getOptions();
			return options.authInfo;
		}
	}

	const requestHooks: ((body: string) => string)[] = [];
	const responseHooks: ((body: string) => string)[] = [];
	class TestLanguageModelServer extends LanguageModelServer {
		constructor(
			@ILogService logService: ILogService,
			@IEndpointProvider endpointProvider: IEndpointProvider
		) {
			super(logService, endpointProvider);
			const oaiAdapterFactory = new OpenAIAdapterFactoryForSTests();
			this.adapterFactories.set('/chat/completions', oaiAdapterFactory);
			requestHooks.forEach(requestHook => oaiAdapterFactory.addHooks(requestHook));
			responseHooks.forEach(responseHook => oaiAdapterFactory.addHooks(undefined, responseHook));
		}
	}

	class TestCopilotCLISessionService extends CopilotCLISessionService {
		override async monitorSessionFiles() {
			// Override to do nothing in tests
		}
		protected override async createSessionsOptions(options: { model?: string; isolationEnabled?: boolean; workingDirectory?: string; mcpServers?: SessionOptions['mcpServers'] }): Promise<CopilotCLISessionOptions> {
			const testOptionsProvider = this.instantiationService.invokeFunction((accessor) => accessor.get(ITestSessionOptionsProvider));
			const overrideOptions = await testOptionsProvider.getOptions();
			const sessionOptions = new TestCopilotCLISessionOptions(options, this.logService, overrideOptions);

			return sessionOptions;
		}
	}

	testingServiceCollection.define(ICopilotCLISessionService, new SyncDescriptor(TestCopilotCLISessionService));
	testingServiceCollection.define(ITestSessionOptionsProvider, new SyncDescriptor(TestSessionOptionsProvider));
	testingServiceCollection.define(ILanguageModelServer, new SyncDescriptor(TestLanguageModelServer));
	testingServiceCollection.define(ICopilotCLIModels, new SyncDescriptor(CopilotCLIModels));
	testingServiceCollection.define(ICopilotCLISDK, new SyncDescriptor(TestCopilotCLISDK));
	testingServiceCollection.define(ICopilotCLIMCPHandler, new SyncDescriptor(CopilotCLIMCPHandler));

	const accessor = testingServiceCollection.createTestingAccessor();
	const copilotCLISessionService = accessor.get(ICopilotCLISessionService);
	const sdk = accessor.get(ICopilotCLISDK);
	const instaService = accessor.get(IInstantiationService);
	const promptResolver = instaService.createInstance(CopilotCLIPromptResolver);


	return {
		sessionService: copilotCLISessionService, promptResolver, init: async (workingDirectory: string, hook?: (body: string) => string) => {
			if (hook) {
				requestHooks.push(hook);
			}
			requestHooks.push((body: string) => {
				// Replace PID and <current_datetime> values with static values
				body = body.replace(/Current process PID: \d+ - CRITICAL: Do not kill this process or any parent processes as this is your own runtime\./g,
					'Current process PID: 1111 - CRITICAL: Do not kill this process or any parent processes as this is your own runtime.');
				body = body.replace(/<current_datetime>[^<]+<\/current_datetime>/g,
					'<current_datetime>2025-01-01T12:10:00.111Z</current_datetime>');
				return body;
			});

			// Any file/folder reference in body should be replaced with static values
			const folderName = path.basename(workingDirectory);
			const testPath = `/Users/testUser/vscode-copilot-chat/test/scenarios/test-cli/${folderName}`;
			const testPathParent = `/Users/testUser/vscode-copilot-chat/test/scenarios/test-cli`;
			const workingDirectoryParent = path.dirname(workingDirectory);

			function replacePaths(body: string, from: string, to: string) {
				body = body
					// Unix folders that are part of file names, e.g. /folder/file.txt
					.replaceAll(`${from}/`, `${to}/`)
					// Windows folders that are part of file names, e.g. c:\folder\file.txt
					.replaceAll(`${from}\\`, `${to}\\`);

				// Any other references to the working directory
				body = body.replaceAll(from, to);

				// Replace in JSON content, Unix folders that are part of file names, e.g. /folder/file.txt
				from = from.replaceAll('/', '//').replaceAll('\\', '\\\\');
				to = to.replaceAll('/', '//').replaceAll('\\', '\\\\');

				body = body
					// Unix folders that are part of file names, e.g. /folder/file.txt
					.replaceAll(`${from}/`, `${to}/`)
					// Windows folders that are part of file names, e.g. c:\folder\file.txt
					.replaceAll(`${from}\\`, `${to}\\`);
				// Replace in JSON content, Any other references to the working directory
				body = body.replaceAll(from, to);
				return body;
			}

			requestHooks.push((body: string) => {
				body = replacePaths(body, workingDirectory, testPath);
				body = replacePaths(body, workingDirectoryParent, testPathParent);

				// Replace references to vsc-copilot-chat root with test dir
				body = replacePaths(body, vscCopilotRoot, testPath);
				return body;
			});

			responseHooks.push((body: string) => {
				body = replacePaths(body, testPath, workingDirectory);
				body = replacePaths(body, testPathParent, workingDirectoryParent);
				return body;
			});

			await sdk.getPackage();
		}
	};
}

function testRunner(cb: (services: { sessionService: ICopilotCLISessionService; promptResolver: CopilotCLIPromptResolver; init: (workingDirectory: string) => Promise<void> }, stream: MockChatResponseStream, disposables: DisposableStore) => Promise<void>) {
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


const vscCopilotRoot = path.join(__dirname, '..');

// NOTE: Ensure all files/folders/workingDirectories are under test/scenarios/test-cli for path replacements to work correctly.
const scenariosPath = path.join(__dirname, '..', 'test/scenarios/test-cli');

ssuite.skip({ title: '@cli', location: 'external' }, async (_) => {
	stest({ description: 'can start a session' },
		testRunner(async ({ sessionService, init }, stream, disposables) => {
			const workingDirectory = path.join(scenariosPath, 'wkspc1');
			await init(workingDirectory);
			const session = await sessionService.createSession('What is 1+8?', { workingDirectory }, CancellationToken.None);
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
		testRunner(async ({ sessionService, init }, stream, disposables) => {
			const workingDirectory = path.join(scenariosPath, 'wkspc1');
			await init(workingDirectory);

			let sessionId = '';
			// Start session.
			{
				const session = await sessionService.createSession('What is 1+8?', { workingDirectory }, CancellationToken.None);
				sessionId = session.object.sessionId;

				await session.object.handleRequest('What is 1+8?', [], undefined, CancellationToken.None);
				session.dispose();
			}

			// Resume the session.
			{
				const session = await new Promise<IReference<ICopilotCLISession>>((resolve, reject) => {
					const interval = disposables.add(new IntervalTimer());
					interval.cancelAndSet(async () => {
						const session = await sessionService.getSession(sessionId, { readonly: false, workingDirectory }, CancellationToken.None);
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
		testRunner(async ({ sessionService, init }, stream, disposables) => {
			const workingDirectory = path.join(scenariosPath, 'wkspc1');
			await init(workingDirectory);
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
		testRunner(async ({ sessionService, init }, stream, disposables) => {
			const workingDirectory = path.join(scenariosPath, 'wkspc1');
			await init(workingDirectory);

			const externalFile = path.join(scenariosPath, 'wkspc2', 'foobar.js');
			const prompt = `Explain the contents of the file '${externalFile}'. This file exists on disc but not in the current working directory. There's no need to search the directory, just read this file and explain its contents.`;
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
			const streamOutput = stream.output.join('\n');
			assert.ok(permissionRequested, 'Expected permission to be requested for external file, output:' + streamOutput);
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
