/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Config, ConfigKey } from '../../../platform/configuration/common/configurationService';
import { packageJson } from '../../../platform/env/common/packagejson';

describe('Configurations', () => {
	it('package.json configuration contains stable, experimental, and preview sections', () => {
		const configurationContributions = packageJson.contributes.configuration;

		// Should have 3 sections
		expect(configurationContributions, 'package.json should have exactly 3 sections').toHaveLength(3);

		// Should have a stable section
		const stableSection = configurationContributions.find(section => section.id === 'stable');
		const preview = configurationContributions.find(section => section.id === 'preview');
		const experimental = configurationContributions.find(section => section.id === 'experimental');

		expect(stableSection, 'stable configuration section is missing').toBeDefined();
		expect(preview, 'preview configuration section is missing').toBeDefined();
		expect(experimental, 'experimental configuration section is missing').toBeDefined();
	});

	it('package.json configuration tags are correct for each section', () => {
		const configurationContributions = packageJson.contributes.configuration;

		// Should have a stable section
		const stableSection = configurationContributions.find(section => section.id === 'stable')!;
		const preview = configurationContributions.find(section => section.id === 'preview')!;
		const experimental = configurationContributions.find(section => section.id === 'experimental')!;

		for (const section of [stableSection, preview, experimental]) {
			const sectionSettings = Object.keys(section?.properties);

			for (const settingId of sectionSettings) {
				const setting = section.properties[settingId];
				if (section.id === 'stable') {
					expect(setting.tags ?? [], settingId).not.toContain('preview');
					expect(setting.tags ?? [], settingId).not.toContain('experimental');
				} else {
					expect(setting.tags ?? [], settingId).toContain(section.id);
				}
			}
		}
	});


	it('settings in code should match package.json', () => {
		const configurationsInPackageJson = packageJson.contributes.configuration.flatMap(section => Object.keys(section.properties));

		// Get keys from code
		const publicConfigs = Object.values(ConfigKey).filter(key => key !== ConfigKey.Internal && key !== ConfigKey.Shared) as Config<any>[];
		const internalKeys = Object.values(ConfigKey.Internal).map(setting => setting.fullyQualifiedId);
		const sharedKeys = Object.values(ConfigKey.Shared).map(setting => setting.fullyQualifiedId);
		const publicKeys = publicConfigs.map(setting => setting.fullyQualifiedId);

		// Validate Internal and Shared settings are not in package.json
		[...internalKeys, ...sharedKeys].forEach(key => {
			expect(configurationsInPackageJson, 'Internal settings and those shared with the completions extension should not be defined in the package.json').not.toContain(key);
		});

		// Validate Internal settings have the correct prefix
		internalKeys.forEach(key => {
			expect(key, 'Internal settings must start with github.copilot.chat.advanced.').toMatch(/^github\.copilot\.chat\.advanced\./);
		});

		// Validate public settings in code are in package.json
		publicKeys.forEach(key => {
			expect(configurationsInPackageJson, 'Setting in code is not defined in the package.json').toContain(key);
		});

		// Validate settings in package.json are in code
		configurationsInPackageJson.forEach(key => {
			expect(publicKeys, 'Setting in package.json is not defined in code').toContain(key);
		});
	});

	it('all localization strings in package.json are present in package.nls.json', async () => {
		// Get all keys from package.nls.json
		const packageJsonPath = path.join(__dirname, '../../../../package.json');
		const packageNlsPath = path.join(__dirname, '../../../../package.nls.json');
		const [packageJsonFileContents, packageNlsFileContents] = await Promise.all(
			[
				fs.promises.readFile(packageJsonPath, 'utf-8'),
				fs.promises.readFile(packageNlsPath, 'utf-8'),
			]
		);

		const packageNls = JSON.parse(packageNlsFileContents);
		const nlsKeys = Object.keys(packageNls);

		// Find all %key% references in package.json
		const nlsReferences = Array.from(packageJsonFileContents.matchAll(/"%([^"]+)%"/g)).map(match => match[1]);

		// Validate all references exist in package.nls.json
		const missingKeys = nlsReferences.filter(key => !nlsKeys.includes(key));
		if (missingKeys.length > 0) {
			throw new Error(`Missing localization keys in package.nls.json but present in package.json: ${missingKeys.map(key => `'%${key}%'`).join(', ')}`);
		}
	});
});
