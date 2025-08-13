/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { IReplaceStringToolParams, ReplaceStringTool } from './replaceStringTool';

export interface IMultiReplaceStringToolParams {
	explanation: string;
	replacements: IReplaceStringToolParams[];
}

export interface IMultiReplaceResult {
	totalReplacements: number;
	successfulReplacements: number;
	failedReplacements: number;
	results: Array<{
		operation: IReplaceStringToolParams;
		success: boolean;
		error?: string;
	}>;
}

export class MultiReplaceStringTool implements ICopilotTool<IMultiReplaceStringToolParams> {
	public static toolName = ToolName.MultiReplaceString;

	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IToolsService protected readonly toolsService: IToolsService
	) { }

	// Simplified version that uses a more direct approach
	async invoke(options: any, token: any) {
		// Cast the options to the correct type to work around TypeScript issues
		const typedOptions = options as vscode.LanguageModelToolInvocationOptions<IMultiReplaceStringToolParams> & { input: IMultiReplaceStringToolParams };

		// Validate input
		if (!typedOptions.input.replacements || !Array.isArray(typedOptions.input.replacements) || typedOptions.input.replacements.length === 0) {
			throw new Error('Invalid input: replacements array is required and must contain at least one replacement operation');
		}

		if (!this._promptContext?.stream) {
			throw new Error('Invalid context: stream is required');
		}

		const results: IMultiReplaceResult = {
			totalReplacements: typedOptions.input.replacements.length,
			successfulReplacements: 0,
			failedReplacements: 0,
			results: []
		};

		// Get the ReplaceStringTool instance
		const replaceStringTool = this.instantiationService.createInstance(ReplaceStringTool);

		// Apply replacements sequentially
		for (let i = 0; i < typedOptions.input.replacements.length; i++) {
			const replacement = typedOptions.input.replacements[i];

			try {
				// Validate individual replacement
				if (!replacement.filePath || replacement.oldString === undefined || replacement.newString === undefined) {
					throw new Error(`Invalid replacement at index ${i}: filePath, oldString, and newString are required`);
				}

				// Create a new tool invocation options for this replacement
				const replaceOptions = {
					...typedOptions,
					input: replacement
				};

				// Set the prompt context for the replace tool
				await replaceStringTool.resolveInput(replacement, this._promptContext);

				// Invoke the replace string tool
				await replaceStringTool.invoke(replaceOptions as any, token);

				// Record success
				results.results.push({
					operation: replacement,
					success: true
				});
				results.successfulReplacements++;

			} catch (error) {
				// Record failure
				const errorMessage = error instanceof Error ? error.message : String(error);
				results.results.push({
					operation: replacement,
					success: false,
					error: errorMessage
				});
				results.failedReplacements++;

				// Add error information to the stream using the correct method
				(this._promptContext.stream as any).markdown(`\n⚠️ **Failed replacement ${i + 1}:**\n`);
				(this._promptContext.stream as any).markdown(`- File: \`${replacement.filePath}\`\n`);
				(this._promptContext.stream as any).markdown(`- Error: ${errorMessage}\n\n`);
			}
		}

		// Provide summary using the correct method
		(this._promptContext.stream as any).markdown(`\n## Multi-Replace Summary\n\n`);
		(this._promptContext.stream as any).markdown(`- **Total operations:** ${results.totalReplacements}\n`);
		(this._promptContext.stream as any).markdown(`- **Successful:** ${results.successfulReplacements}\n`);
		(this._promptContext.stream as any).markdown(`- **Failed:** ${results.failedReplacements}\n\n`);

		if (results.failedReplacements > 0) {
			(this._promptContext.stream as any).markdown(`### Failed Operations:\n\n`);
			results.results.filter(r => !r.success).forEach((result, index) => {
				if (this._promptContext?.stream) {
					(this._promptContext.stream as any).markdown(`${index + 1}. **${result.operation.filePath}**\n`);
					(this._promptContext.stream as any).markdown(`   - Error: ${result.error || 'Unknown error'}\n`);
					(this._promptContext.stream as any).markdown(`   - Old string: \`${result.operation.oldString.substring(0, 100)}${result.operation.oldString.length > 100 ? '...' : ''}\`\n\n`);
				}
			});
		}

		// Return a simple result
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				`Multi-replace operation completed: ${results.successfulReplacements}/${results.totalReplacements} operations successful.`
			)
		]);
	}

	async resolveInput(input: IMultiReplaceStringToolParams, promptContext: IBuildPromptContext): Promise<IMultiReplaceStringToolParams> {
		this._promptContext = promptContext;
		return input;
	}

	prepareInvocation(options: any, token: any): any {
		return {
			presentation: 'hidden'
		};
	}
}

ToolRegistry.registerTool(MultiReplaceStringTool);
