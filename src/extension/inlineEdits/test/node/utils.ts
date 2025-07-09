/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import type { InlineCompletionContext } from 'vscode';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/test/common/defaultsOnlyConfigurationService';
import { NullGitExtensionService } from '../../../../platform/git/common/nullGitExtensionService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { Edits, RootedEdit } from '../../../../platform/inlineEdits/common/dataTypes/edit';
import { deserializeStringEdit, serializeStringEdit } from '../../../../platform/inlineEdits/common/dataTypes/editUtils';
import { LanguageId } from '../../../../platform/inlineEdits/common/dataTypes/languageId';
import { INextEditProviderTest, InlineEditRequestLogContext } from '../../../../platform/inlineEdits/common/inlineEditLogContext';
import { MutableObservableWorkspace } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { IStatelessNextEditProvider, NoNextEditReason, PushEdit, StatelessNextEditRequest, StatelessNextEditResult, StatelessNextEditTelemetryBuilder } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { DocumentHistory, HistoryContext } from '../../../../platform/inlineEdits/common/workspaceEditTracker/historyContextProvider';
import { NesXtabHistoryTracker } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { StaticWorkspaceTracker } from '../../../../platform/inlineEdits/common/workspaceEditTracker/staticWorkspaceEditTracker';
import { LogServiceImpl } from '../../../../platform/log/common/logService';
import { NulSimulationTestContext } from '../../../../platform/simulationTestContext/common/simulationTestContext';
import { NullSnippyService } from '../../../../platform/snippy/common/snippyService';
import { NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { MockExtensionContext } from '../../../../platform/test/node/extensionContext';
import { Result } from '../../../../util/common/result';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { BugIndicatingError } from '../../../../util/vs/base/common/errors';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { LineEdit } from '../../../../util/vs/editor/common/core/edits/lineEdit';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { JSONL } from '../../../workspaceRecorder/common/jsonlUtil';
import { NextEditProvider } from '../../node/nextEditProvider';
import { NextEditProviderTelemetryBuilder } from '../../node/nextEditProviderTelemetry';

/**
 * This function is used to unit-test code that does not involve sending requests to a model.
*/
export async function runNextEditProviderTest(data: INextEditProviderTest): Promise<{ statelessInitialText: unknown; statelessEdit: unknown; nextEdit: unknown }> {
	const recentEditArr = data.recentWorkspaceEdits;
	const docs = recentEditArr.map(e => {
		const deserializedEdit = deserializeStringEdit(e.edit);
		const recentEdit = new RootedEdit(new StringText(e.initialText), deserializedEdit);
		const path = e.path;
		const docUri = DocumentId.create(path);
		return new DocumentHistory(docUri, LanguageId.PlainText, recentEdit.base, Edits.single(recentEdit.edit), undefined);
	});
	const recentEdit = new HistoryContext(docs);

	const tracker = new StaticWorkspaceTracker(recentEdit);

	let statelessNextEditProvider: IStatelessNextEditProvider;
	if (data.statelessNextEdit) {
		statelessNextEditProvider = new StaticStatelessNextEditProvider(
			LineEdit.deserialize(data.statelessNextEdit!)
		);
	} else {
		throw new BugIndicatingError('not supported');
	}

	const observableWorkspace = new MutableObservableWorkspace();
	for (const e of recentEdit.documents) {
		const doc = observableWorkspace.addDocument({ id: e.docId, initialValue: e.lastEdit.base.value, languageId: e.languageId });
		doc.applyEdit(e.lastEdit.edit);
	}

	const configService = new DefaultsOnlyConfigurationService();
	const snippyService = new NullSnippyService();
	const xtabEditTracker = new NesXtabHistoryTracker(observableWorkspace);
	const gitExtensionService = new NullGitExtensionService();
	const logService = new LogServiceImpl([], new NulSimulationTestContext(), new MockExtensionContext() as any);
	const expService = new NullExperimentationService();
	const nextEditProvider = new NextEditProvider(observableWorkspace, statelessNextEditProvider, tracker, xtabEditTracker, undefined, configService, snippyService, logService, expService);

	const activeDocument = recentEdit.getMostRecentDocument(); // TODO

	const context: InlineCompletionContext = { triggerKind: 1, selectedCompletionInfo: undefined, requestUuid: generateUuid() };
	const logContext = new InlineEditRequestLogContext('', 1, context);
	const telemetryBuilder = new NextEditProviderTelemetryBuilder(gitExtensionService, nextEditProvider.ID, observableWorkspace.getDocument(activeDocument.docId)!);
	const e = await nextEditProvider.getNextEdit(activeDocument.docId, context, logContext, CancellationToken.None, telemetryBuilder.nesBuilder);

	/*
	TODO
	if (data.statelessInitialText) {
		assert.deepStrictEqual(ctx.inputEdit?.base.value, data.statelessInitialText);
	}
	if (data.statelessEdit) {
		assert.deepStrictEqual(ctx.inputEdit?.edit.serialize(), data.statelessEdit);
	}*/

	return {
		statelessInitialText: logContext.inputEdit?.base.value,
		statelessEdit: logContext.inputEdit?.edit.serialize(),
		nextEdit: e.result ? serializeStringEdit(e.result.edit.toEdit()) : undefined,
	};
}

export class StaticStatelessNextEditProvider implements IStatelessNextEditProvider {

	public readonly ID = 'StaticStatelessNextEditProvider';

	constructor(private readonly edit: LineEdit) { }

	async provideNextEdit(request: StatelessNextEditRequest, pushEdit: PushEdit, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken) {
		const telemetryBuilder = new StatelessNextEditTelemetryBuilder(request);
		this.edit.edits.forEach(edit => pushEdit(Result.ok({ edit })));
		pushEdit(Result.error(new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, undefined)));
		return StatelessNextEditResult.streaming(telemetryBuilder);
	}
}

export async function jsonlFromFile<T>(filePath: string): Promise<T[]> {
	return JSONL.parse(await readFile(filePath, { encoding: 'utf8' }));
}
