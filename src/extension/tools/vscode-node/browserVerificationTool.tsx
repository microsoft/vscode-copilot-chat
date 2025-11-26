/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as os from 'os';
import * as path from 'path';
import { BasePromptElementProps, PromptElement, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Schemas } from '../../../util/vs/base/common/network';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtendedLanguageModelToolResult, LanguageModelDataPart, LanguageModelPromptTsxPart, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

/**
 * Action to perform on the page before taking a screenshot
 */
export interface IBrowserAction {
	type: 'click' | 'type' | 'scroll';
	selector: string;
	value?: string;
}

/**
 * Parameters for the browser verification tool
 */
export interface IBrowserVerificationParams {
	url: string;
	actions?: IBrowserAction[];
	validateElements?: string[];
}

/**
 * Result of element validation
 */
interface ElementValidationResult {
	selector: string;
	found: boolean;
	visible: boolean;
}

/**
 * Console message captured during page load
 */
interface ConsoleMessage {
	type: string;
	text: string;
}

/**
 * Complete verification result
 */
interface VerificationResult {
	url: string;
	screenshot: Buffer;
	consoleMessages: ConsoleMessage[];
	elementValidations: ElementValidationResult[];
	loadTimeMs: number;
	success: boolean;
	error?: string;
}

/**
 * Browser Verification Tool using Playwright
 *
 * This tool launches a browser to verify web application UI by:
 * - Navigating to a URL
 * - Executing optional actions (click, type, scroll)
 * - Validating element presence
 * - Capturing screenshots
 * - Collecting console logs and errors
 */
export class BrowserVerificationTool implements ICopilotTool<IBrowserVerificationParams> {
	public static readonly toolName = ToolName.BrowserVerification;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) { }

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IBrowserVerificationParams>,
		_token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const uri = URI.parse(options.input.url);
		if (uri.scheme !== Schemas.http && uri.scheme !== Schemas.https) {
			throw new Error(l10n.t('Invalid URL scheme. Only HTTP and HTTPS are supported.'));
		}

		const confirmationMessages: vscode.LanguageModelToolConfirmationMessages = {
			title: l10n.t`Launch browser for verification?`,
			message: new MarkdownString(l10n.t`This will launch a browser to navigate to ${options.input.url} and take a screenshot for verification.`)
		};

		return {
			invocationMessage: new MarkdownString(l10n.t`Launching browser to verify ${options.input.url}`),
			pastTenseMessage: new MarkdownString(l10n.t`Verified ${options.input.url} with browser`),
			confirmationMessages
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IBrowserVerificationParams>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		this.logService.trace(`BrowserVerificationTool: invoke ${options.input.url}`);

		try {
			const result = await this.runVerification(options.input, token);
			return this.buildToolResult(result, options, token);
		} catch (error) {
			this.logService.error('BrowserVerificationTool: error', error);
			const errorMessage = error instanceof Error ? error.message : String(error);
			const toolResult = new ExtendedLanguageModelToolResult([
				new LanguageModelTextPart(l10n.t('Browser verification failed: {0}', errorMessage))
			]);
			toolResult.toolResultMessage = new MarkdownString(`❌ **Verification Failed**\n\n${errorMessage}`);
			toolResult.hasError = true;
			return toolResult;
		}
	}

	private async runVerification(
		input: IBrowserVerificationParams,
		token: vscode.CancellationToken
	): Promise<VerificationResult> {
		// Dynamically import playwright to avoid bundling issues
		const playwright = await import('playwright');

		const headless = true; // Default to headless mode
		const startTime = Date.now();
		const consoleMessages: ConsoleMessage[] = [];

		// Launch browser with chromium
		const browser = await playwright.chromium.launch({
			headless,
		});

		try {
			// Check for cancellation
			if (token.isCancellationRequested) {
				throw new Error('Operation cancelled');
			}

			const context = await browser.newContext({
				viewport: { width: 1280, height: 720 },
			});

			const page = await context.newPage();

			// Set up console message interception
			page.on('console', (msg) => {
				consoleMessages.push({
					type: msg.type(),
					text: msg.text()
				});
			});

			// Navigate to URL
			this.logService.trace(`BrowserVerificationTool: navigating to ${input.url}`);
			await page.goto(input.url, {
				waitUntil: 'networkidle',
				timeout: 30000
			});

			// Check for cancellation
			if (token.isCancellationRequested) {
				throw new Error('Operation cancelled');
			}

			// Execute actions if provided
			if (input.actions && input.actions.length > 0) {
				await this.executeActions(page, input.actions);
			}

			// Validate elements if provided
			const elementValidations: ElementValidationResult[] = [];
			if (input.validateElements && input.validateElements.length > 0) {
				for (const selector of input.validateElements) {
					const validation = await this.validateElement(page, selector);
					elementValidations.push(validation);
				}
			}

			// Take screenshot
			this.logService.trace('BrowserVerificationTool: taking screenshot');
			const screenshot = await page.screenshot({
				type: 'png',
				fullPage: false
			});

			const loadTimeMs = Date.now() - startTime;
			const hasErrors = consoleMessages.some(m => m.type === 'error');
			const allElementsValid = elementValidations.every(v => v.found && v.visible);

			return {
				url: input.url,
				screenshot,
				consoleMessages,
				elementValidations,
				loadTimeMs,
				success: !hasErrors && allElementsValid
			};
		} finally {
			await browser.close();
		}
	}

	private async executeActions(
		page: import('playwright').Page,
		actions: IBrowserAction[],
	): Promise<void> {
		for (const action of actions) {
			this.logService.trace(`BrowserVerificationTool: executing action ${action.type} on ${action.selector}`);

			switch (action.type) {
				case 'click':
					await page.click(action.selector, { timeout: 5000 });
					break;
				case 'type':
					if (action.value) {
						await page.fill(action.selector, action.value, { timeout: 5000 });
					}
					break;
				case 'scroll': {
					const scrollAmount = action.value ? parseInt(action.value, 10) : 100;
					const selector = action.selector;
					await page.evaluate(`
						(function() {
							const element = document.querySelector('${selector.replace(/'/g, "\\'")}');
							if (element) {
								element.scrollTop += ${scrollAmount};
							} else {
								window.scrollBy(0, ${scrollAmount});
							}
						})()
					`);
					break;
				}
			}

			// Small delay between actions
			await page.waitForTimeout(100);
		}
	}

	private async validateElement(
		page: import('playwright').Page,
		selector: string
	): Promise<ElementValidationResult> {
		try {
			const element = await page.$(selector);
			if (!element) {
				return { selector, found: false, visible: false };
			}

			const isVisible = await element.isVisible();
			return { selector, found: true, visible: isVisible };
		} catch {
			return { selector, found: false, visible: false };
		}
	}

	private async buildToolResult(
		result: VerificationResult,
		options: vscode.LanguageModelToolInvocationOptions<IBrowserVerificationParams>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const parts: (LanguageModelTextPart | LanguageModelDataPart | LanguageModelPromptTsxPart)[] = [];

		// Save screenshot to temp file so user can view it
		const timestamp = Date.now();
		const screenshotFileName = `browser-verification-${timestamp}.png`;
		const screenshotPath = path.join(os.tmpdir(), screenshotFileName);
		const screenshotUri = URI.file(screenshotPath);

		try {
			await this.fileSystemService.writeFile(screenshotUri, result.screenshot);
			this.logService.trace(`BrowserVerificationTool: saved screenshot to ${screenshotPath}`);
		} catch (error) {
			this.logService.error('BrowserVerificationTool: failed to save screenshot', error);
		}

		// Add screenshot as data part if the model supports images
		if (options.model?.capabilities.supportsImageToText) {
			parts.push(new LanguageModelDataPart(new Uint8Array(result.screenshot), 'image/png'));
		}

		// Build validation report using prompt-tsx
		const reportElement = await renderPromptElementJSON(
			this.instantiationService,
			BrowserVerificationReport,
			{ result },
			options.tokenizationOptions,
			token
		);

		parts.push(new LanguageModelPromptTsxPart(reportElement));

		// Create the extended tool result with user-visible summary
		const toolResult = new ExtendedLanguageModelToolResult(parts);

		// Build a nice summary message for the user
		const consoleErrors = result.consoleMessages.filter(m => m.type === 'error');
		const statusIcon = result.success ? '✅' : '⚠️';

		const summaryParts: string[] = [];
		summaryParts.push(`${statusIcon} **Verification Report**`);
		summaryParts.push('');
		summaryParts.push(`Navigated to \`${result.url}\` in ${result.loadTimeMs}ms.`);

		if (result.elementValidations.length > 0) {
			const validCount = result.elementValidations.filter(v => v.found && v.visible).length;
			summaryParts.push(`Validated ${validCount}/${result.elementValidations.length} elements.`);
		}

		if (consoleErrors.length > 0) {
			summaryParts.push(`Found ${consoleErrors.length} console error(s).`);
		}

		summaryParts.push('');
		summaryParts.push(`📸 [View Screenshot](${screenshotUri.toString()})`);

		const summaryMessage = new MarkdownString(summaryParts.join('\n'));
		summaryMessage.isTrusted = true;

		toolResult.toolResultMessage = summaryMessage;
		toolResult.toolResultDetails = [screenshotUri];

		return toolResult;
	}
}

