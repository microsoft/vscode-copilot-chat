/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type * as vscode from 'vscode';
import { ObjectJsonSchema } from '../../../platform/configuration/common/jsonSchema';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { formatUriForFileWidget, resolveToolInputPath } from './toolUtils';

export interface CodeAnalysisOptions {
	filePath: string;
	analysisType?: 'basic' | 'detailed';
}

export const codeAnalysisDescription: vscode.LanguageModelToolInformation = {
	name: ToolName.CodeAnalysis,
	description: 'Analyze code files to provide metrics like lines of code, complexity, function count, and other insights. Supports TypeScript, JavaScript, and other common programming languages.',
	tags: ['analysis', 'metrics', 'code quality'],
	inputSchema: {
		type: 'object',
		required: ['filePath'],
		properties: {
			filePath: {
				description: 'The absolute path of the file to analyze.',
				type: 'string'
			},
			analysisType: {
				description: 'Type of analysis to perform: "basic" for simple metrics, "detailed" for comprehensive analysis.',
				type: 'string',
				enum: ['basic', 'detailed'],
				default: 'basic'
			}
		}
	} satisfies ObjectJsonSchema,
};

export class CodeAnalysisTool implements ICopilotTool<CodeAnalysisOptions> {
	static readonly toolName = ToolName.CodeAnalysis;
	readonly toolName = ToolName.CodeAnalysis;

	constructor(
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<CodeAnalysisOptions>, token: vscode.CancellationToken): Promise<LanguageModelToolResult> {
		const { filePath, analysisType = 'basic' } = options.input;

		try {
			const resolvedPath = resolveToolInputPath(filePath, this.promptPathRepresentationService);
			// Skip file assertions for simplicity in this basic tool

			const textDocument = await this.workspaceService.openTextDocument(resolvedPath);
			const text = textDocument.getText();

			const analysis = this.analyzeCode(text, resolvedPath.fsPath, analysisType);
			const formatted = formatUriForFileWidget(resolvedPath);

			const resultContent = new MarkdownString();
			resultContent.appendMarkdown(`## Code Analysis: ${formatted}\n\n`);
			resultContent.appendMarkdown(this.formatAnalysisResults(analysis));

			return {
				content: [resultContent]
			};

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			return {
				content: [
					new MarkdownString(`Error analyzing file: ${errorMsg}`)
				]
			};
		}
	}

	private analyzeCode(content: string, filePath: string, analysisType: 'basic' | 'detailed'): CodeAnalysisResult {
		const lines = content.split('\n');
		const fileExtension = filePath.split('.').pop()?.toLowerCase() || '';

		const basic = this.performBasicAnalysis(content, lines, fileExtension);

		if (analysisType === 'detailed') {
			const detailed = this.performDetailedAnalysis(content, lines, fileExtension);
			return { ...basic, ...detailed };
		}

		return basic;
	}

	private performBasicAnalysis(content: string, lines: string[], extension: string): BasicAnalysis {
		// Basic metrics
		const totalLines = lines.length;
		const nonEmptyLines = lines.filter(line => line.trim().length > 0).length;
		const commentLines = this.countCommentLines(lines, extension);
		const codeLines = nonEmptyLines - commentLines;

		// Character and word counts
		const totalCharacters = content.length;
		const totalWords = content.split(/\s+/).filter(word => word.length > 0).length;

		// Function/method detection (basic regex patterns)
		const functions = this.countFunctions(content, extension);
		const classes = this.countClasses(content, extension);

		return {
			totalLines,
			nonEmptyLines,
			codeLines,
			commentLines,
			totalCharacters,
			totalWords,
			functionCount: functions,
			classCount: classes,
			fileExtension: extension
		};
	}

	private performDetailedAnalysis(content: string, lines: string[], extension: string): DetailedAnalysis {
		// Cyclomatic complexity estimation
		const complexity = this.estimateComplexity(content, extension);

		// Import/require analysis
		const imports = this.countImports(content, extension);

		// TODO/FIXME comments
		const todos = this.countTodosAndFixmes(content);

		// Indentation analysis
		const indentationInfo = this.analyzeIndentation(lines);

		// Longest line
		const longestLine = Math.max(...lines.map(line => line.length));

		return {
			estimatedComplexity: complexity,
			importCount: imports.total,
			importDetails: imports.details,
			todoCount: todos.todo,
			fixmeCount: todos.fixme,
			averageLineLength: Math.round(lines.reduce((sum, line) => sum + line.length, 0) / lines.length),
			longestLineLength: longestLine,
			indentationStyle: indentationInfo.style,
			averageIndentLevel: indentationInfo.averageLevel
		};
	}

