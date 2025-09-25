/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { NotebookDocument, NotebookEditor } from 'vscode';
import { IDiffService } from '../../src/platform/diff/common/diffService';
import { DiffServiceImpl } from '../../src/platform/diff/node/diffServiceImpl';
import { IAlternativeNotebookContentService } from '../../src/platform/notebook/common/alternativeContent';
import { AlternativeNotebookContentEditGenerator, IAlternativeNotebookContentEditGenerator } from '../../src/platform/notebook/common/alternativeContentEditGenerator';
import { INotebookService, VariablesResult } from '../../src/platform/notebook/common/notebookService';
import { IFile, SimulationWorkspace } from '../../src/platform/test/node/simulationWorkspace';
import { SimulationAlternativeNotebookContentService, SimulationNotebookService } from '../../src/platform/test/node/simulationWorkspaceServices';
import { ResourceMap } from '../../src/util/vs/base/common/map';
import { assertType } from '../../src/util/vs/base/common/types';
import { SyncDescriptor } from '../../src/util/vs/platform/instantiation/common/descriptors';
import { NotebookRange } from '../../src/util/vs/workbench/api/common/extHostTypes/notebooks';
import { ISimulationTestRuntime, ssuite, stest } from '../base/stest';
import { ensurePythonVEnv } from '../simulation/diagnosticProviders/python';
import { simulateInlineChat } from '../simulation/inlineChatSimulator';
import { ExecuteResult, IRunningKernel, KernelProvider, StreamOutput, TypedJupyerMessage, convertExecutionReplies, executeNotebookCells, executeRequest, launchKernel, notebookCellInputFuzzyMatches, notebookCellOutputFuzzyMatches } from '../simulation/notebookValidator';
import { INLINE_NOTEBOOK_EXECUTION_TAG } from '../simulation/shared/sharedTypes';
import { IScenario, IScenarioQuery } from '../simulation/types';
import { IConversationTestCase, Scenario, fetchConversationScenarios } from './scenarioLoader';

function prepareNotebook(notebookEditor: NotebookEditor): string {
	// parse the notebook document, reserve all the cells until the active cell
	// keep the active cell empty and then later on we request the model to fill it
	const document = notebookEditor.notebook;
	const activeCellIndex = notebookEditor.selection.start;
	const allCells: any[] = [];
	for (let i = 0; i < activeCellIndex; i++) {
		const cell = document.cellAt(i);
		allCells.push({
			cell_type: cell.kind === 2 ? 'code' : 'markdown',
			source: [cell.document.getText()],
			metadata: cell.metadata,
			outputs: []
		});
	}

	const activeCell = document.cellAt(activeCellIndex);
	allCells.push({
		cell_type: activeCell.kind === 2 ? 'code' : 'markdown',
		source: [],
		metadata: activeCell.metadata,
		outputs: []
	});

	return JSON.stringify({
		cells: allCells,
		metadata: document.metadata,
	}, undefined, 4);
}

export function fetchConversationScenariosNested(folder: string): Scenario[] {
	const scenarios: Scenario[] = [];
	const files = fs.readdirSync(folder);
	for (const file of files) {
		const filePath = path.join(folder, file);
		const stat = fs.statSync(filePath);
		if (stat.isDirectory()) {
			const nestedScenarios = fetchConversationScenariosNested(filePath);
			scenarios.push(...nestedScenarios);
		}
	}

	// scenarios in the current folder
	const currentFolderScenarios = fetchConversationScenarios(folder);
	if (currentFolderScenarios.length) {
		scenarios.push(...currentFolderScenarios);
	}
	return scenarios;
}

// name map
const nameMap = new Set<string>();
function generateUniqueScenarioName(scenario: IConversationTestCase): string {
	const stateFile = scenario.json?.stateFile;
	let parentFolderName = path.basename(scenario.scenarioFolderPath);
	let scenarioId = scenario.question;
	if (stateFile) {
		const testName = stateFile.split('.')[0];
		// testName ends with a number, extract that
		const match = testName.match(/(\d+)$/);
		if (match) {
			scenarioId = `${match[0]}`;
		} else {
			scenarioId = '0';
		}
	}
	parentFolderName = parentFolderName.replace(/_/g, '-');
	const question = parentFolderName + '-' + scenarioId;
	if (!nameMap.has(question)) {
		nameMap.add(question);
		return question;
	}

	let i = 1;
	while (nameMap.has(`${question}-${i}`)) {
		i++;
	}

	const newName = `${question}-${i}`;
	nameMap.add(newName);
	return newName;
}

