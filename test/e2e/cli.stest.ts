/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionOptions } from '@github/copilot/sdk';
import assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import { platform, tmpdir } from 'os';
import * as path from 'path';
import type { ChatPromptReference } from 'vscode';
import { ChatDelegationSummaryService, IChatDelegationSummaryService } from '../../src/extension/agents/copilotcli/common/delegationSummaryService';
import { CopilotCLIAgents, CopilotCLIModels, CopilotCLISDK, CopilotCLISessionOptions, ICopilotCLIAgents, ICopilotCLIModels, ICopilotCLISDK } from '../../src/extension/agents/copilotcli/node/copilotCli';
import { CopilotCLIImageSupport } from '../../src/extension/agents/copilotcli/node/copilotCLIImageSupport';
import { CopilotCLIPromptResolver } from '../../src/extension/agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../src/extension/agents/copilotcli/node/copilotcliSession';
import { CopilotCLISessionService, ICopilotCLISessionService } from '../../src/extension/agents/copilotcli/node/copilotcliSessionService';
import { CopilotCLIMCPHandler, ICopilotCLIMCPHandler } from '../../src/extension/agents/copilotcli/node/mcpHandler';
import { PermissionRequest } from '../../src/extension/agents/copilotcli/node/permissionHelpers';
import { OpenAIAdapterFactoryForSTests } from '../../src/extension/agents/node/adapters/openaiAdapterForSTests';
import { ILanguageModelServer, ILanguageModelServerConfig, LanguageModelServer } from '../../src/extension/agents/node/langModelServer';
import { ChatSummarizerProvider } from '../../src/extension/prompt/node/summarizer';
import { MockChatResponseStream, TestChatRequest } from '../../src/extension/test/node/testHelpers';
import { IEndpointProvider } from '../../src/platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../src/platform/filesystem/common/fileSystemService';
import { NodeFileSystemService } from '../../src/platform/filesystem/node/fileSystemServiceImpl';
import { ILogService } from '../../src/platform/log/common/logService';
import { TestingServiceCollection } from '../../src/platform/test/node/services';
import { IQualifiedFile, SimulationWorkspace } from '../../src/platform/test/node/simulationWorkspace';
import { createServiceIdentifier } from '../../src/util/common/services';
import { ChatReferenceDiagnostic } from '../../src/util/common/test/shims/chatTypes';
import { disposableTimeout, IntervalTimer } from '../../src/util/vs/base/common/async';
import { CancellationToken } from '../../src/util/vs/base/common/cancellation';
import { Lazy } from '../../src/util/vs/base/common/lazy';
import { DisposableStore, IReference } from '../../src/util/vs/base/common/lifecycle';
import { Mutable } from '../../src/util/vs/base/common/types';
import { URI } from '../../src/util/vs/base/common/uri';
import { SyncDescriptor } from '../../src/util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../src/util/vs/platform/instantiation/common/instantiation';
import { ChatRequest, ChatSessionStatus, Diagnostic, DiagnosticSeverity, Location, Range, Uri } from '../../src/vscodeTypes';
import { ssuite, stest } from '../base/stest';
import { IMcpService, NullMcpService } from '../../src/platform/mcp/common/mcpService';

const keys = ['COPILOT_ENABLE_ALT_PROVIDERS', 'COPILOT_AGENT_MODEL', 'GH_TOKEN', 'COPILOT_API_URL', 'GITHUB_COPILOT_API_TOKEN'];
const originalValues: Record<string, string | undefined> = {};
for (const key of keys) {
	originalValues[key] = process.env[key];
}

function restoreEnvVariables() {
	for (const key of keys) {
		process.env[key] = originalValues[key];
	}
}

let testCounter = 0;
function trackEnvVariablesBeforeTests() {
	testCounter++;
}

/**
 * Tests run in parallel, so only restore env variables after all tests have completed.
 */
