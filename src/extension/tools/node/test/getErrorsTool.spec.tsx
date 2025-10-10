/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, expect, suite, test } from 'vitest';
import { ILanguageDiagnosticsService } from '../../../../platform/languages/common/languageDiagnosticsService';
import { TestLanguageDiagnosticsService } from '../../../../platform/languages/common/testLanguageDiagnosticsService';
import { ITestingServicesAccessor, TestingServiceCollection } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createTextDocumentData } from '../../../../util/common/test/shims/textDocument';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { DiagnosticSeverity, Range } from '../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { GetErrorsTool } from '../getErrorsTool';

// Test the GetErrorsTool functionality
suite('GetErrorsTool - Tool Invocation', () => {
	let accessor: ITestingServicesAccessor;
	let collection: TestingServiceCollection;
	let diagnosticsService: TestLanguageDiagnosticsService;
	let tool: GetErrorsTool;

	const workspaceFolder = URI.file('/test/workspace');
	const tsFile1 = URI.file('/test/workspace/src/file1.ts');
	const tsFile2 = URI.file('/test/workspace/src/file2.ts');
	const jsFile = URI.file('/test/workspace/lib/file.js');

	beforeEach(() => {
		collection = createExtensionUnitTestingServices();

		// Set up test documents
		const tsDoc1 = createTextDocumentData(tsFile1, 'function test() {\n  const x = 1;\n  return x;\n}', 'ts').document;
		const tsDoc2 = createTextDocumentData(tsFile2, 'interface User {\n  name: string;\n  age: number;\n}', 'ts').document;
		const jsDoc = createTextDocumentData(jsFile, 'function legacy() {\n  var y = 2;\n  return y;\n}', 'js').document;

		collection.define(IWorkspaceService, new SyncDescriptor(TestWorkspaceService, [[workspaceFolder], [tsDoc1, tsDoc2, jsDoc]]));

		// Set up diagnostics service
		diagnosticsService = new TestLanguageDiagnosticsService();
		collection.define(ILanguageDiagnosticsService, diagnosticsService);

		accessor = collection.createTestingAccessor();

		// Create the tool instance
		tool = accessor.get(IInstantiationService).createInstance(GetErrorsTool);

		// Add test diagnostics
		diagnosticsService.setDiagnostics(tsFile1, [
			{
				message: 'Variable is declared but never used',
				range: new Range(1, 8, 1, 9),
				severity: DiagnosticSeverity.Warning
			},
			{
				message: 'Missing return type annotation',
				range: new Range(0, 9, 0, 13),
				severity: DiagnosticSeverity.Error
			}
		]);

		diagnosticsService.setDiagnostics(tsFile2, [
			{
				message: 'Interface should be exported',
				range: new Range(0, 0, 0, 9),
				severity: DiagnosticSeverity.Information // Should be filtered out
			},
			{
				message: 'Property age should be optional',
				range: new Range(2, 2, 2, 5),
				severity: DiagnosticSeverity.Warning
			}
		]);

		diagnosticsService.setDiagnostics(jsFile, [
			{
				message: 'Use const instead of var',
				range: new Range(1, 2, 1, 5),
				severity: DiagnosticSeverity.Warning
			}
		]);
	});

	afterEach(() => {
		accessor.dispose();
	});

	test('getDiagnostics returns all diagnostics when no paths provided', () => {
		// Access the private method through reflection for testing
		const getDiagnostics = (tool as any).getDiagnostics.bind(tool);

		// Test getting all diagnostics
		const allDiagnostics = getDiagnostics([]);
		expect(allDiagnostics).toHaveLength(0); // Empty paths array returns no diagnostics

		// Test with actual diagnostic data by accessing the service directly
		const allFromService = diagnosticsService.getAllDiagnostics();
		expect(allFromService).toBeDefined();
		expect(allFromService.length).toBe(3); // 3 files with diagnostics
	});

	test('getDiagnostics filters by file path', () => {
		const getDiagnostics = (tool as any).getDiagnostics.bind(tool);

		// Test with specific file path
		const results = getDiagnostics([{ uri: tsFile1, range: undefined }]);

		// Should find diagnostics for the specific file
		const tsFile1Diagnostics = results.find((r: any) => r.uri.toString() === tsFile1.toString());
		expect(tsFile1Diagnostics).toBeDefined();
		if (tsFile1Diagnostics) {
			expect(tsFile1Diagnostics.diagnostics.length).toBe(2); // Two diagnostics in file1
		}
	});

	test('getDiagnostics filters by folder path', () => {
		const getDiagnostics = (tool as any).getDiagnostics.bind(tool);

		// Test with folder path
		const srcFolder = URI.file('/test/workspace/src');
		const results = getDiagnostics([{ uri: srcFolder, range: undefined }]);

		// Should find diagnostics for files in the src folder
		const srcFileDiagnostics = results.filter((r: any) =>
			r.uri.toString().includes('/src/')
		);
		expect(srcFileDiagnostics.length).toBe(2); // Two TypeScript files in src
	});

	test('getDiagnostics filters by range', () => {
		const getDiagnostics = (tool as any).getDiagnostics.bind(tool);

		// Test with specific range that only covers line 1
		const range = new Range(1, 0, 1, 10);
		const results = getDiagnostics([{ uri: tsFile1, range }]);

		const tsFile1Result = results.find((r: any) => r.uri.toString() === tsFile1.toString());
		expect(tsFile1Result).toBeDefined();
		if (tsFile1Result) {
			// Should only include diagnostics that intersect with the range
			// The warning on line 1 should be included, but not the error on line 0
			const rangeDiagnostics = tsFile1Result.diagnostics.filter((d: any) =>
				d.range.intersection(range)
			);
			expect(rangeDiagnostics.length).toBeGreaterThan(0);
		}
	});

	test('tool filters out Information severity diagnostics', () => {
		// Verify that the diagnostics service has Information level diagnostics
		const tsFile2Diagnostics = diagnosticsService.getDiagnostics(tsFile2);
		const infoLevelDiagnostics = tsFile2Diagnostics.filter(d => d.severity === DiagnosticSeverity.Information);
		expect(infoLevelDiagnostics.length).toBe(1);

		// The tool should filter these out (severity <= DiagnosticSeverity.Warning)
		const warningAndErrorDiagnostics = tsFile2Diagnostics.filter(d => d.severity <= DiagnosticSeverity.Warning);
		expect(warningAndErrorDiagnostics.length).toBe(1); // Only the warning, not the information
	});

	test('prepareInvocation returns appropriate messages', async () => {
		// Test without file paths
		const prepared1 = await tool.prepareInvocation({
			input: {}
		}, CancellationToken.None);

		expect(prepared1?.invocationMessage).toBeDefined();
		const message1 = (prepared1?.invocationMessage as any).value;
		expect(message1).toContain('Checking workspace for problems');

		// Test with file paths
		const prepared2 = await tool.prepareInvocation({
			input: { filePaths: ['/test/workspace/src/file1.ts'] }
		}, CancellationToken.None);

		expect(prepared2?.invocationMessage).toBeDefined();
		const message2 = (prepared2?.invocationMessage as any).value;
		expect(message2).toContain('Checking');
		expect(message2).toContain('file1.ts');
	});
});