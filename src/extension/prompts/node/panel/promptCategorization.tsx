/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { generateTaxonomyPrompt } from '../../../prompt/common/promptCategorizationTaxonomy';
import { SafetyRules } from '../base/safetyRules';

// Re-export types for consumers
export type { PromptClassification, PromptIntent, PromptDomain, PromptScope } from '../../../prompt/common/promptCategorizationTaxonomy';

export interface PromptCategorizationProps extends BasePromptElementProps {
	userRequest: string;
	modeName?: string;
	hasSelection: boolean;
	currentFileName?: string;
	currentLanguage?: string;
	hasErrors: boolean;
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
	override render() {
		const contextSignals: string[] = [];
		if (this.props.hasSelection) {
			contextSignals.push('User has code selected');
		}
		if (this.props.currentFileName) {
			contextSignals.push(`Current file: ${this.props.currentFileName}`);
		}
		if (this.props.currentLanguage) {
			contextSignals.push(`Language: ${this.props.currentLanguage}`);
		}
		if (this.props.hasErrors) {
			contextSignals.push('File has errors/diagnostics');
		}
		if (this.props.modeName) {
			contextSignals.push(`Mode: ${this.props.modeName}`);
		}

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
				<UserMessage priority={900}>
					{contextSignals.length > 0 && (
						<>
							Context signals:<br />
							{contextSignals.map(signal => <>{`- ${signal}`}<br /></>)}
							<br />
						</>
					)}
					User message:<br />
					{this.props.userRequest}
				</UserMessage>
			</>
		);
	}
}
