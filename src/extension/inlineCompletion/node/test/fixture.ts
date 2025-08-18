/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fsSync from 'fs';
import { load as yaml } from 'js-yaml';
import * as path from 'path';
import { Copilot } from '../../../../platform/inlineCompletions/common/api';
import { PromptOptions } from '../../../inlineCompletionPrompt/common/prompt';

export interface Fixture {
	name: string;
	performance: FixturePerformance;
	state: FixtureState;
	options?: Partial<PromptOptions>;
	expectedPrompt: TestablePrompt;
}

export interface FixturePerformance {
	// The number of samples for a single test when executed in performance tests
	samples: number;
	// The mean of the max times for each run a test must pass
	meanMaxMs: number;
}

export type TestablePrompt = {
	prefix: string;
	suffix: string;
	trailingWs?: string;
};

export interface FixtureState {
	currentFile: OpenFile;
	openFiles: OpenFile[];
	contextItems?: FixtureContextItems;
}
export interface FixtureContextItems {
	codeSnippets?: Copilot.CodeSnippet[];
	traits?: Copilot.Trait[];
}

export interface OpenFile {
	uri: string;
	language?: string;
	text: string;
}

export function fixtureFromFile(fileName: string): Fixture {
	const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
	const yamlFixture = fsSync.readFileSync(fixturePath, 'utf-8');
	const fixture = convertKeysToCamelCase(yaml(yamlFixture) as YamlStructure) as unknown as Fixture;

	if (!fixture.state.openFiles) {
		fixture.state.openFiles = [];
	}

	if (!fixture.expectedPrompt.prefix) {
		fixture.expectedPrompt.prefix = '';
	}

	if (!fixture.expectedPrompt.suffix) {
		fixture.expectedPrompt.suffix = '';
	}

	fixture.performance = {
		samples: fixture.performance?.samples ?? 100,
		meanMaxMs: fixture.performance?.meanMaxMs ?? 20,
	};

	return fixture;
}

export function listFixtures(additionalFilters: string[]): string[] {
	return fsSync
		.readdirSync(path.resolve(__dirname, 'fixtures'))
		.filter(file => file.endsWith('.fixture.yml'))
		.filter(file => additionalFilters.length === 0 || additionalFilters.some(filter => file.includes(filter)))
		.sort();
}

type YamlStructure = { [key: string]: YamlStructure } | YamlStructure[] | string | number | boolean | null;
function convertKeysToCamelCase(obj: YamlStructure): YamlStructure {
	if (typeof obj !== 'object' || obj === null) {
		if (typeof obj === 'string') {
			return inline(obj);
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map(convertKeysToCamelCase);
	}

	const newObj: { [key: string]: YamlStructure } = {};

	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			newObj[hyphenToCamelCase(key)] = convertKeysToCamelCase(obj[key]);
		}
	}

	return newObj;
}

function hyphenToCamelCase(str: string): string {
	return str.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

// Replace file paths with their content. Path is relative to the fixtures folder.
const filePathRegex = /\${file:(.*)}/g;
function inline(text: string): string {
	if (filePathRegex.test(text)) {
		return text.replace(filePathRegex, (_, pathSegment: string) => {
			const filePath = path.resolve(__dirname, 'fixtures', pathSegment);
			return fsSync.readFileSync(filePath, 'utf-8');
		});
	}
	return text;
}
