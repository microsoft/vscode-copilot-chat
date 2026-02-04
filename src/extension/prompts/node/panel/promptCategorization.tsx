/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { generateTaxonomyPrompt } from '../../../prompt/common/promptCategorizationTaxonomy';
import { SafetyRules } from '../base/safetyRules';
import { CurrentEditor } from './currentEditor';
import { WorkspaceStructure } from './workspace/workspaceStructure';

// Re-export types for consumers
export type { PromptClassification, PromptIntent, PromptDomain, PromptScope } from '../../../prompt/common/promptCategorizationTaxonomy';

export interface PromptCategorizationProps extends BasePromptElementProps {
	userRequest: string;
}

const RESPONSE_FORMAT = `# Response Format

Respond with a JSON object only, no other text:
{
  "intent": "one of the intent values",
  "domain": "one of the domain values",
  "timeEstimate": {"bestCase": "ISO 8601 duration", "realistic": "ISO 8601 duration"},
  "scope": "one of the scope values",
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief 1-2 sentence explanation"
}`;

export class PromptCategorizationPrompt extends PromptElement<PromptCategorizationProps> {
	override async render(_state: void, sizing: PromptSizing) {
		const systemPrompt = [
			'You are an expert intent classifier for AI coding assistants. Classify developer messages across four dimensions: intent, domain, time estimate, and scope.',
			generateTaxonomyPrompt(),
			RESPONSE_FORMAT,
		].join('\n\n');

		return (
			<>
				<SystemMessage priority={1000}>
					{systemPrompt}
					<SafetyRules />
				</SystemMessage>
				<WorkspaceStructure priority={800} flexGrow={0} maxSize={Math.min(300, Math.floor(sizing.tokenBudget * 0.1))} />
				<CurrentEditor priority={700} flexGrow={0} />
				<UserMessage priority={900}>
					User message:<br />
					{this.props.userRequest}
				</UserMessage>
			</>
		);
	}
}
