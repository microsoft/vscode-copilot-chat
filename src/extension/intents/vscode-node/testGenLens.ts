/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IParserService } from '../../../platform/parser/node/parserService';
import { range } from '../../../util/vs/base/common/arrays';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';


class TestGenLensProvider implements vscode.CodeLensProvider<vscode.CodeLens>, IDisposable {

	public static codeLensTitle = vscode.l10n.t('Generate tests using Copilot');

	public static isEnabled(configService: IConfigurationService) {
		return configService.getConfig(ConfigKey.GenerateTestsCodeLens);
	}

	public readonly onDidChangeCodeLenses: vscode.Event<void>;

	private readonly store;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IParserService private readonly parserService: IParserService,
	) {
		this.store = new DisposableStore();
		this.onDidChangeCodeLenses = vscode.tests.onDidChangeTestResults;
	}

	public dispose() {
		this.store.dispose();
	}

	public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
		return this.computeCodeLens(document, token);
	}

	private async computeCodeLens(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {

		// don't show code lenses for output channels
		if (document.uri.scheme === 'output') {
			return [];
		}

		const testResults = vscode.tests.testResults;
		if (testResults.length === 0) {
			this.logService.trace('No test results');
			return [];
		}

		const lastTest = testResults[0];

		let detailedCoverage: vscode.FileCoverageDetail[] | undefined;
		try {
			detailedCoverage = await lastTest.getDetailedCoverage?.(document.uri, token);
		} catch (e) {
			this.logService.error(e);
			return [];
		}

		if (!detailedCoverage || detailedCoverage.length === 0) {
			return [];
		}

		const codeLens: vscode.CodeLens[] = [];

		for (const detail of detailedCoverage) {

			if (detail instanceof vscode.DeclarationCoverage) {
				this.logService.trace(`Received statement coverage for ${detail.name}. (detail.executed: ${detail.executed})`);
				const wasExecuted = !!detail.executed;
				if (wasExecuted) {
					continue;
				}
				const locationAsRange = detail.location instanceof vscode.Range ? detail.location : new vscode.Range(detail.location, detail.location);
				codeLens.push(this.createCodeLens(document, locationAsRange));
			} else if (detail instanceof vscode.StatementCoverage) {
				this.logService.trace('Received statement coverage; did nothing');
			} else {
				this.logService.error('Unexpected coverage type');
			}
		}

		if (codeLens.length === 0) {
			// try identifying untested declarations using tree sitter based approach

			const ast = this.parserService.getTreeSitterAST(document);

			if (ast === undefined) {
				return codeLens;
			}

			const testableNodes = await ast.getTestableNodes();

			if (testableNodes === null) {
				return codeLens;
			}

			const uncoveredLines = detailedCoverage.flatMap(cov =>
				!!cov.executed ? [] : (cov.location instanceof vscode.Position ? [cov.location.line] : this.toLineNumbers(cov.location))
			);

			const uncoveredLinesSet = new Set(uncoveredLines);

			for (const node of testableNodes) {
				const start = document.positionAt(node.node.startIndex);
				const end = document.positionAt(node.node.endIndex);
				const codeLensRange = new vscode.Range(start, end);
				if (range(start.line, end.line).every(lineN => uncoveredLinesSet.has(lineN))) {
					codeLens.push(this.createCodeLens(document, codeLensRange));
				}
			}


		}

		return codeLens;
	}

	private createCodeLens(document: vscode.TextDocument, range: vscode.Range) {
		return new vscode.CodeLens(
			range,
			{
				title: TestGenLensProvider.codeLensTitle,
				command: 'github.copilot.chat.generateTests',
				arguments: [{ document, selection: range }],
			}
		);
	}

	private toLineNumbers(range: vscode.Range): number[] {
		const lineNumbers: number[] = [];
		for (let i = range.start.line; i <= range.end.line; i++) {
			lineNumbers.push(i);
		}
		return lineNumbers;
	}
}

export class TestGenLensContribution extends Disposable implements IExtensionContribution {
	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		if (TestGenLensProvider.isEnabled(configurationService)) {
			const testGenCodeLensProvider = this._register(instantiationService.createInstance(TestGenLensProvider));
			this._register(
				vscode.languages.registerCodeLensProvider(
					'*',
					testGenCodeLensProvider
				));
		}
	}
}
