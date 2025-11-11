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
			const setting = ConfigKey.AdvancedExperimentalExperiments.ProjectLabelsChat;
			assert.strictEqual(setting.id, 'chat.projectLabels.chat');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('ProjectLabelsInline is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.ProjectLabelsInline;
			assert.strictEqual(setting.id, 'chat.projectLabels.inline');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('ProjectLabelsExpanded is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.ProjectLabelsExpanded;
			assert.strictEqual(setting.id, 'chat.projectLabels.expanded');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('WorkspaceMaxLocalIndexSize is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.WorkspaceMaxLocalIndexSize;
			assert.strictEqual(setting.id, 'chat.workspace.maxLocalIndexSize');
			assert.strictEqual(setting.defaultValue, 100_000);
			assert.strictEqual(setting.isPublic, true);
		});

		test('WorkspaceEnableFullWorkspace is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.WorkspaceEnableFullWorkspace;
			assert.strictEqual(setting.id, 'chat.workspace.enableFullWorkspace');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, true);
		});

		test('WorkspaceEnableCodeSearch is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.WorkspaceEnableCodeSearch;
			assert.strictEqual(setting.id, 'chat.workspace.enableCodeSearch');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, true);
		});

		test('WorkspaceEnableEmbeddingsSearch is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.WorkspaceEnableEmbeddingsSearch;
			assert.strictEqual(setting.id, 'chat.workspace.enableEmbeddingsSearch');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, true);
		});

		test('WorkspacePreferredEmbeddingsModel is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.WorkspacePreferredEmbeddingsModel;
			assert.strictEqual(setting.id, 'chat.workspace.preferredEmbeddingsModel');
			assert.strictEqual(setting.defaultValue, '');
			assert.strictEqual(setting.isPublic, true);
		});

		test('WorkspacePrototypeAdoCodeSearchEndpointOverride is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.WorkspacePrototypeAdoCodeSearchEndpointOverride;
			assert.strictEqual(setting.id, 'chat.workspace.prototypeAdoCodeSearchEndpointOverride');
			assert.strictEqual(setting.defaultValue, '');
			assert.strictEqual(setting.isPublic, true);
		});

		test('FeedbackOnChange is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.FeedbackOnChange;
			assert.strictEqual(setting.id, 'chat.feedback.onChange');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('ReviewIntent is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.ReviewIntent;
			assert.strictEqual(setting.id, 'chat.review.intent');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('NotebookSummaryExperimentEnabled is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.NotebookSummaryExperimentEnabled;
			assert.strictEqual(setting.id, 'chat.notebook.summaryExperimentEnabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('NotebookVariableFilteringEnabled is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.NotebookVariableFilteringEnabled;
			assert.strictEqual(setting.id, 'chat.notebook.variableFilteringEnabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('NotebookAlternativeDocumentFormat is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.NotebookAlternativeDocumentFormat;
			assert.strictEqual(setting.id, 'chat.notebook.alternativeFormat');
			assert.strictEqual(setting.defaultValue, AlternativeNotebookFormat.xml);
			assert.strictEqual(setting.isPublic, true);
		});

		test('UseAlternativeNESNotebookFormat is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.UseAlternativeNESNotebookFormat;
			assert.strictEqual(setting.id, 'chat.notebook.alternativeNESFormat.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('TerminalToDebuggerPatterns is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.TerminalToDebuggerPatterns;
			assert.strictEqual(setting.id, 'chat.debugTerminalCommandPatterns');
			assert.deepStrictEqual(setting.defaultValue, []);
			assert.strictEqual(setting.isPublic, true);
		});

		test('EditSourceTrackingShowDecorations is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.EditSourceTrackingShowDecorations;
			assert.strictEqual(setting.id, 'chat.editSourceTracking.showDecorations');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('EditSourceTrackingShowStatusBar is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.EditSourceTrackingShowStatusBar;
			assert.strictEqual(setting.id, 'chat.editSourceTracking.showStatusBar');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('WorkspaceRecordingEnabled is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.WorkspaceRecordingEnabled;
			assert.strictEqual(setting.id, 'chat.localWorkspaceRecording.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('EditRecordingEnabled is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.EditRecordingEnabled;
			assert.strictEqual(setting.id, 'chat.editRecording.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('TemporalContextMaxAge is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.TemporalContextMaxAge;
			assert.strictEqual(setting.id, 'chat.temporalContext.maxAge');
			assert.strictEqual(setting.defaultValue, 100);
			assert.strictEqual(setting.isPublic, true);
		});

		test('TemporalContextPreferSameLang is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.TemporalContextPreferSameLang;
			assert.strictEqual(setting.id, 'chat.temporalContext.preferSameLang');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('CodeSearchAgentEnabled is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.CodeSearchAgentEnabled;
			assert.strictEqual(setting.id, 'chat.codesearch.agent.enabled');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, true);
		});

		test('AgentTemperature is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.AgentTemperature;
			assert.strictEqual(setting.id, 'chat.agent.temperature');
			assert.strictEqual(setting.defaultValue, undefined);
			assert.strictEqual(setting.isPublic, true);
		});

		test('InstantApplyShortModelName is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.InstantApplyShortModelName;
			assert.strictEqual(setting.id, 'chat.instantApply.shortContextModelName');
			assert.strictEqual(setting.defaultValue, 'gpt-4o-instant-apply-full-ft-v66-short');
			assert.strictEqual(setting.isPublic, true);
		});

		test('InstantApplyShortContextLimit is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.InstantApplyShortContextLimit;
			assert.strictEqual(setting.id, 'chat.instantApply.shortContextLimit');
			assert.strictEqual(setting.defaultValue, 8000);
			assert.strictEqual(setting.isPublic, true);
		});

		test('EnableUserPreferences is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.EnableUserPreferences;
			assert.strictEqual(setting.id, 'chat.enableUserPreferences');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('SummarizeAgentConversationHistoryThreshold is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.SummarizeAgentConversationHistoryThreshold;
			assert.strictEqual(setting.id, 'chat.summarizeAgentConversationHistoryThreshold');
			assert.strictEqual(setting.defaultValue, undefined);
			assert.strictEqual(setting.isPublic, true);
		});

		test('AgentHistorySummarizationMode is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.AgentHistorySummarizationMode;
			assert.strictEqual(setting.id, 'chat.agentHistorySummarizationMode');
			assert.strictEqual(setting.defaultValue, undefined);
			assert.strictEqual(setting.isPublic, true);
		});

		test('AgentHistorySummarizationWithPromptCache is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.AgentHistorySummarizationWithPromptCache;
			assert.strictEqual(setting.id, 'chat.agentHistorySummarizationWithPromptCache');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('AgentHistorySummarizationForceGpt41 is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.AgentHistorySummarizationForceGpt41;
			assert.strictEqual(setting.id, 'chat.agentHistorySummarizationForceGpt41');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('UseResponsesApiTruncation is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.UseResponsesApiTruncation;
			assert.strictEqual(setting.id, 'chat.advanced.useResponsesApiTruncation');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('OmitBaseAgentInstructions is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.OmitBaseAgentInstructions;
			assert.strictEqual(setting.id, 'chat.omitBaseAgentInstructions');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('PromptFileContext is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.PromptFileContext;
			assert.strictEqual(setting.id, 'chat.advanced.promptFileContextProvider.enabled');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('DefaultToolsGrouped is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.DefaultToolsGrouped;
			assert.strictEqual(setting.id, 'chat.tools.defaultToolsGrouped');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('VirtualToolEmbeddingRanking is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.VirtualToolEmbeddingRanking;
			assert.strictEqual(setting.id, 'chat.virtualTools.embeddingRanking');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('MultiReplaceStringGrok is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.MultiReplaceStringGrok;
			assert.strictEqual(setting.id, 'chat.multiReplaceStringGrok.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, true);
		});

		test('EnableClaudeCodeAgent is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.EnableClaudeCodeAgent;
			assert.strictEqual(setting.id, 'chat.advanced.claudeCode.enabled');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('ClaudeCodeDebugEnabled is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.ClaudeCodeDebugEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.claudeCode.debug');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('CopilotCLIEnabled is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimental.CopilotCLIEnabled;
			assert.strictEqual(setting.id, 'chat.advanced.copilotCLI.enabled');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, false);

		});

		test('Gpt5AlternativePatch is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.Gpt5AlternativePatch;
			assert.strictEqual(setting.id, 'chat.advanced.gpt5AlternativePatch');
			assert.strictEqual(setting.defaultValue, false);
			assert.strictEqual(setting.isPublic, false);

		});

		test('InlineEditsTriggerOnEditorChangeAfterSeconds is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.InlineEditsTriggerOnEditorChangeAfterSeconds;
			assert.strictEqual(setting.id, 'chat.inlineEdits.triggerOnEditorChangeAfterSeconds');
			const defaultValue = setting.defaultValue as DefaultValueWithTeamValue<number>;
			assert.strictEqual(defaultValue.defaultValue, undefined);
			assert.strictEqual(defaultValue.teamDefaultValue, 10);
			assert.strictEqual(setting.isPublic, true);
		});

		test('InlineEditsNextCursorPredictionDisplayLine is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.InlineEditsNextCursorPredictionDisplayLine;
			assert.strictEqual(setting.id, 'chat.inlineEdits.nextCursorPrediction.displayLine');
			assert.strictEqual(setting.defaultValue, true);
			assert.strictEqual(setting.isPublic, true);
		});

		test('InlineEditsNextCursorPredictionCurrentFileMaxTokens is correctly configured', () => {
			const setting = ConfigKey.AdvancedExperimentalExperiments.InlineEditsNextCursorPredictionCurrentFileMaxTokens;
			assert.strictEqual(setting.id, 'chat.inlineEdits.nextCursorPrediction.currentFileMaxTokens');
			assert.strictEqual(setting.defaultValue, 2000);
			assert.strictEqual(setting.isPublic, true);
		});
	});

});