function restoreEnvVariablesAfterTests() {
	testCounter--;
	if (testCounter === 0) {
		restoreEnvVariables();
	}
}

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
			process.env.COPILOT_ENABLE_ALT_PROVIDERS = 'true';
			process.env.COPILOT_AGENT_MODEL = 'sweagent-capi:gpt-5';
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
		constructor(options: { model?: string; isolationEnabled?: boolean; workingDirectory?: Uri; mcpServers?: SessionOptions['mcpServers'] }, logger: ILogService, private readonly testOptions: Pick<SessionOptions, 'authInfo' | 'copilotUrl'>) {
			super(options, logger);
		}
		override toSessionOptions() {
			const options = super.toSessionOptions();
			const mutableOptions = options as Mutable<typeof options>;
			mutableOptions.authInfo = this.testOptions.authInfo ?? options.authInfo;
			mutableOptions.copilotUrl = this.testOptions.copilotUrl ?? options.copilotUrl;
			mutableOptions.enableStreaming = true;
			mutableOptions.skipCustomInstructions = true;
			return options;
		}
	}

	class TestCopilotCLISDK extends CopilotCLISDK {
		protected override async ensureShims(): Promise<void> {
			// Override to do nothing in tests
		}
		override async getAuthInfo(): Promise<NonNullable<SessionOptions['authInfo']>> {
			const testOptionsProvider = this.instantiationService.invokeFunction((accessor) => accessor.get(ITestSessionOptionsProvider));
			const options = await testOptionsProvider.getOptions();
			return options.authInfo!;
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
			this.requestHandlers.set('/graphql', { method: 'POST', handler: this.graphqlHandler.bind(this) });
			this.requestHandlers.set('/models', { method: 'GET', handler: this.modelsHandler.bind(this) });
		}

		private async graphqlHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			const data = {
				viewer: {
					login: '',
					copilotEndpoints: {
						api: `http://localhost:${this.config.port}`
					}
				}
			};
			res.end(JSON.stringify({ data }));
		}
		private async modelsHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
			res.writeHead(200, { 'Content-Type': 'application/json', 'x-github-request-id': 'TESTREQUESTID1234' });
			const endpoints = await this.endpointProvider.getAllChatEndpoints();
			const data = endpoints.map(e => {
				return {
					id: e.model,
					name: e.model,
					capabilities: {
						supports: {
							vision: e.supportsVision,
						},
						limits: {
							max_prompt_tokens: e.modelMaxPromptTokens,
							max_context_window_tokens: e.maxOutputTokens,
						}
					}
				};
			});
			res.end(JSON.stringify({ data }));
		}
	}

	class TestCopilotCLISessionService extends CopilotCLISessionService {
		override async monitorSessionFiles() {
			// Override to do nothing in tests
		}
		protected override async createSessionsOptions(options: { model?: string; isolationEnabled?: boolean; workingDirectory?: Uri; mcpServers?: SessionOptions['mcpServers'] }): Promise<CopilotCLISessionOptions> {
			const testOptionsProvider = this.instantiationService.invokeFunction((accessor) => accessor.get(ITestSessionOptionsProvider));
			const overrideOptions = await testOptionsProvider.getOptions();
			const sessionOptions = new TestCopilotCLISessionOptions(options, this.logService, overrideOptions);

			return sessionOptions;
		}
	}

	let accessor = testingServiceCollection.clone().createTestingAccessor();
	let instaService = accessor.get(IInstantiationService);
	const summarizer = instaService.createInstance(ChatSummarizerProvider);
	const delegatingSummarizerProvider = instaService.createInstance(ChatDelegationSummaryService, summarizer);
	testingServiceCollection.define(ICopilotCLISessionService, new SyncDescriptor(TestCopilotCLISessionService));
	testingServiceCollection.define(ITestSessionOptionsProvider, new SyncDescriptor(TestSessionOptionsProvider));
	testingServiceCollection.define(ILanguageModelServer, new SyncDescriptor(TestLanguageModelServer));
	testingServiceCollection.define(ICopilotCLIModels, new SyncDescriptor(CopilotCLIModels));
	testingServiceCollection.define(ICopilotCLISDK, new SyncDescriptor(TestCopilotCLISDK));
	testingServiceCollection.define(ICopilotCLIAgents, new SyncDescriptor(CopilotCLIAgents));
	testingServiceCollection.define(ICopilotCLIMCPHandler, new SyncDescriptor(CopilotCLIMCPHandler));
	testingServiceCollection.define(IMcpService, new SyncDescriptor(NullMcpService));
	testingServiceCollection.define(IFileSystemService, new SyncDescriptor(NodeFileSystemService));
	testingServiceCollection.define(IChatDelegationSummaryService, delegatingSummarizerProvider);
	const simulationWorkspace = new SimulationWorkspace();
	simulationWorkspace.setupServices(testingServiceCollection);

	accessor = testingServiceCollection.createTestingAccessor();
	const copilotCLISessionService = accessor.get(ICopilotCLISessionService);
	const sdk = accessor.get(ICopilotCLISDK);
	instaService = accessor.get(IInstantiationService);
	const imageSupport = instaService.createInstance(CopilotCLIImageSupport);
	const promptResolver = instaService.createInstance(CopilotCLIPromptResolver, imageSupport);

	async function populateWorkspaceFiles(workingDirectory: string) {
		const fileLanguages = new Map<string, string>([
			['.js', 'javascript'],
			['.ts', 'typescript'],
			['.py', 'python'],
		]);
		const workspaceUri = Uri.file(workingDirectory);
		// Enumerate all files and folders under workingDirectory

		const files: Uri[] = [];
		const folders: Uri[] = [];
		await fs.readdir(workingDirectory, { withFileTypes: true }).then((dirents) => {
			for (const dirent of dirents) {
				const fullPath = path.join(workingDirectory, dirent.name);
				if (dirent.isFile()) {
					files.push(Uri.file(fullPath));
				} else if (dirent.isDirectory()) {
					folders.push(Uri.file(fullPath));
				}
			}
		});

		const fileList = await Promise.all(files.map(async (fileUri) => {
			const content = await fs.readFile(fileUri.fsPath, 'utf-8');
			return {
				uri: fileUri,
				fileContents: content,
				kind: 'qualifiedFile',
				languageId: fileLanguages.get(path.extname(fileUri.fsPath)),
			} satisfies IQualifiedFile;
		}));
		simulationWorkspace.resetFromFiles(fileList, [workspaceUri]);
	}

	function registerHooks(workingDirectory: string) {
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
	}

	return {
		sessionService: copilotCLISessionService, promptResolver, init: async (workingDirectory: URI) => {
			if (platform() !== 'win32') {
				// Paths conversions are only done for non-Windows platforms.
				// Hooks are used to ensure we have stable paths on linux/macOS, so that request/responses can be cached.
				registerHooks(workingDirectory.fsPath);
			}

			await populateWorkspaceFiles(workingDirectory.fsPath);
			await sdk.getPackage();
		}
	};
}