async function startKernelAndRunBeforeActiveCell(conversation: IConversationTestCase, solutionNotebook: NotebookDocument, cellIndex: number, workspace: SimulationWorkspace | undefined): Promise<{
	provider: KernelProvider;
	kernel: IRunningKernel;
	variables: VariablesResult[];
} | undefined> {
	try {
		const provider = new KernelProvider();
		const virtualEnvironment = ensurePythonVEnv();

		if (!virtualEnvironment) {
			throw new Error(`Python virtual environment not found`);
		}

		const kernel = await launchKernel(provider, virtualEnvironment, conversation.scenarioFolderPath, 5000);
		if (!kernel) {
			throw new Error('Failed to start kernel');
		}

		const kernelInfo = { provider, kernel, variables: [] };
		const notebookData = workspace?.getNotebook(solutionNotebook.uri);

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				kernel.process.print();
				reject('execute notebook before active cell timeout');
			}, 15000);

			executeNotebookCells(solutionNotebook, kernel, new NotebookRange(0, cellIndex), notebookData)
				.then(() => {
					clearTimeout(timeout);
					resolve();
				})
				.catch((error) => {
					clearTimeout(timeout);
					reject(error);
				});
		});

		return kernelInfo;
	} catch (ex) {
		throw new Error(`Failed to run cells: ${ex}`);
	}
}

