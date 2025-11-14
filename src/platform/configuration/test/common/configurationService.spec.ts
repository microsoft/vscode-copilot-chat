/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { AlternativeNotebookFormat } from '../../../notebook/common/alternativeContentFormat';
import { AbstractConfigurationService, ConfigKey, DefaultValueWithTeamValue } from '../../common/configurationService';

suite('AbstractConfigurationService', () => {
	suite('_extractHashValue', () => {
		test('should return a value between 0 and 1', () => {
			const value = AbstractConfigurationService._extractHashValue('test');
			assert.strictEqual(typeof value, 'number');
			assert.ok(value >= 0 && value <= 1, `Value ${value} should be between 0 and 1`);
		});

		test('should return the same value for the same input', () => {
			const input = 'github.copilot.advanced.testSetting;user1';
			const value1 = AbstractConfigurationService._extractHashValue(input);
			const value2 = AbstractConfigurationService._extractHashValue(input);
			assert.strictEqual(value1, value2);
		});

		test('should return different values for different inputs', () => {
			const value1 = AbstractConfigurationService._extractHashValue('setting1;user1');
			const value2 = AbstractConfigurationService._extractHashValue('setting2;user1');
			assert.notStrictEqual(value1, value2);
		});

		test('should handle empty string', () => {
			const value = AbstractConfigurationService._extractHashValue('');
			assert.strictEqual(typeof value, 'number');
			assert.ok(value >= 0 && value <= 1);
		});

		test('should produce different values when username changes', () => {
			const setting = 'github.copilot.advanced.testSetting';
			const value1 = AbstractConfigurationService._extractHashValue(`${setting};user1`);
			const value2 = AbstractConfigurationService._extractHashValue(`${setting};user2`);
			assert.notStrictEqual(value1, value2);
		});

		test('should be deterministic for complex strings', () => {
			const input = 'github.copilot.advanced.someComplexSetting;username123!@#$%^&*()';
			const expected = AbstractConfigurationService._extractHashValue(input);

			// Call multiple times to ensure determinism
			for (let i = 0; i < 5; i++) {
				const actual = AbstractConfigurationService._extractHashValue(input);
				assert.strictEqual(actual, expected);
			}
		});
	});

	suite('Internal Settings - Validation', () => {
		test('ProjectLabelsChat is correctly configured', () => {
			const setting = ConfigKey.Internal.ProjectLabelsChat;
			assert.strictEqual(setting.id, 'chat.advanced.projectLabels.chat');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('ProjectLabelsInline is correctly configured', () => {
			const setting = ConfigKey.Internal.ProjectLabelsInline;
			assert.strictEqual(setting.id, 'chat.advanced.projectLabels.inline');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('ProjectLabelsExpanded is correctly configured', () => {
			const setting = ConfigKey.Internal.ProjectLabelsExpanded;
			assert.strictEqual(setting.id, 'chat.advanced.projectLabels.expanded');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('WorkspaceMaxLocalIndexSize is correctly configured', () => {
			const setting = ConfigKey.Internal.WorkspaceMaxLocalIndexSize;
			assert.strictEqual(setting.id, 'chat.advanced.workspace.maxLocalIndexSize');
			assert.strictEqual(setting.defaultValue, 100_000);
			assert.strictEqual(setting.isPublic, false);

		});

		test('WorkspaceEnableFullWorkspace is correctly configured', () => {
			const setting = ConfigKey.Internal.WorkspaceEnableFullWorkspace;
			assert.strictEqual(setting.id, 'chat.advanced.workspace.enableFullWorkspace');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('WorkspaceEnableCodeSearch is correctly configured', () => {
			const setting = ConfigKey.Internal.WorkspaceEnableCodeSearch;
			assert.strictEqual(setting.id, 'chat.advanced.workspace.enableCodeSearch');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('WorkspaceEnableEmbeddingsSearch is correctly configured', () => {
			const setting = ConfigKey.Internal.WorkspaceEnableEmbeddingsSearch;
			assert.strictEqual(setting.id, 'chat.advanced.workspace.enableEmbeddingsSearch');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('WorkspacePreferredEmbeddingsModel is correctly configured', () => {
			const setting = ConfigKey.Internal.WorkspacePreferredEmbeddingsModel;
			assert.strictEqual(setting.id, 'chat.advanced.workspace.preferredEmbeddingsModel');
			assert.strictEqual(setting.defaultValue, '');
			assert.strictEqual(setting.isPublic, false);

		});

		test('WorkspacePrototypeAdoCodeSearchEndpointOverride is correctly configured', () => {
			const setting = ConfigKey.Internal.WorkspacePrototypeAdoCodeSearchEndpointOverride;
			assert.strictEqual(setting.id, 'chat.advanced.workspace.prototypeAdoCodeSearchEndpointOverride');
			assert.strictEqual(setting.defaultValue, '');
			assert.strictEqual(setting.isPublic, false);

		});

		test('FeedbackOnChange is correctly configured', () => {
			const setting = ConfigKey.Internal.FeedbackOnChange;
			assert.strictEqual(setting.id, 'chat.advanced.feedback.onChange');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('ReviewIntent is correctly configured', () => {
			const setting = ConfigKey.Internal.ReviewIntent;
			assert.strictEqual(setting.id, 'chat.advanced.review.intent');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('NotebookSummaryExperimentEnabled is correctly configured', () => {
			const setting = ConfigKey.Internal.NotebookSummaryExperimentEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.notebook.summaryExperimentEnabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('NotebookVariableFilteringEnabled is correctly configured', () => {
			const setting = ConfigKey.Internal.NotebookVariableFilteringEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.notebook.variableFilteringEnabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('NotebookAlternativeDocumentFormat is correctly configured', () => {
			const setting = ConfigKey.Internal.NotebookAlternativeDocumentFormat;
			assert.strictEqual(setting.id, 'chat.advanced.notebook.alternativeFormat');
			assert.strictEqual(setting.defaultValue, AlternativeNotebookFormat.xml);
			assert.strictEqual(setting.isPublic, false);

		});

		test('UseAlternativeNESNotebookFormat is correctly configured', () => {
			const setting = ConfigKey.Internal.UseAlternativeNESNotebookFormat;
			assert.strictEqual(setting.id, 'chat.advanced.notebook.alternativeNESFormat.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('TerminalToDebuggerPatterns is correctly configured', () => {
			const setting = ConfigKey.Internal.TerminalToDebuggerPatterns;
			assert.strictEqual(setting.id, 'chat.advanced.debugTerminalCommandPatterns');
			assert.deepStrictEqual(setting.defaultValue, []);
			assert.strictEqual(setting.isPublic, false);

		});

		test('EditSourceTrackingShowDecorations is correctly configured', () => {
			const setting = ConfigKey.Internal.EditSourceTrackingShowDecorations;
			assert.strictEqual(setting.id, 'chat.advanced.editSourceTracking.showDecorations');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('EditSourceTrackingShowStatusBar is correctly configured', () => {
			const setting = ConfigKey.Internal.EditSourceTrackingShowStatusBar;
			assert.strictEqual(setting.id, 'chat.advanced.editSourceTracking.showStatusBar');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('WorkspaceRecordingEnabled is correctly configured', () => {
			const setting = ConfigKey.Internal.WorkspaceRecordingEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.localWorkspaceRecording.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('EditRecordingEnabled is correctly configured', () => {
			const setting = ConfigKey.Internal.EditRecordingEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.editRecording.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('TemporalContextMaxAge is correctly configured', () => {
			const setting = ConfigKey.Internal.TemporalContextMaxAge;
			assert.strictEqual(setting.id, 'chat.advanced.temporalContext.maxAge');
			assert.strictEqual(setting.defaultValue, 100);
			assert.strictEqual(setting.isPublic, false);

		});

		test('TemporalContextPreferSameLang is correctly configured', () => {
			const setting = ConfigKey.Internal.TemporalContextPreferSameLang;
			assert.strictEqual(setting.id, 'chat.advanced.temporalContext.preferSameLang');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('CodeSearchAgentEnabled is correctly configured', () => {
			const setting = ConfigKey.Internal.CodeSearchAgentEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.codesearch.agent.enabled');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('AgentTemperature is correctly configured', () => {
			const setting = ConfigKey.Internal.AgentTemperature;
			assert.strictEqual(setting.id, 'chat.advanced.agent.temperature');
			assert.strictEqual(setting.defaultValue, undefined);
			assert.strictEqual(setting.isPublic, false);

		});

		test('InstantApplyShortModelName is correctly configured', () => {
			const setting = ConfigKey.Internal.InstantApplyShortModelName;
			assert.strictEqual(setting.id, 'chat.advanced.instantApply.shortContextModelName');
			assert.strictEqual(setting.defaultValue, 'gpt-4o-instant-apply-full-ft-v66-short');
			assert.strictEqual(setting.isPublic, false);

		});

		test('InstantApplyShortContextLimit is correctly configured', () => {
			const setting = ConfigKey.Internal.InstantApplyShortContextLimit;
			assert.strictEqual(setting.id, 'chat.advanced.instantApply.shortContextLimit');
			assert.strictEqual(setting.defaultValue, 8000);
			assert.strictEqual(setting.isPublic, false);

		});

		test('EnableUserPreferences is correctly configured', () => {
			const setting = ConfigKey.Internal.EnableUserPreferences;
			assert.strictEqual(setting.id, 'chat.advanced.enableUserPreferences');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('SummarizeAgentConversationHistoryThreshold is correctly configured', () => {
			const setting = ConfigKey.Internal.SummarizeAgentConversationHistoryThreshold;
			assert.strictEqual(setting.id, 'chat.advanced.summarizeAgentConversationHistoryThreshold');
			assert.strictEqual(setting.defaultValue, undefined);
			assert.strictEqual(setting.isPublic, false);

		});

		test('AgentHistorySummarizationMode is correctly configured', () => {
			const setting = ConfigKey.Internal.AgentHistorySummarizationMode;
			assert.strictEqual(setting.id, 'chat.advanced.agentHistorySummarizationMode');
			assert.strictEqual(setting.defaultValue, undefined);
			assert.strictEqual(setting.isPublic, false);

		});

		test('AgentHistorySummarizationWithPromptCache is correctly configured', () => {
			const setting = ConfigKey.Internal.AgentHistorySummarizationWithPromptCache;
			assert.strictEqual(setting.id, 'chat.advanced.agentHistorySummarizationWithPromptCache');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('AgentHistorySummarizationForceGpt41 is correctly configured', () => {
			const setting = ConfigKey.Internal.AgentHistorySummarizationForceGpt41;
			assert.strictEqual(setting.id, 'chat.advanced.agentHistorySummarizationForceGpt41');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('UseResponsesApiTruncation is correctly configured', () => {
			const setting = ConfigKey.Internal.UseResponsesApiTruncation;
			assert.strictEqual(setting.id, 'chat.advanced.useResponsesApiTruncation');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('OmitBaseAgentInstructions is correctly configured', () => {
			const setting = ConfigKey.Internal.OmitBaseAgentInstructions;
			assert.strictEqual(setting.id, 'chat.advanced.omitBaseAgentInstructions');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('PromptFileContext is correctly configured', () => {
			const setting = ConfigKey.Internal.PromptFileContext;
			assert.strictEqual(setting.id, 'chat.advanced.promptFileContextProvider.enabled');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('DefaultToolsGrouped is correctly configured', () => {
			const setting = ConfigKey.Internal.DefaultToolsGrouped;
			assert.strictEqual(setting.id, 'chat.advanced.tools.defaultToolsGrouped');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('VirtualToolEmbeddingRanking is correctly configured', () => {
			const setting = ConfigKey.Internal.VirtualToolEmbeddingRanking;
			assert.strictEqual(setting.id, 'chat.advanced.virtualTools.embeddingRanking');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('MultiReplaceStringGrok is correctly configured', () => {
			const setting = ConfigKey.Internal.MultiReplaceStringGrok;
			assert.strictEqual(setting.id, 'chat.advanced.multiReplaceStringGrok.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('EnableClaudeCodeAgent is correctly configured', () => {
			const setting = ConfigKey.Internal.EnableClaudeCodeAgent;
			assert.strictEqual(setting.id, 'chat.advanced.claudeCode.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('ClaudeCodeDebugEnabled is correctly configured', () => {
			const setting = ConfigKey.Internal.ClaudeCodeDebugEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.claudeCode.debug');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('CopilotCLIEnabled is correctly configured', () => {
			const setting = ConfigKey.Internal.CopilotCLIEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.copilotCLI.enabled');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('Gpt5AlternativePatch is correctly configured', () => {
			const setting = ConfigKey.Internal.Gpt5AlternativePatch;
			assert.strictEqual(setting.id, 'chat.advanced.gpt5AlternativePatch');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('InlineEditsTriggerOnEditorChangeAfterSeconds is correctly configured', () => {
			const setting = ConfigKey.Internal.InlineEditsTriggerOnEditorChangeAfterSeconds;
			assert.strictEqual(setting.id, 'chat.advanced.inlineEdits.triggerOnEditorChangeAfterSeconds');
			const defaultValue = setting.defaultValue as DefaultValueWithTeamValue<number>;
			assert.strictEqual(defaultValue.defaultValue, undefined);
			assert.strictEqual(defaultValue.teamDefaultValue, 10);
			assert.strictEqual(setting.isPublic, false);

		});

		test('InlineEditsNextCursorPredictionDisplayLine is correctly configured', () => {
			const setting = ConfigKey.Internal.InlineEditsNextCursorPredictionDisplayLine;
			assert.strictEqual(setting.id, 'chat.advanced.inlineEdits.nextCursorPrediction.displayLine');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('InlineEditsNextCursorPredictionCurrentFileMaxTokens is correctly configured', () => {
			const setting = ConfigKey.Internal.InlineEditsNextCursorPredictionCurrentFileMaxTokens;
			assert.strictEqual(setting.id, 'chat.advanced.inlineEdits.nextCursorPrediction.currentFileMaxTokens');
			assert.strictEqual(setting.defaultValue, 2000);
			assert.strictEqual(setting.isPublic, false);

		});
	});

});