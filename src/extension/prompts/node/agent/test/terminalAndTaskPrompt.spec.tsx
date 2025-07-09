/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { URI } from '../../../../../util/vs/base/common/uri';
import { TerminalAndTaskStatePromptElement } from '../../base/terminalAndTaskState';

suite('TerminalAndTaskStatePromptElement', () => {
	test('Copilot terminals and tasks', async () => {
		const tasksService: any = {};
		const terminalService: any = {};

		tasksService.getTasks = () => [[null, [
			{
				label: 'npm: build',
				isBackground: false,
				type: 'npm',
				command: 'build',
				script: 'build',
				problemMatcher: ['matcher1'],
				group: { isDefault: true, kind: 'build' },
				dependsOn: 'prebuild',
			},
			{
				label: 'npm: watch',
				isBackground: true,
				type: 'npm',
				command: 'watch',
				script: 'watch',
				problemMatcher: [],
				group: { isDefault: false, kind: 'test' },
			},
		]]];
		tasksService.isTaskActive = () => true;

		terminalService.terminals = [
			{ name: 'Terminal 1', id: '1' },
			{ name: 'Terminal 2', id: '2' },
		];
		terminalService.getCopilotTerminals = async () => [
			{ name: 'Terminal 1', id: '1' },
			{ name: 'Terminal 2', id: '2' },
		];
		terminalService.getLastCommandForTerminal = (term: { id: string }) => {
			if (term.id === '1') {
				return { commandLine: 'npm run build', cwd: '/workspace', exitCode: 0 };
			} else if (term.id === '2') {
				return { commandLine: 'npm test', cwd: '/workspace', exitCode: 1 };
			}
			return undefined;
		};

		const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
		const rendered = await prompt.render();
		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		assert(output.includes('Active Tasks:'));
		assert(output.includes('npm: build'));
		assert(output.includes('npm: watch'));
		assert(output.includes('Terminal 1'));
		assert(output.includes('Terminal 2'));
		assert(output.includes('npm run build'));
		assert(output.includes('npm test'));
		assert(output.includes('/workspace'));
	});
	test('Terminals (non-Copilot) and active tasks', async () => {
		const tasksService: any = {};
		const terminalService: any = {};

		tasksService.getTasks = () => [[null, [
			{
				label: 'npm: build',
				isBackground: false,
				type: 'npm',
				command: 'build',
				script: 'build',
				problemMatcher: ['matcher1'],
				group: { isDefault: true, kind: 'build' },
				dependsOn: 'prebuild',
			},
			{
				label: 'npm: watch',
				isBackground: true,
				type: 'npm',
				command: 'watch',
				script: 'watch',
				problemMatcher: [],
				group: { isDefault: false, kind: 'test' },
			},
		]]];
		tasksService.isTaskActive = () => true;

		terminalService.terminals = [
			{ name: 'Terminal 1', id: '1' },
			{ name: 'Terminal 2', id: '2' },
		];
		terminalService.getCopilotTerminals = async () => [];
		terminalService.getLastCommandForTerminal = (term: { id: string }) => {
			if (term.id === '1') {
				return { commandLine: 'npm run build', cwd: '/workspace', exitCode: 0 };
			} else if (term.id === '2') {
				return { commandLine: 'npm test', cwd: '/workspace', exitCode: 1 };
			}
			return undefined;
		};

		const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
		const rendered = await prompt.render();

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		assert(output.includes('Active Tasks:'));
		assert(output.includes('npm: build'));
		assert(output.includes('npm: watch'));
		assert(output.includes('No active Copilot terminals found.'));
	});
	test('Copilot terminals and no active tasks', async () => {

		const tasksService: any = {};
		const terminalService: any = {};

		const uri = URI.from({ path: '/workspace', scheme: 'file' });
		const tasks: any[] = [];
		tasksService.getTasks = ((workspaceFolder?: URI) => {
			if (workspaceFolder) {
				return tasks;
			}
			return [[uri, tasks]];
		}) as typeof tasksService.getTasks;
		tasksService.isTaskActive = () => true;

		terminalService.terminals = [
			{ name: 'Terminal 1', id: '1' },
			{ name: 'Terminal 2', id: '2' },
		];
		terminalService.getCopilotTerminals = async () => [
			{ name: 'Terminal 1', id: '1' },
			{ name: 'Terminal 2', id: '2' },
		];
		terminalService.getLastCommandForTerminal = (term: any) => {
			if (term.id === '1') {
				return { commandLine: 'npm run build', cwd: '/workspace', exitCode: 0 };
			} else if (term.id === '2') {
				return { commandLine: 'npm test', cwd: '/workspace', exitCode: 1 };
			}
			return undefined;
		};

		const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
		const rendered = await prompt.render();

		// Convert rendered output to string for assertions
		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		assert(output.includes('No active tasks found.'));
		assert(output.includes('Terminal 1'));
		assert(output.includes('Terminal 2'));
		assert(output.includes('npm run build'));
		assert(output.includes('npm test'));
		assert(output.includes('/workspace'));
	});
	test('Neither Copilot terminals nor active tasks', async () => {
		const tasksService: any = {};
		const terminalService: any = {};

		tasksService.getTasks = () => [];
		tasksService.isTaskActive = () => true;

		terminalService.terminals = [
			{ name: 'Terminal 1', id: '1' },
			{ name: 'Terminal 2', id: '2' },
		];
		terminalService.getCopilotTerminals = async () => [];
		terminalService.getLastCommandForTerminal = (term: any) => {
			return undefined;
		};

		const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
		const rendered = await prompt.render();

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		assert(output.includes('No active tasks or Copilot terminals found.'));
	});
});