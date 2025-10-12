/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolName } from '../../src/extension/tools/common/toolNames';
import { ssuite, stest } from '../base/stest';
import { fromFixture } from '../simulation/stestUtil';
import { Scenario } from './scenarioLoader';
import { generateScenarioTestRunner } from './scenarioTest';
import { shouldSkipAgentTests } from './tools.stest';

/**
 * Tests that models prefer replace_string_in_file and only fall back to insert_edit_into_file
 * when replace_string_in_file fails or is not applicable.
 *
 * The prompt instructions state that insert_edit_into_file should ONLY be used as a fallback
 * when replace_string_in_file has failed. This test verifies that the model follows this guidance.
 */

ssuite.optional(shouldSkipAgentTests, { title: 'edit tool fallback', subtitle: 'toolCalling', location: 'panel' }, () => {
	stest('should prefer replace_string_in_file for simple edits', async (testingServiceCollection) => {
		const scenario: Scenario = [{
			question: '/editAgent #file:dora.ts In the `getLeadTimePercentiles` function, Update the types to be more specific.',
			name: 'should prefer replace_string_in_file for edits',
			scenarioFolderPath: '',
			setupCase(accessor, workspace) {
				// Set up workspace with dora.ts from fixture
				const doraFile = fromFixture('../fixtures/edit/dora.ts');
				workspace.resetFromFiles([doraFile], undefined);
			},
			// Force tool usage by enabling specific tools
			tools: {
				[ToolName.ReplaceString]: true,
				[ToolName.MultiReplaceString]: true,
				[ToolName.EditFile]: true,
			}
		}];

		return generateScenarioTestRunner(scenario, async (accessor, question, userVisibleAnswer, rawResponse, turn, scenarioIndex, commands) => {
			const toolCallRounds = turn?.resultMetadata?.toolCallRounds;

			if (!toolCallRounds || toolCallRounds.length === 0) {
				return { success: false, errorMessage: 'No tool calls were made.' };
			}

			// Collect all tool calls across all rounds in order
			const allToolCalls: Array<{ roundIndex: number; toolIndex: number; name: string; id: string }> = [];
			for (let roundIndex = 0; roundIndex < toolCallRounds.length; roundIndex++) {
				const round = toolCallRounds[roundIndex];
				for (let toolIndex = 0; toolIndex < round.toolCalls.length; toolIndex++) {
					const toolCall = round.toolCalls[toolIndex];
					allToolCalls.push({
						roundIndex,
						toolIndex,
						name: toolCall.name,
						id: toolCall.id
					});
				}
			}


			if (allToolCalls.length === 0) {
				return { success: false, errorMessage: 'No tool calls found in rounds. Model generated code blocks instead of using edit tools.' };
			}

			// Validate that replace tools are preferred over insert_edit
			// insert_edit is slow and costly $$
			const replaceToolNames = [ToolName.ReplaceString, ToolName.MultiReplaceString, ToolName.ApplyPatch];
			const editToolName = ToolName.EditFile;

			const firstReplaceIndex = allToolCalls.findIndex(tc => replaceToolNames.includes(tc.name as ToolName));
			const firstEditIndex = allToolCalls.findIndex(tc => tc.name === editToolName);

			// If both are present, replace should come before edit (as edit is fallback)
			if (firstReplaceIndex !== -1 && firstEditIndex !== -1) {
				if (firstEditIndex < firstReplaceIndex) {
					return {
						success: false,
						errorMessage: `Tool call order violation: ${editToolName} was called before replace tools. ` +
							`insert_edit_into_file should only be used as a fallback when replace fails. ` +
							`Order: ${allToolCalls.map(tc => tc.name).join(' → ')}`
					};
				}
			}

			return { success: true };
		})(testingServiceCollection);
	});
});