(function () {
	ssuite({ title: 'notebooks', subtitle: 'generate', location: 'inline' }, (inputPath) => {
		const scenarioFolder = inputPath ?? path.join(__dirname, '..', 'test/scenarios/test-notebooks');
		const scenarios: Scenario[] = fetchConversationScenariosNested(scenarioFolder);

		for (const scenario of scenarios) {
			for (const conversation of scenario) {
				stest.optional(() => { return inputPath === undefined; }, { description: generateUniqueScenarioName(conversation), language: 'python' },
					async (testingServiceCollection) => {
						assertType(conversation.getState !== undefined, 'state must be defined');
						const state = conversation.getState();
						const activeDoc = state.activeTextEditor!.document!;
						const selection = state.activeTextEditor!.selection;
						const activeNotebookEditor = state.activeNotebookEditor!;

						const currentFileContent = prepareNotebook(activeNotebookEditor);
						const currentFile: IFile = {
							kind: 'qualifiedFile',
							uri: activeDoc.uri,
							fileContents: currentFileContent
						};

						const activeCellIndex = activeNotebookEditor.selection.start;

						const filePath = currentFile.uri.path;
						const solutionNotebook = state.notebookDocuments.find(doc => doc.uri.path === filePath);
						const cellIndex = state.activeNotebookEditor!.selection.start;

						if (!solutionNotebook) {
							assert.ok(false, `Solution notebook not found: ${filePath}`);
						}

						const activeCell = solutionNotebook.cellAt(cellIndex);
						if (!activeCell) {
							assert.ok(false, `Cell not found at index ${cellIndex}`);
						}

						const testAgainstOutput = activeCell.metadata.tags && Array.isArray(activeCell.metadata.tags) && activeCell.metadata.tags.find(tag => tag.startsWith('output') !== undefined);
						let kernelInfo: {
							provider: KernelProvider;
							kernel: IRunningKernel;
							variables: VariablesResult[];
						} | undefined = undefined;

						if (testAgainstOutput) {
							// Output matching, requires running the notebook
							try {
								kernelInfo = await startKernelAndRunBeforeActiveCell(conversation, solutionNotebook, cellIndex, undefined);

								if (kernelInfo) {
									const variables = await kernelInfo.provider.resolveKernelVariables(kernelInfo.kernel);
									kernelInfo.variables = variables;
								}

							} catch (ex) {
								kernelInfo?.kernel.dispose();
								assert.ok(false, `Jupyter Kernel Validation failed ${ex}.`);
							}
						}

						const query: IScenarioQuery = {
							file: currentFile.uri,
							activeCell: activeCellIndex,
							selection: [selection.anchor.line, selection.anchor.character, selection.active.line, selection.active.character],
							diagnostics: [],
							query: conversation.question,
							expectedIntent: undefined,
							validate: async (outcome, workspace, accessor) => {
								if (outcome.type !== 'inlineEdit') {
									kernelInfo?.kernel.dispose();
									assert.ok(false, `Unexpected outcome type: ${outcome.type}`);
								}

								const expected = activeCell.document.getText();
								const actual = outcome.fileContents.trim();

								const inputFuzzyMatched = notebookCellInputFuzzyMatches(activeCell, actual);
								if (inputFuzzyMatched) {
									kernelInfo?.kernel.dispose();
									assert.ok(true);
									return;
								}

								try {
									if (!kernelInfo) {
										// We didn't start the kernel yet
										kernelInfo = await startKernelAndRunBeforeActiveCell(conversation, solutionNotebook, cellIndex, workspace);
									}

									if (!kernelInfo) {
										assert.ok(false, 'Failed to start kernel');
									}

									const { kernel } = kernelInfo;

									const replies = await new Promise<TypedJupyerMessage[] | undefined>((resolve, reject) => {
										const timeout = setTimeout(() => {
											resolve(undefined);
										}, 30000);

										kernel.connection.sendAndReceive(executeRequest(actual))
											.then((replies) => {
												clearTimeout(timeout);
												resolve(replies);
											})
											.catch((error) => {
												clearTimeout(timeout);
												resolve(undefined);
											});
									});

									if (!replies) {
										kernel.dispose();
										assert.ok(false, 'Failed to execute notebook');
									}

									const notebookData = workspace?.getNotebook(solutionNotebook.uri);
									notebookData?.appendCellOutput(activeCell.index, convertExecutionReplies(replies));
									const testRuntime = accessor.get(ISimulationTestRuntime);
									const workspacePath = workspace.getFilePath(solutionNotebook.uri);
									const ext = path.extname(workspacePath);
									const basename = path.basename(workspacePath, ext);
									try {
										await testRuntime.writeFile(basename + '.output' + ext, workspace.getNotebook(solutionNotebook.uri).getText(), INLINE_NOTEBOOK_EXECUTION_TAG);
									} catch (_ex) {
										// no op
									}

									const executionResult = replies.find(reply => reply.header.msg_type === 'execute_result' || reply.header.msg_type === 'stream') as ExecuteResult | StreamOutput | undefined;
									if (executionResult) {
										const actualOutput = ('data' in executionResult.content ? executionResult.content.data['text/plain'] : executionResult.content.text).trim();

										const outputFuzzyMatched = notebookCellOutputFuzzyMatches(activeCell, actualOutput);
										if (outputFuzzyMatched) {
											try {
												kernel.dispose();
											} catch (_ex) {
												// Ignore
											}

											assert.ok(true);
											return;
										}
									}
									kernel.dispose();
									assert.ok(false, `None of the fuzzy matching works. Expected: ${expected}\nActual: ${actual}`);
								} catch (ex) {
									assert.ok(false, `Jupyter Kernel Validation failed ${ex}.`);
								}
							}
						};

						const testScenario: IScenario = {
							files: [currentFile],
							queries: [query],
							extraWorkspaceSetup: async (workspace) => {
								if (kernelInfo?.variables) {
									testingServiceCollection.define(INotebookService, new SyncDescriptor(
										SimulationNotebookService,
										[
											workspace,
											new ResourceMap<VariablesResult[]>([[solutionNotebook.uri, kernelInfo.variables]])
										]
									));
									testingServiceCollection.define(IAlternativeNotebookContentService, new SyncDescriptor(
										SimulationAlternativeNotebookContentService,
										[]
									));
									testingServiceCollection.define(IAlternativeNotebookContentEditGenerator, new SyncDescriptor(
										AlternativeNotebookContentEditGenerator
									));
									testingServiceCollection.define(IDiffService, new SyncDescriptor(
										DiffServiceImpl
									));
								}
							}
						};

						await simulateInlineChat(testingServiceCollection, testScenario);
					});
			}
		}
	});
})();