const vscCopilotRoot = path.join(__dirname, '..');
// NOTE: Ensure all files/folders/workingDirectories are under test/scenarios/test-cli for path replacements to work correctly.
const sourcePath = path.join(__dirname, '..', 'test', 'scenarios', 'test-cli');
let tmpDirCounter = 0;
function testRunner(cb: (services: { sessionService: ICopilotCLISessionService; promptResolver: CopilotCLIPromptResolver; init: (workingDirectory: URI) => Promise<void> }, scenariosPath: string, stream: MockChatResponseStream, disposables: DisposableStore) => Promise<void>) {
	return async (testingServiceCollection: TestingServiceCollection) => {
		trackEnvVariablesBeforeTests();
		const disposables = new DisposableStore();
		// Temp folder can be `/var/folders/....` in our code we use `realpath` to resolve any symlinks.
		// That results in these temp folders being resolved as `/private/var/folders/...` on macOS.
		const scenariosPath = path.join(tmpdir() + tmpDirCounter++, 'vscode-copilot-chat', 'test-cli');
		await fs.rm(scenariosPath, { recursive: true, force: true }).catch(() => { /* Ignore */ });
		await fs.mkdir(scenariosPath, { recursive: true });
		await fs.cp(sourcePath, scenariosPath, { recursive: true, force: true, errorOnExist: false });
		try {
			const services = registerChatServices(testingServiceCollection);
			const stream = new MockChatResponseStream();

			await cb(services, await fs.realpath(scenariosPath), stream, disposables);
		} finally {
			await fs.rm(scenariosPath, { recursive: true }).catch(() => { /* Ignore */ });
			restoreEnvVariablesAfterTests();
			disposables.dispose();
		}
	};
}

