/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { commands, Disposable, TextEditor } from 'vscode';
import { IInstantiationService, ServicesAccessor } from '../../../../../../../util/vs/platform/instantiation/common/instantiation';
import { withInMemoryTelemetry } from '../../../../lib/src/test/telemetry';
import { createExtensionTestingContext } from '../../test/context';
import { CodeRefEngagementTracker } from '../codeReferenceEngagementTracker';
import { citationsChannelName, GitHubCopilotLogger } from '../outputChannel';

suite('CodeReferenceEngagementTracker', function () {
	let logger: GitHubCopilotLogger;
	let commandRegistration: Disposable;
	let engagementTracker: CodeRefEngagementTracker;
	let accessor: ServicesAccessor;

	setup(function () {
		accessor = createExtensionTestingContext();
		const instaService = accessor.get(IInstantiationService);
		logger = instaService.createInstance(GitHubCopilotLogger);
		commandRegistration = commands.registerCommand('test.show', () => logger.forceShow());

		engagementTracker = instaService.createInstance(CodeRefEngagementTracker);
		engagementTracker.register();
	});

	teardown(function () {
		commandRegistration.dispose();
		logger.dispose();
		engagementTracker.dispose();
	});

	test('sends a telemetry event when the output channel is focused', async function () {
		const telemetry = await withInMemoryTelemetry(accessor, () => {
			engagementTracker.onActiveEditorChange({
				document: { uri: { scheme: 'output', path: citationsChannelName } },
			} as TextEditor);
		});

		assert.ok(telemetry.reporter.events.length === 1);
		assert.strictEqual(telemetry.reporter.events[0].name, 'code_referencing.github_copilot_log.focus.count');
	});

	test('sends a telemetry event when the output channel is opened', async function () {
		const telemetry = await withInMemoryTelemetry(accessor, () => {
			engagementTracker.onVisibleEditorsChange([
				{
					document: { uri: { scheme: 'output', path: citationsChannelName } },
				},
			] as TextEditor[]);
		});

		assert.ok(telemetry.reporter.events.length === 1);
		assert.strictEqual(telemetry.reporter.events[0].name, 'code_referencing.github_copilot_log.open.count');
	});

	test('does not send a telemetry event when the output channel is already opened', async function () {
		const telemetry = await withInMemoryTelemetry(accessor, () => {
			engagementTracker.onVisibleEditorsChange([
				{
					document: { uri: { scheme: 'output', path: citationsChannelName } },
				},
			] as TextEditor[]);
			engagementTracker.onVisibleEditorsChange([
				{
					document: { uri: { scheme: 'output', path: citationsChannelName } },
				},
				{
					document: { uri: { scheme: 'file', path: 'some-other-file.js' } },
				},
			] as TextEditor[]);
		});

		assert.ok(telemetry.reporter.events.length === 1);
	});

	test('tracks when the log closes internally', async function () {
		const telemetry = await withInMemoryTelemetry(accessor, () => {
			engagementTracker.onVisibleEditorsChange([
				{
					document: { uri: { scheme: 'output', path: citationsChannelName } },
				},
			] as TextEditor[]);
			engagementTracker.onVisibleEditorsChange([
				{
					document: { uri: { scheme: 'file', path: 'some-other-file.js' } },
				},
			] as TextEditor[]);
		});

		assert.ok(telemetry.reporter.events.length === 1);
		assert.ok(engagementTracker.logVisible === false);
	});
});