	private countCommentLines(lines: string[], extension: string): number {
		const commentPatterns = this.getCommentPatterns(extension);
		return lines.filter(line => {
			const trimmed = line.trim();
			return commentPatterns.some(pattern => pattern.test(trimmed));
		}).length;
	}

	private getCommentPatterns(extension: string): RegExp[] {
		switch (extension) {
			case 'ts':
			case 'js':
			case 'tsx':
			case 'jsx':
			case 'java':
			case 'c':
			case 'cpp':
			case 'cs':
				return [/^\/\//, /^\/\*/, /^\*/];
			case 'py':
				return [/^#/];
			case 'rb':
				return [/^#/];
			case 'php':
				return [/^\/\//, /^#/, /^\/\*/];
			default:
				return [/^\/\//, /^#/];
		}
	}

	private countFunctions(content: string, extension: string): number {
		const patterns = this.getFunctionPatterns(extension);
		let count = 0;

		patterns.forEach(pattern => {
			const matches = content.match(pattern);
			count += matches ? matches.length : 0;
		});

		return count;
	}

	private getFunctionPatterns(extension: string): RegExp[] {
		switch (extension) {
			case 'ts':
			case 'js':
			case 'tsx':
			case 'jsx':
				return [
					/function\s+\w+/g,
					/\w+\s*\([^)]*\)\s*\{/g,
					/\w+\s*:\s*\([^)]*\)\s*=>/g,
					/const\s+\w+\s*=\s*\([^)]*\)\s*=>/g
				];
			case 'py':
				return [/def\s+\w+/g];
			case 'java':
			case 'cs':
				return [/\w+\s+\w+\s*\([^)]*\)\s*\{/g];
			default:
				return [/function\s+\w+/g];
		}
	}

	private countClasses(content: string, extension: string): number {
		const patterns = this.getClassPatterns(extension);
		let count = 0;

		patterns.forEach(pattern => {
			const matches = content.match(pattern);
			count += matches ? matches.length : 0;
		});

		return count;
	}

	private getClassPatterns(extension: string): RegExp[] {
		switch (extension) {
			case 'ts':
			case 'js':
			case 'tsx':
			case 'jsx':
				return [/class\s+\w+/g, /interface\s+\w+/g, /type\s+\w+\s*=/g];
			case 'py':
				return [/class\s+\w+/g];
			case 'java':
			case 'cs':
				return [/class\s+\w+/g, /interface\s+\w+/g];
			default:
				return [/class\s+\w+/g];
		}
	}

	private estimateComplexity(content: string, extension: string): number {
		// Simple cyclomatic complexity estimation
		const complexityKeywords = this.getComplexityKeywords(extension);
		let complexity = 1; // Base complexity

		complexityKeywords.forEach(keyword => {
			const matches = content.match(keyword);
			complexity += matches ? matches.length : 0;
		});

		return complexity;
	}

	private getComplexityKeywords(extension: string): RegExp[] {
		switch (extension) {
			case 'ts':
			case 'js':
			case 'tsx':
			case 'jsx':
				return [
					/\bif\b/g, /\belse\b/g, /\bwhile\b/g, /\bfor\b/g,
					/\bswitch\b/g, /\bcase\b/g, /\bcatch\b/g, /\btry\b/g,
					/\?\?/g, /\?\./g, /\&\&/g, /\|\|/g
				];
			case 'py':
				return [
					/\bif\b/g, /\belif\b/g, /\belse\b/g, /\bwhile\b/g,
					/\bfor\b/g, /\btry\b/g, /\bexcept\b/g, /\band\b/g, /\bor\b/g
				];
			default:
				return [/\bif\b/g, /\belse\b/g, /\bwhile\b/g, /\bfor\b/g];
		}
	}

	private countImports(content: string, extension: string): { total: number; details: string[] } {
		const patterns = this.getImportPatterns(extension);
		const details: string[] = [];
		let total = 0;

		patterns.forEach(pattern => {
			const matches = content.match(pattern);
			if (matches) {
				total += matches.length;
				details.push(...matches);
			}
		});

		return { total, details };
	}

	private getImportPatterns(extension: string): RegExp[] {
		switch (extension) {
			case 'ts':
			case 'js':
			case 'tsx':
			case 'jsx':
				return [/import\s+.*from\s+['"][^'"]+['"]/g, /require\s*\(\s*['"][^'"]+['"]\s*\)/g];
			case 'py':
				return [/import\s+\w+/g, /from\s+\w+\s+import/g];
			case 'java':
				return [/import\s+[\w.]+;/g];
			case 'cs':
				return [/using\s+[\w.]+;/g];
			default:
				return [];
		}
	}

	private countTodosAndFixmes(content: string): { todo: number; fixme: number } {
		const todoMatches = content.match(/TODO|@todo/gi);
		const fixmeMatches = content.match(/FIXME|@fixme/gi);

		return {
			todo: todoMatches ? todoMatches.length : 0,
			fixme: fixmeMatches ? fixmeMatches.length : 0
		};
	}

	private analyzeIndentation(lines: string[]): { style: string; averageLevel: number } {
		let tabCount = 0;
		let spaceCount = 0;
		let totalIndentLevels = 0;
		let indentedLines = 0;

		lines.forEach(line => {
			if (line.length === 0) {
				return;
			}

			const leadingWhitespace = line.match(/^[\t ]*/)?.[0] || '';
			if (leadingWhitespace.length > 0) {
				indentedLines++;

				if (leadingWhitespace.includes('\t')) {
					tabCount++;
					totalIndentLevels += leadingWhitespace.split('\t').length - 1;
				} else {
					spaceCount++;
					// Assume 2 or 4 spaces per indent level
					const spaceIndent = leadingWhitespace.length;
					totalIndentLevels += Math.floor(spaceIndent / (spaceIndent <= 2 ? 2 : 4));
				}
			}
		});

		const style = tabCount > spaceCount ? 'tabs' : 'spaces';
		const averageLevel = indentedLines > 0 ? totalIndentLevels / indentedLines : 0;

		return { style, averageLevel };
	}

	private formatAnalysisResults(analysis: CodeAnalysisResult): string {
		let result = '### Basic Metrics\n\n';
		result += `- **Total Lines**: ${analysis.totalLines}\n`;
		result += `- **Code Lines**: ${analysis.codeLines}\n`;
		result += `- **Comment Lines**: ${analysis.commentLines}\n`;
		result += `- **Functions**: ${analysis.functionCount}\n`;
		result += `- **Classes/Interfaces**: ${analysis.classCount}\n`;
		result += `- **File Type**: .${analysis.fileExtension}\n\n`;

		if ('estimatedComplexity' in analysis) {
			result += '### Detailed Analysis\n\n';
			result += `- **Estimated Complexity**: ${analysis.estimatedComplexity}\n`;
			result += `- **Imports**: ${analysis.importCount}\n`;
			result += `- **TODOs**: ${analysis.todoCount}\n`;
			result += `- **FIXMEs**: ${analysis.fixmeCount}\n`;
			result += `- **Average Line Length**: ${analysis.averageLineLength} characters\n`;
			result += `- **Longest Line**: ${analysis.longestLineLength} characters\n`;
			result += `- **Indentation Style**: ${analysis.indentationStyle}\n`;
			if ('averageIndentLevel' in analysis && analysis.averageIndentLevel !== undefined) {
				result += `- **Average Indent Level**: ${analysis.averageIndentLevel.toFixed(1)}\n\n`;
			}
		}

		// Code quality insights
		result += '### Quality Insights\n\n';
		if (analysis.codeLines > 1000) {
			result += '⚠️ Large file - consider splitting into smaller modules\n';
		}
		if (analysis.functionCount > 50) {
			result += '⚠️ High function count - consider refactoring\n';
		}
		if ('estimatedComplexity' in analysis && analysis.estimatedComplexity !== undefined && analysis.estimatedComplexity > 20) {
			result += '⚠️ High complexity - consider simplifying logic\n';
		}
		if ('todoCount' in analysis && analysis.todoCount !== undefined && analysis.todoCount > 5) {
			result += '📝 Many TODOs - consider prioritizing cleanup\n';
		}
		if ('fixmeCount' in analysis && analysis.fixmeCount !== undefined && analysis.fixmeCount > 0) {
			result += '🔧 FIXMEs found - address urgent issues\n';
		}

		return result;
	}
}

interface BasicAnalysis {
	totalLines: number;
	nonEmptyLines: number;
	codeLines: number;
	commentLines: number;
	totalCharacters: number;
	totalWords: number;
	functionCount: number;
	classCount: number;
	fileExtension: string;
}

interface DetailedAnalysis {
	estimatedComplexity: number;
	importCount: number;
	importDetails: string[];
	todoCount: number;
	fixmeCount: number;
	averageLineLength: number;
	longestLineLength: number;
	indentationStyle: string;
	averageIndentLevel: number;
}

type CodeAnalysisResult = BasicAnalysis & Partial<DetailedAnalysis>;

ToolRegistry.registerTool(CodeAnalysisTool);