function assertStreamContains(stream: MockChatResponseStream, expectedContent: string, message?: string) {
	const output = stream.output.join('\n');
	assert.ok(output.includes(expectedContent), message ?? `Expected response to include "${expectedContent}", actual output: ${output}`);
}

function assertNoErrorsInStream(stream: MockChatResponseStream) {
	const output = stream.output.join('\n');
	assert.ok(!output.includes('❌'), `Expected no errors in stream, actual output: ${output}`);
	assert.ok(!output.includes('Error'), `Expected no errors in stream, actual output: ${output}`);
}

async function assertFileContains(filePath: string, expectedContent: string, exactCount?: number) {
	const fileContent = await fs.readFile(filePath, 'utf-8');
	assert.ok(fileContent.includes(expectedContent), `Expected to contain "${expectedContent}", contents = ${fileContent}`);
	if (typeof exactCount === 'number') {
		const actualCount = Array.from(fileContent.matchAll(new RegExp(expectedContent, 'g'))).length;
		assert.strictEqual(actualCount, exactCount, `Expected to find "${expectedContent}" exactly ${exactCount} times, but found ${actualCount} times in contents = ${fileContent}`);
	}
}

async function assertFileNotContains(filePath: string, expectedContent: string) {
	const fileContent = await fs.readFile(filePath, 'utf-8');
	assert.ok(!fileContent.includes(expectedContent), `Expected not to contain "${expectedContent}", contents = ${fileContent}`);
}

