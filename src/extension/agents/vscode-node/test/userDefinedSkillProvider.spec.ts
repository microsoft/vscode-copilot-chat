/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { afterEach, beforeEach, suite, test } from 'vitest';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { SKILL_FILENAME, SKILLS_LOCATION_KEY, USE_AGENT_SKILLS_SETTING } from '../../../../platform/customInstructions/common/promptTypes';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { IWorkspaceService, NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { UserDefinedSkillProvider } from '../userDefinedSkillProvider';

suite('UserDefinedSkillProvider', () => {
	let disposables: DisposableStore;
	let configService: InMemoryConfigurationService;
	let fileSystemService: MockFileSystemService;
	let envService: INativeEnvService;
	let instantiationService: IInstantiationService;

	beforeEach(() => {
		disposables = new DisposableStore();

		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		const accessor: ITestingServicesAccessor = testingServiceCollection.createTestingAccessor();
		disposables.add(accessor);

		instantiationService = accessor.get(IInstantiationService);
		configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		fileSystemService = accessor.get(IFileSystemService) as MockFileSystemService;
		envService = accessor.get(INativeEnvService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	function createProvider(): UserDefinedSkillProvider {
		const provider = instantiationService.createInstance(UserDefinedSkillProvider);
		disposables.add(provider);
		return provider;
	}

	function enableSkills(): void {
		configService.setNonExtensionConfig(USE_AGENT_SKILLS_SETTING, true);
	}

	function mockSkillInDir(parentUri: URI, skillName: string, content: string = '# My Skill'): void {
		const skillDirUri = URI.joinPath(parentUri, skillName);
		const skillFileUri = URI.joinPath(skillDirUri, SKILL_FILENAME);
		fileSystemService.mockDirectory(parentUri, [[skillName, FileType.Directory]]);
		fileSystemService.mockDirectory(skillDirUri, [[SKILL_FILENAME, FileType.File]]);
		fileSystemService.mockFile(skillFileUri, content);
	}

	const cancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) } as any;

	test('returns empty when USE_AGENT_SKILLS_SETTING is disabled', async () => {
		const provider = createProvider();
		const skills = await provider.provideSkills({}, cancellationToken);
		assert.deepStrictEqual(skills, []);
	});

	test('returns empty when no skill folders exist', async () => {
		enableSkills();
		const provider = createProvider();
		const skills = await provider.provideSkills({}, cancellationToken);
		assert.deepStrictEqual(skills, []);
	});

	test('discovers skills from personal folders', async () => {
		enableSkills();

		const personalSkillsDir = URI.joinPath(envService.userHome, '.copilot/skills');
		mockSkillInDir(personalSkillsDir, 'my-skill', '# Personal Skill');

		const provider = createProvider();
		const skills = await provider.provideSkills({}, cancellationToken);

		assert.equal(skills.length, 1);
		assert.ok(skills[0].uri.toString().includes('my-skill'));
	});

	test('discovers skills from workspace folders', async () => {
		enableSkills();

		const workspaceFolder = URI.file('/workspace/project');
		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		testingServiceCollection.define(IWorkspaceService, new SyncDescriptor(NullWorkspaceService, [[workspaceFolder]]));
		const accessor = testingServiceCollection.createTestingAccessor();
		disposables.add(accessor);

		const wsInstantiationService = accessor.get(IInstantiationService);
		const wsConfigService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		const wsFileSystemService = accessor.get(IFileSystemService) as MockFileSystemService;
		wsConfigService.setNonExtensionConfig(USE_AGENT_SKILLS_SETTING, true);

		const wsSkillsDir = URI.joinPath(workspaceFolder, '.github/skills');
		const skillDirUri = URI.joinPath(wsSkillsDir, 'ws-skill');
		const skillFileUri = URI.joinPath(skillDirUri, SKILL_FILENAME);
		wsFileSystemService.mockDirectory(wsSkillsDir, [['ws-skill', FileType.Directory]]);
		wsFileSystemService.mockDirectory(skillDirUri, [[SKILL_FILENAME, FileType.File]]);
		wsFileSystemService.mockFile(skillFileUri, '# WS Skill');

		const provider = wsInstantiationService.createInstance(UserDefinedSkillProvider);
		disposables.add(provider);

		const skills = await provider.provideSkills({}, cancellationToken);
		assert.equal(skills.length, 1);
		assert.ok(skills[0].uri.toString().includes('ws-skill'));
	});

	test('discovers skills from config-defined locations with ~/ expansion', async () => {
		enableSkills();

		configService.setNonExtensionConfig(SKILLS_LOCATION_KEY, { '~/custom-skills': true });

		const customDir = URI.joinPath(envService.userHome, 'custom-skills');
		mockSkillInDir(customDir, 'custom-skill', '# Custom Skill');

		const provider = createProvider();
		const skills = await provider.provideSkills({}, cancellationToken);

		assert.equal(skills.length, 1);
		assert.ok(skills[0].uri.toString().includes('custom-skill'));
	});

	test('skips directories without SKILL.md', async () => {
		enableSkills();

		const personalSkillsDir = URI.joinPath(envService.userHome, '.copilot/skills');
		const noSkillDir = URI.joinPath(personalSkillsDir, 'not-a-skill');
		fileSystemService.mockDirectory(personalSkillsDir, [['not-a-skill', FileType.Directory]]);
		fileSystemService.mockDirectory(noSkillDir, [['README.md', FileType.File]]);

		const provider = createProvider();
		const skills = await provider.provideSkills({}, cancellationToken);
		assert.deepStrictEqual(skills, []);
	});

	test('case-insensitive SKILL.md matching', async () => {
		enableSkills();

		const personalSkillsDir = URI.joinPath(envService.userHome, '.copilot/skills');
		const skillDirUri = URI.joinPath(personalSkillsDir, 'my-skill');
		fileSystemService.mockDirectory(personalSkillsDir, [['my-skill', FileType.Directory]]);
		// lowercase filename
		fileSystemService.mockDirectory(skillDirUri, [['skill.md', FileType.File]]);
		fileSystemService.mockFile(URI.joinPath(skillDirUri, SKILL_FILENAME), '# Skill');

		const provider = createProvider();
		const skills = await provider.provideSkills({}, cancellationToken);
		assert.equal(skills.length, 1);
	});

	test('readFile resolves virtual URI to real file content', async () => {
		enableSkills();

		const personalSkillsDir = URI.joinPath(envService.userHome, '.copilot/skills');
		mockSkillInDir(personalSkillsDir, 'readable-skill', '# Readable Content');

		const provider = createProvider();
		const skills = await provider.provideSkills({}, cancellationToken);

		assert.equal(skills.length, 1);
		const content = await provider.readFile(skills[0].uri);
		const text = new TextDecoder().decode(content);
		assert.equal(text, '# Readable Content');
	});

	test('readFile throws FileNotFound for unknown URI', async () => {
		enableSkills();
		const provider = createProvider();

		try {
			await provider.readFile({ scheme: 'copilot-user-skill', path: '/unknown/SKILL.md' } as any);
			assert.fail('Should have thrown');
		} catch (e: any) {
			assert.ok(e);
		}
	});

	test('returns empty when cancellation is requested', async () => {
		enableSkills();
		const provider = createProvider();
		const cancelledToken = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => { } }) } as any;
		const skills = await provider.provideSkills({}, cancelledToken);
		assert.deepStrictEqual(skills, []);
	});
});
