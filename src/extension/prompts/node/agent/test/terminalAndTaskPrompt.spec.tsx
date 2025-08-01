/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { URI } from '../../../../../util/vs/base/common/uri';
import { TerminalAndTaskStatePromptElement } from '../../base/terminalAndTaskState';

suite('TerminalAndTaskStatePromptElement', () => {
	const tasksService: any = {};
	tasksService.getTerminalForTask = (task: any) => {
		if (task.command === 'build') {
			return { name: 'Terminal 3', processId: 3434, id: '3' };
		} else if (task.command === 'watch') {
			return { name: 'Terminal 4', processId: 5545, id: '4' };
		}
		return undefined;
	};
	test('Terminals and active tasks', async () => {
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
			{ name: 'Terminal 1', id: '1', processId: 1234 },
			{ name: 'Terminal 2', id: '2', processId: 5678 },
			{ name: 'Terminal 3', id: '3', processId: 3434 },
			{ name: 'Terminal 4', id: '4', processId: 5545 },
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
		assert(output.includes('npm: build'));
		assert(output.includes('npm: watch'));
		assert(output.includes('Terminal 1'));
		assert(output.includes('Terminal 2'));
	});
	test('Terminals and inactive tasks', async () => {
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
		tasksService.isTaskActive = () => false;

		terminalService.terminals = [
			{ name: 'Terminal 1', id: '1', processId: 1234 },
			{ name: 'Terminal 2', id: '2', processId: 5678 },
			{ name: 'Terminal 3', id: '3', processId: 3434 },
			{ name: 'Terminal 4', id: '4', processId: 5545 },
		];
		terminalService.getLastCommandForTerminal = (term: { id: string }) => {
			if (term.id === '3') {
				return { commandLine: 'npm run build', cwd: '/workspace', exitCode: 0 };
			} else if (term.id === '4') {
				return { commandLine: 'npm test', cwd: '/workspace', exitCode: 1 };
			}
			return undefined;
		};

		const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
		const rendered = await prompt.render();

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		assert(output.includes('npm: build'));
		assert(output.includes('npm: watch'));
		assert(output.includes('Terminal 1'));
		assert(output.includes('Terminal 2'));
	});
	test('Terminals and no active tasks', async () => {

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
		assert(output.includes('No tasks found.'));
		assert(output.includes('Terminal 1'));
		assert(output.includes('Terminal 2'));
		assert(output.includes('npm run build'));
		assert(output.includes('npm test'));
		assert(output.includes('/workspace'));
	});
	test('Neither terminals nor active tasks', async () => {
		const tasksService: any = {};
		const terminalService: any = {};

		tasksService.getTasks = () => [];
		tasksService.isTaskActive = () => true;

		terminalService.terminals = [];
		terminalService.getLastCommandForTerminal = (term: any) => {
			return undefined;
		};

		const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
		const rendered = await prompt.render();

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		assert(output.includes('No tasks or terminals found.'));
	});
});