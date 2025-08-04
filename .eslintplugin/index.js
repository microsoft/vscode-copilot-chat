/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const glob = require('glob');
const path = require('path');

require('tsx/cjs');

// Re-export all .ts files as rules
/** @type {Record<string, import('@typescript-eslint/utils/dist/ts-eslint').LooseRuleDefinition>} */
const rules = {};
glob.sync(`*.ts`, { cwd: __dirname }).forEach((file) => {
	rules[path.basename(file, '.ts')] = require(`./${file}`);
});

rules['no-restricted-copilot-pr-string'] = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Ensure "Generate with Copilot" string in GitHubPullRequestProviders is never changed',
			category: 'Best Practices'
		},
		schema: [
			{
				type: 'object',
				properties: {
					className: { type: 'string' },
					string: { type: 'string' }
				},
				additionalProperties: false
			}
		]
	},
	create(context) {
		const options = context.options[0] || {};
		const className = options.className || 'GitHubPullRequestProviders';
		const requiredString = options.string || 'Generate with Copilot';

		let inTargetClass = false;

		return {
			ClassDeclaration(node) {
				if (node.id && node.id.name === className) {
					inTargetClass = true;
				}
			},
			'ClassDeclaration:exit'(node) {
				if (node.id && node.id.name === className) {
					inTargetClass = false;
				}
			},
			Literal(node) {
				if (inTargetClass && typeof node.value === 'string' && node.value.includes('Generate')) {
					if (node.value !== requiredString) {
						context.report({
							node,
							message: `String literal in ${className} must be exactly "${requiredString}" as the string is referenced in the GitHub Pull Request extension. Talk to alexr00 if you need to change it.`
						});
					}
				}
			}
		};
	}
};

exports.rules = rules;
