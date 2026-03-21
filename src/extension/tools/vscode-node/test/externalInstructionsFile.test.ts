/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatVariablesCollection, CustomizationsIndexId, PromptFileIdPrefix } from '../../../prompt/common/chatVariablesCollection';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { createExtensionTestingServices } from '../../../test/vscode-node/services';
import { assertFileOkForTool, isFileExternalAndNeedsConfirmation, isFileOkForTool } from '../../node/toolUtils';

suite('isExternalInstructionsFile - e2e', function () {
	this.timeout(10000);

	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;
	let testDir: string;
	let workspaceFolder: vscode.WorkspaceFolder;
	let addedWorkspaceFolder: boolean;

	// External file paths (outside the workspace)
	let externalDir: string;
	let instructionFilePath: string;
	let skillFilePath: string;
	let nestedSkillFilePath: string;
	let promptFilePath: string;
	let unrelatedFilePath: string;

	suiteSetup(async () => {
		// Create a temp workspace folder
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-ext-instr-test-'));

		// Create the workspace directory
		const workspaceDir = path.join(testDir, 'workspace');
		fs.mkdirSync(workspaceDir, { recursive: true });
		fs.writeFileSync(path.join(workspaceDir, 'index.ts'), 'export const foo = 1;\n');

		// Create external customization files (outside workspace)
		externalDir = path.join(testDir, 'external');
		fs.mkdirSync(path.join(externalDir, 'instructions'), { recursive: true });
		fs.mkdirSync(path.join(externalDir, 'skills', 'my-skill', 'primitives'), { recursive: true });
		fs.mkdirSync(path.join(externalDir, 'prompts'), { recursive: true });

		instructionFilePath = path.join(externalDir, 'instructions', 'coding-guidelines.instructions.md');
		fs.writeFileSync(instructionFilePath, '# Coding Guidelines\nAlways use tabs.\n');

		skillFilePath = path.join(externalDir, 'skills', 'my-skill', 'SKILL.md');
		fs.writeFileSync(skillFilePath, '# My Skill\nA test skill.\n');

		nestedSkillFilePath = path.join(externalDir, 'skills', 'my-skill', 'primitives', 'agents.md');
		fs.writeFileSync(nestedSkillFilePath, '# Agents\nAgent primitives.\n');

		promptFilePath = path.join(externalDir, 'prompts', 'my-prompt.prompt.md');
		fs.writeFileSync(promptFilePath, '# My Prompt\nDo a thing.\n');

		unrelatedFilePath = path.join(externalDir, 'random.ts');
		fs.writeFileSync(unrelatedFilePath, 'const x = 1;\n');

		// Add workspace folder to VS Code
		if (!vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === workspaceDir)) {
			const index = vscode.workspace.workspaceFolders?.length ?? 0;
			vscode.workspace.updateWorkspaceFolders(index, 0, { uri: vscode.Uri.file(workspaceDir) });
			addedWorkspaceFolder = true;
			await new Promise<void>(resolve => {
				const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
					disposable.dispose();
					resolve();
				});
			});
		}

		workspaceFolder = vscode.workspace.workspaceFolders!.find(f => f.uri.fsPath === workspaceDir)!;
		assert.ok(workspaceFolder, 'Workspace folder should be registered');

		// Set up testing services
		const services = createExtensionTestingServices();
		accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
	});

	suiteTeardown(async () => {
		accessor?.dispose();

		if (addedWorkspaceFolder) {
			const idx = vscode.workspace.workspaceFolders?.findIndex(f => f.uri.fsPath.includes('copilot-ext-instr-test-'));
			if (idx !== undefined && idx >= 0) {
				vscode.workspace.updateWorkspaceFolders(idx, 1);
				await new Promise<void>(resolve => {
					const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
						disposable.dispose();
						resolve();
					});
				});
			}
		}

		// Clean up temp directory
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	function makeBuildPromptContextWithIndex(instructionPaths: string[], skillPaths: string[]): IBuildPromptContext {
		const instructionsXml = instructionPaths
			.map(p => `<instruction><file>${p}</file></instruction>`)
			.join('');
		const skillsXml = skillPaths
			.map(p => `<skill><file>${p}</file></skill>`)
			.join('');

		const indexContent = `<instructions>${instructionsXml}</instructions><skills>${skillsXml}</skills>`;

		const refs: vscode.ChatPromptReference[] = [{
			id: CustomizationsIndexId,
			name: 'customizations',
			value: indexContent,
		}];

		return {
			requestId: `test-${Date.now()}-${Math.random()}`,
			query: 'test',
			history: [],
			chatVariables: new ChatVariablesCollection(refs),
		} as unknown as IBuildPromptContext;
	}

	function makeBuildPromptContextWithPromptFile(fileUri: URI): IBuildPromptContext {
		const refs: vscode.ChatPromptReference[] = [{
			id: `${PromptFileIdPrefix}.${fileUri.fsPath}`,
			name: fileUri.fsPath,
			value: fileUri,
		}];

		return {
			requestId: `test-${Date.now()}-${Math.random()}`,
			query: 'test',
			history: [],
			chatVariables: new ChatVariablesCollection(refs),
		} as unknown as IBuildPromptContext;
	}

	suite('with instructions and skills in customizations index', () => {
		test('workspace file does not need confirmation', async () => {
			const workspaceFileUri = URI.file(path.join(workspaceFolder.uri.fsPath, 'index.ts'));
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, workspaceFileUri)
			);
			assert.strictEqual(result, false);
		});

		test('instruction file listed in index does not need confirmation', async () => {
			const ctx = makeBuildPromptContextWithIndex([instructionFilePath], []);
			const uri = URI.file(instructionFilePath);
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, uri, ctx)
			);
			assert.strictEqual(result, false, 'Instruction file in index should not need confirmation');
		});

		test('skill file listed in index does not need confirmation', async () => {
			const ctx = makeBuildPromptContextWithIndex([], [skillFilePath]);
			const uri = URI.file(skillFilePath);
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, uri, ctx)
			);
			assert.strictEqual(result, false, 'Skill file in index should not need confirmation');
		});

		test('nested file under skill folder does not need confirmation', async () => {
			const ctx = makeBuildPromptContextWithIndex([], [skillFilePath]);
			const uri = URI.file(nestedSkillFilePath);
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, uri, ctx)
			);
			assert.strictEqual(result, false, 'Nested file under skill folder should not need confirmation');
		});

		test('unrelated external file that exists still needs confirmation', async () => {
			const ctx = makeBuildPromptContextWithIndex([instructionFilePath], [skillFilePath]);
			const uri = URI.file(unrelatedFilePath);
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, uri, ctx)
			);
			assert.strictEqual(result, true, 'Unrelated external file should still need confirmation');
		});
	});

	suite('with attached prompt files', () => {
		test('attached prompt file does not need confirmation', async () => {
			const promptUri = URI.file(promptFilePath);
			const ctx = makeBuildPromptContextWithPromptFile(promptUri);
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, promptUri, ctx)
			);
			assert.strictEqual(result, false, 'Attached prompt file should not need confirmation');
		});

		test('file NOT attached as prompt still needs confirmation', async () => {
			const promptUri = URI.file(promptFilePath);
			const otherUri = URI.file(unrelatedFilePath);
			const ctx = makeBuildPromptContextWithPromptFile(promptUri);
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, otherUri, ctx)
			);
			assert.strictEqual(result, true, 'Non-attached file should still need confirmation');
		});
	});

	suite('with special URI schemes', () => {
		test('vscode-chat-internal scheme does not need confirmation', async () => {
			const uri = URI.from({ scheme: 'vscode-chat-internal', path: '/some/resource' });
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, uri)
			);
			assert.strictEqual(result, false);
		});

		test('copilot-skill scheme does not need confirmation', async () => {
			const uri = URI.from({ scheme: 'copilot-skill', path: '/my-skill/SKILL.md' });
			const result = await instantiationService.invokeFunction(
				acc => isFileExternalAndNeedsConfirmation(acc, uri)
			);
			assert.strictEqual(result, false);
		});
	});

	suite('assertFileOkForTool with customization files', () => {
		test('instruction file in index is allowed', async () => {
			const ctx = makeBuildPromptContextWithIndex([instructionFilePath], []);
			const uri = URI.file(instructionFilePath);
			await instantiationService.invokeFunction(
				acc => assertFileOkForTool(acc, uri, ctx)
			);
			// No error thrown means allowed
		});

		test('skill file in index is allowed', async () => {
			const ctx = makeBuildPromptContextWithIndex([], [skillFilePath]);
			const uri = URI.file(skillFilePath);
			await instantiationService.invokeFunction(
				acc => assertFileOkForTool(acc, uri, ctx)
			);
		});

		test('nested skill file under skill folder is allowed', async () => {
			const ctx = makeBuildPromptContextWithIndex([], [skillFilePath]);
			const uri = URI.file(nestedSkillFilePath);
			await instantiationService.invokeFunction(
				acc => assertFileOkForTool(acc, uri, ctx)
			);
		});

		test('external file NOT in index throws', async () => {
			const ctx = makeBuildPromptContextWithIndex([instructionFilePath], [skillFilePath]);
			const uri = URI.file(unrelatedFilePath);
			await assert.rejects(
				() => instantiationService.invokeFunction(acc => assertFileOkForTool(acc, uri, ctx)),
				/outside of the workspace/
			);
		});
	});

	suite('isFileOkForTool with customization files', () => {
		test('instruction file in index returns true', async () => {
			const ctx = makeBuildPromptContextWithIndex([instructionFilePath], []);
			const uri = URI.file(instructionFilePath);
			const result = await instantiationService.invokeFunction(
				acc => isFileOkForTool(acc, uri, ctx)
			);
			assert.strictEqual(result, true, 'Instruction file in index should be OK for tool');
		});

		test('external file NOT in index returns false', async () => {
			const ctx = makeBuildPromptContextWithIndex([instructionFilePath], [skillFilePath]);
			const uri = URI.file(unrelatedFilePath);
			const result = await instantiationService.invokeFunction(
				acc => isFileOkForTool(acc, uri, ctx)
			);
			assert.strictEqual(result, false, 'Unrelated external file should not be OK for tool');
		});
	});
});
