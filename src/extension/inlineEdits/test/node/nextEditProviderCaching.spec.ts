/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { outdent } from 'outdent';
import { assert, beforeAll, describe, expect, it } from 'vitest';
import type { InlineCompletionContext } from 'vscode';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/test/common/defaultsOnlyConfigurationService';
import { IGitExtensionService } from '../../../../platform/git/common/gitExtensionService';
import { NullGitExtensionService } from '../../../../platform/git/common/nullGitExtensionService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { InlineEditRequestLogContext } from '../../../../platform/inlineEdits/common/inlineEditLogContext';
import { ObservableGit } from '../../../../platform/inlineEdits/common/observableGit';
import { MutableObservableWorkspace } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { IStatelessNextEditProvider, NoNextEditReason, PushEdit, StatelessNextEditRequest, StatelessNextEditResult, StatelessNextEditTelemetryBuilder } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { NesHistoryContextProvider } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { NesXtabHistoryTracker } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ILogService, LogServiceImpl } from '../../../../platform/log/common/logService';
import { NulSimulationTestContext } from '../../../../platform/simulationTestContext/common/simulationTestContext';
import { ISnippyService, NullSnippyService } from '../../../../platform/snippy/common/snippyService';
import { IExperimentationService, NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { mockNotebookService } from '../../../../platform/test/common/testNotebookService';
import { MockExtensionContext } from '../../../../platform/test/node/extensionContext';
import { Result } from '../../../../util/common/result';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { LineEdit, LineReplacement } from '../../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { LineRange } from '../../../../util/vs/editor/common/core/ranges/lineRange';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { NextEditProvider } from '../../node/nextEditProvider';
import { NextEditProviderTelemetryBuilder } from '../../node/nextEditProviderTelemetry';

describe('NextEditProvider Caching', () => {

	let configService: IConfigurationService;
	let snippyService: ISnippyService;
	let gitExtensionService: IGitExtensionService;
	let logService: ILogService;
	let expService: IExperimentationService;

	beforeAll(() => {
		configService = new DefaultsOnlyConfigurationService();
		snippyService = new NullSnippyService();
		gitExtensionService = new NullGitExtensionService();
		logService = new LogServiceImpl([], new NulSimulationTestContext(), new MockExtensionContext() as any);
		expService = new NullExperimentationService();
	});

	it('caches a response with multiple edits and reuses them correctly with rebasing', async () => {
		const obsWorkspace = new MutableObservableWorkspace();
		const obsGit = new ObservableGit(gitExtensionService);
		const statelessNextEditProvider: IStatelessNextEditProvider = {
			ID: 'TestNextEditProvider',
			provideNextEdit: async (request: StatelessNextEditRequest, pushEdit: PushEdit, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken) => {
				const telemetryBuilder = new StatelessNextEditTelemetryBuilder(request);
				const lineEdit = LineEdit.createFromUnsorted(
					[
						new LineReplacement(
							new LineRange(11, 12),
							["const myPoint = new Point3D(0, 1, 2);"]
						),
						new LineReplacement(
							new LineRange(5, 5),
							["\t\tprivate readonly z: number,"]
						),
						new LineReplacement(
							new LineRange(6, 9),
							[
								"\tgetDistance() {",
								"\t\treturn Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2);",
								"\t}"
							]
						)
					]
				);
				lineEdit.edits.forEach(edit => pushEdit(Result.ok({ edit })));
				pushEdit(Result.error(new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, undefined)));
				return StatelessNextEditResult.streaming(telemetryBuilder);
			}
		};

		const nextEditProvider: NextEditProvider = new NextEditProvider(obsWorkspace, statelessNextEditProvider, new NesHistoryContextProvider(obsWorkspace, obsGit), new NesXtabHistoryTracker(obsWorkspace), undefined, configService, snippyService, logService, expService);

		const doc = obsWorkspace.addDocument({
			id: DocumentId.create(URI.file('/test/test.ts').toString()),
			initialValue: outdent`
			class Point {
				constructor(
					private readonly x: number,
					private readonly y: number,
				) { }
				getDistance() {
					return Math.sqrt(this.x ** 2 + this.y ** 2);
				}
			}

			const myPoint = new Point(0, 1);`.trimStart()
		});
		doc.setSelection([new OffsetRange(1, 1)], undefined);

		doc.applyEdit(StringEdit.insert(11, '3D'));

		const context: InlineCompletionContext = { triggerKind: 1, selectedCompletionInfo: undefined, requestUuid: generateUuid(), requestIssuedDateTime: Date.now() };
		const logContext = new InlineEditRequestLogContext(doc.id.toString(), 1, context);
		const cancellationToken = CancellationToken.None;
		const tb1 = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, nextEditProvider.ID, doc);

		let result = await nextEditProvider.getNextEdit(doc.id, context, logContext, cancellationToken, tb1.nesBuilder);

		tb1.dispose();

		assert(result.result?.edit);

		doc.applyEdit(result.result.edit.toEdit());

		expect(doc.value.get().value).toMatchInlineSnapshot(`
			"class Point3D {
				constructor(
					private readonly x: number,
					private readonly y: number,
					private readonly z: number,
				) { }
				getDistance() {
					return Math.sqrt(this.x ** 2 + this.y ** 2);
				}
			}

			const myPoint = new Point(0, 1);"
		`);

		const tb2 = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, nextEditProvider.ID, doc);

		result = await nextEditProvider.getNextEdit(doc.id, context, logContext, cancellationToken, tb2.nesBuilder);

		tb2.dispose();

		assert(result.result?.edit);

		doc.applyEdit(result.result.edit.toEdit());

		expect(doc.value.get().value).toMatchInlineSnapshot(`
			"class Point3D {
				constructor(
					private readonly x: number,
					private readonly y: number,
					private readonly z: number,
				) { }
				getDistance() {
					return Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2);
				}
			}

			const myPoint = new Point(0, 1);"
		`);

		const tb3 = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, nextEditProvider.ID, doc);

		result = await nextEditProvider.getNextEdit(doc.id, context, logContext, cancellationToken, tb3.nesBuilder);

		tb3.dispose();

		assert(result.result?.edit);

		doc.applyEdit(result.result.edit.toEdit());

		expect(doc.value.get().value).toMatchInlineSnapshot(`
			"class Point3D {
				constructor(
					private readonly x: number,
					private readonly y: number,
					private readonly z: number,
				) { }
				getDistance() {
					return Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2);
				}
			}

			const myPoint = new Point3D(0, 1, 2);"
		`);
	});
});