ToolRegistry.registerTool(BrowserVerificationTool);

/**
 * Props for the verification report prompt element
 */
interface BrowserVerificationReportProps extends BasePromptElementProps {
	result: VerificationResult;
}

/**
 * Prompt element for rendering the verification report
 */
class BrowserVerificationReport extends PromptElement<BrowserVerificationReportProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		const { result } = this.props;

		const statusEmoji = result.success ? '✅' : '⚠️';
		const consoleErrors = result.consoleMessages.filter(m => m.type === 'error');
		const consoleWarnings = result.consoleMessages.filter(m => m.type === 'warning');

		return <>
			<TextChunk>
				{`## Browser Verification Report ${statusEmoji}\n\n`}
				{`**URL:** ${result.url}\n`}
				{`**Load Time:** ${result.loadTimeMs}ms\n`}
				{`**Status:** ${result.success ? 'All checks passed' : 'Issues detected'}\n\n`}
			</TextChunk>

			{consoleErrors.length > 0 && (
				<TextChunk>
					{`### Console Errors (${consoleErrors.length})\n`}
					{consoleErrors.map(e => `- ${e.text}\n`).join('')}
					{'\n'}
				</TextChunk>
			)}

			{consoleWarnings.length > 0 && (
				<TextChunk>
					{`### Console Warnings (${consoleWarnings.length})\n`}
					{consoleWarnings.map(w => `- ${w.text}\n`).join('')}
					{'\n'}
				</TextChunk>
			)}

			{result.elementValidations.length > 0 && (
				<TextChunk>
					{`### Element Validations\n`}
					{result.elementValidations.map(v =>
						`- \`${v.selector}\`: ${v.found ? (v.visible ? '✅ Found and visible' : '⚠️ Found but not visible') : '❌ Not found'}\n`
					).join('')}
					{'\n'}
				</TextChunk>
			)}

			{!result.success && result.error && (
				<TextChunk>
					{`### Error\n${result.error}\n`}
				</TextChunk>
			)}
		</>;
	}
}