ssuite.skip({ title: '@cli', location: 'external' }, async (_) => {
	stest({ description: 'can start a session' },
		testRunner(async ({ sessionService, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', 'What is 1+8?', [], undefined, CancellationToken.None);

			// Verify we have a response of 9.
			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			assertStreamContains(stream, '9');

			// Can send a subsequent request.
			await session.object.handleRequest('', 'What is 11+25?', [], undefined, CancellationToken.None);
			// Verify we have a response of 36.
			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			assertStreamContains(stream, '36');
		})
	);

	stest({ description: 'can resume a session' },
		testRunner(async ({ sessionService, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);

			let sessionId = '';
			// Start session.
			{
				const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
				sessionId = session.object.sessionId;

				await session.object.handleRequest('', 'What is 1+8?', [], undefined, CancellationToken.None);
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

				await session.object.handleRequest('', 'What was my previous question?', [], undefined, CancellationToken.None);

				// Verify we have a response of 9.
				assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
				assertNoErrorsInStream(stream);
				assertStreamContains(stream, '8');
			}
		})
	);
	stest({ description: 'can read file without permission' },
		testRunner(async ({ sessionService, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const file = URI.joinPath(workingDirectory, 'sample.js');
			const prompt = `Explain the contents of the file '${path.basename(file.fsPath)}'. There is no need to check for contents in the directory. This file exists on disc.`;
			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', prompt, [], undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			assertStreamContains(stream, 'add');
		})
	);
	stest({ description: 'request permission when reading file outside workspace' },
		testRunner(async ({ sessionService, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);

			const externalFile = path.join(scenariosPath, 'wkspc2', 'foobar.js');
			const prompt = `Explain the contents of the file '${externalFile}'. This file exists on disc but not in the current working directory. There's no need to search the directory, just read this file and explain its contents.`;
			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));
			let permissionRequested = false;

			disposables.add(session.object.attachPermissionHandler(async (permission: PermissionRequest) => {
				if (permission.kind === 'read' && permission.path.toLowerCase() === externalFile.toLowerCase()) {
					permissionRequested = true;
					return true;
				} else if (permission.kind === 'shell' && (permission.intention.toLowerCase().includes('search') || permission.intention.toLowerCase().includes('find'))) {
					permissionRequested = true;
					return true;
				} else {
					return false;
				}
			}));

			await session.object.handleRequest('', prompt, [], undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			const streamOutput = stream.output.join('\n');
			assert.ok(permissionRequested, 'Expected permission to be requested for external file, output:' + streamOutput);
		})
	);
	stest({ description: 'can read attachment without permission' },
		testRunner(async ({ sessionService, promptResolver, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const file = URI.joinPath(workingDirectory, 'sample.js').fsPath;
			const { prompt, attachments } = await resolvePromptWithFileReferences(
				`Explain the contents of the attached file. There is no need to check for contents in the directory. This file exists on disc.`,
				[file],
				promptResolver
			);

			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			assertStreamContains(stream, 'add');
		})
	);
	stest({ description: 'can edit file' },
		testRunner(async ({ sessionService, promptResolver, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const file = URI.joinPath(workingDirectory, 'sample.js').fsPath;
			let { prompt, attachments } = await resolvePromptWithFileReferences(
				`Remove comments form add function and add a subtract function to #file:sample.js.`,
				[file],
				promptResolver
			);

			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			await assertFileNotContains(file, 'Sample function to add two values');
			await assertFileContains(file, 'function subtract', 1);
			await assertFileContains(file, 'function add', 1);

			// Multi-turn edit
			({ prompt, attachments } = await resolvePromptWithFileReferences(
				`Now add a divide function.`,
				[],
				promptResolver
			));
			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			// Ensure previous edits are preserved (in past there have been cases where SDK applies edits again)
			await assertFileNotContains(file, 'Sample function to add two values');
			await assertFileContains(file, 'function subtract', 1);
			await assertFileContains(file, 'function add', 1);
		})
	);
	stest({ description: 'explain selection' },
		testRunner(async ({ sessionService, promptResolver, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const file = URI.joinPath(workingDirectory, 'utils.js').fsPath;

			const { prompt, attachments } = await resolvePromptWithFileReferences(
				`explain what the selected statement does`,
				[createFileSelectionReference(file, new Range(10, 0, 10, 10))],
				promptResolver
			);

			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertStreamContains(stream, 'throw');
		})
	);
	stest({ description: 'can create a file' },
		testRunner(async ({ sessionService, promptResolver, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const { prompt, attachments } = await resolvePromptWithFileReferences(
				`Create a file named math.js that contains a function to compute square of a number.`,
				[],
				promptResolver
			);

			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			await assertFileContains(URI.joinPath(workingDirectory, 'math.js').fsPath, 'function', 1);
		})
	);
	stest({ description: 'can list files in directory' },
		testRunner(async ({ sessionService, promptResolver, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const { prompt, attachments } = await resolvePromptWithFileReferences(
				`What files are in the current directory.`,
				[],
				promptResolver
			);

			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			assertStreamContains(stream, 'sample.js');
			assertStreamContains(stream, 'utils.js');
			assertStreamContains(stream, 'stringUtils.js');
			assertStreamContains(stream, 'demo.py');
		})
	);
	stest({ description: 'can fix problems' },
		testRunner(async ({ sessionService, promptResolver, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const file = URI.joinPath(workingDirectory, 'stringUtils.js').fsPath;
			const diag = new Diagnostic(new Range(7, 0, 7, 1), '} expected', DiagnosticSeverity.Error);
			const { prompt, attachments } = await resolvePromptWithFileReferences(
				`Fix the problem`,
				[createDiagnosticReference(file, [diag])],
				promptResolver
			);
			let contents = await fs.readFile(file, 'utf-8');
			assert.ok(!contents.trim().endsWith('}'), '} is missing');
			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertNoErrorsInStream(stream);
			contents = await fs.readFile(file, 'utf-8');
			assert.ok(contents.trim().endsWith('}'), `} has not been added, contents = ${contents}`);
		})
	);

	stest({ description: 'can fix multiple problems in multiple files' },
		testRunner(async ({ sessionService, promptResolver, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);
			const tsFile = URI.joinPath(workingDirectory, 'stringUtils.js').fsPath;
			const tsDiag = new Diagnostic(new Range(7, 0, 7, 1), '} expected', DiagnosticSeverity.Error);
			const pyFile = URI.joinPath(workingDirectory, 'demo.py').fsPath;
			const pyDiag1 = new Diagnostic(new Range(3, 21, 3, 21), 'Expected \':\', found new line', DiagnosticSeverity.Error);
			const pyDiag2 = new Diagnostic(new Range(19, 13, 19, 13), 'Statement ends with an unnecessary semicolon', DiagnosticSeverity.Warning);

			const { prompt, attachments } = await resolvePromptWithFileReferences(
				`Fix the problem`,
				[createDiagnosticReference(tsFile, [tsDiag]), createDiagnosticReference(pyFile, [pyDiag1, pyDiag2])],
				promptResolver
			);
			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));

			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			const tsContents = await fs.readFile(tsFile, 'utf-8');
			assert.ok(tsContents.trim().endsWith('}'), `} has not been added, contents = ${tsContents}`);
			assertFileContains(pyFile, 'def printFibb(nterms):');
			assertFileNotContains(pyFile, 'printFibb(34);');
		})
	);

	stest({ description: 'can run terminal commands' },
		testRunner(async ({ sessionService, promptResolver, init }, scenariosPath, stream, disposables) => {
			const workingDirectory = URI.file(path.join(scenariosPath, 'wkspc1'));
			await init(workingDirectory);

			const command = platform() === 'win32' ? 'Get-Location' : 'pwd';
			const { prompt, attachments } = await resolvePromptWithFileReferences(
				`Use terminal command '${command}' to determine my current directory`,
				[],
				promptResolver
			);
			const session = await sessionService.createSession({ workingDirectory }, CancellationToken.None);
			disposables.add(session);
			disposables.add(session.object.attachStream(stream));
			disposables.add(session.object.attachPermissionHandler(async (permission: PermissionRequest) => {
				if (permission.kind === 'read') {
					return true;
				} else if (permission.kind === 'shell' && permission.fullCommandText.toLowerCase().includes(command.toLowerCase())) {
					return true;
				} else {
					return false;
				}
			}));

			await session.object.handleRequest('', prompt, attachments, undefined, CancellationToken.None);

			assertNoErrorsInStream(stream);
			assert.strictEqual(session.object.status, ChatSessionStatus.Completed);
			assertStreamContains(stream, 'wkspc1');
		})
	);
});

function createWithRequestWithFileReference(prompt: string, filesOrReferences: (string | ChatPromptReference)[]): ChatRequest {
	const request = new TestChatRequest(prompt);
	request.references = filesOrReferences.map(file => {
		if (typeof file !== 'string') {
			return file;
		}
		return createFileReference(file);
	});
	return request;
}

function createFileReference(file: string): ChatPromptReference {
	return {
		id: `file-${file}`,
		name: `file:${path.basename(file)}`,
		value: Uri.file(file),
	} satisfies ChatPromptReference;
}

function createFileSelectionReference(file: string, range: Range): ChatPromptReference {
	const uri = Uri.file(file);
	return {
		id: `file-${file}`,
		name: `file:${path.basename(file)}`,
		value: new Location(uri, range),
	} satisfies ChatPromptReference;
}

function createDiagnosticReference(file: string, diag: Diagnostic[]): ChatPromptReference {
	const uri = Uri.file(file);
	return {
		id: `file-${file}`,
		name: `file:${path.basename(file)}`,
		value: new ChatReferenceDiagnostic([[uri, diag]]),
	} satisfies ChatPromptReference;
}


function resolvePromptWithFileReferences(prompt: string, filesOrReferences: (string | ChatPromptReference)[], promptResolver: CopilotCLIPromptResolver): Promise<{ prompt: string; attachments: any[] }> {
	return promptResolver.resolvePrompt(createWithRequestWithFileReference(prompt, filesOrReferences), undefined, [], false, undefined, CancellationToken.None);
}
