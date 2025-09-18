/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatResponseMarkdownPart, MarkdownString } from '../../../../vscodeTypes';

/**
 * Interface for parallel task button data embedded in tool responses
 */
interface ParallelTaskButtonData {
	title: string;
	command: string;
	arguments: Array<{
		title: string;
		description: string;
		category: string;
		priority: string;
		canRunInBackground: boolean;
		estimatedDuration: string;
	}>;
}

/**
 * A stream wrapper that detects parallel task suggestions and automatically renders interactive buttons.
 * This works as a transparent proxy that intercepts markdown content to detect button data.
 */
export class ParallelTaskButtonStream {
	constructor(private readonly wrappedStream: vscode.ChatResponseStream) { }

	/**
	 * Process markdown content and forward to wrapped stream, detecting button data
	 */
	markdown(value: string | MarkdownString): void {
		const markdownContent = typeof value === 'string' ? value : value.value;

		// Process any button data in the content
		this.processMarkdownContent(markdownContent);

		// Pass cleaned content to wrapped stream
		const cleanedContent = this.cleanButtonData(markdownContent);
		if (typeof value === 'string') {
			this.wrappedStream.markdown(cleanedContent);
		} else {
			const cleanedMarkdown = new MarkdownString(cleanedContent);
			// Copy properties from original
			cleanedMarkdown.isTrusted = value.isTrusted;
			cleanedMarkdown.supportThemeIcons = value.supportThemeIcons;
			cleanedMarkdown.supportHtml = value.supportHtml;
			cleanedMarkdown.baseUri = value.baseUri;
			this.wrappedStream.markdown(cleanedMarkdown);
		}
	}

	/**
	 * Process chat response parts and forward to wrapped stream, detecting button data in markdown parts
	 */
	push(part: vscode.ChatResponsePart): void {
		if (part instanceof ChatResponseMarkdownPart) {
			// Process markdown part for button data
			const markdownValue = part.value;
			const markdownContent = typeof markdownValue === 'string' ? markdownValue : markdownValue.value;

			this.processMarkdownContent(markdownContent);

			// Create cleaned part and forward
			const cleanedContent = this.cleanButtonData(markdownContent);
			const cleanedPart = new ChatResponseMarkdownPart(cleanedContent);
			this.wrappedStream.push(cleanedPart);
		} else {
			// Forward other parts unchanged
			this.wrappedStream.push(part);
		}
	}

	/**
	 * Forward common stream methods to wrapped stream
	 */
	anchor(value: vscode.Uri | vscode.Location): void {
		this.wrappedStream.anchor(value);
	}

	button(command: vscode.Command): void {
		this.wrappedStream.button(command);
	}

	filetree(value: vscode.ChatResponseFileTree[], baseUri: vscode.Uri): void {
		this.wrappedStream.filetree(value, baseUri);
	}

	progress(value: string): void {
		this.wrappedStream.progress(value);
	}

	reference(value: vscode.Uri | vscode.Location): void {
		this.wrappedStream.reference(value);
	}

	textEdit(target: vscode.Uri, edits: vscode.TextEdit | vscode.TextEdit[]): void;
	textEdit(target: vscode.Uri, isDone: true): void;
	textEdit(target: vscode.Uri, editsOrDone: vscode.TextEdit | vscode.TextEdit[] | true): void {
		if (editsOrDone === true) {
			this.wrappedStream.textEdit(target, editsOrDone);
		} else {
			this.wrappedStream.textEdit(target, editsOrDone);
		}
	}

	/**
	 * Processes markdown content looking for parallel task button data
	 */
	private processMarkdownContent(content: string): void {
		// Look for HTML comments with BUTTON_DATA
		const buttonDataMatches = content.match(/<!-- BUTTON_DATA: (.*?) -->/g);

		if (buttonDataMatches) {
			// Process each button data found
			for (const match of buttonDataMatches) {
				try {
					const jsonStart = match.indexOf('{');
					const jsonEnd = match.lastIndexOf('}') + 1;
					const jsonData = match.substring(jsonStart, jsonEnd);
					const buttonData: ParallelTaskButtonData = JSON.parse(jsonData);

					// Create and render the button
					this.renderParallelTaskButton(buttonData);
				} catch (error) {
					console.warn('Failed to parse parallel task button data:', error);
				}
			}
		}
	}

	/**
	 * Renders an interactive button for a parallel task
	 */
	private renderParallelTaskButton(buttonData: ParallelTaskButtonData): void {
		const taskArg = buttonData.arguments[0];
		const priorityIcon = this.getPriorityIcon(taskArg.priority);
		const backgroundIcon = taskArg.canRunInBackground ? '🔄' : '⚪';

		// Create the command for the button
		const command: vscode.Command = {
			title: `${priorityIcon} ${taskArg.title} ${backgroundIcon}`,
			command: buttonData.command,
			arguments: buttonData.arguments,
			tooltip: `${taskArg.description} (${taskArg.estimatedDuration})`
		};

		// Render the button to the wrapped stream
		this.wrappedStream.button(command);
	}

	/**
	 * Gets the priority icon for a task
	 */
	private getPriorityIcon(priority: string): string {
		switch (priority) {
			case 'High': return '🔴';
			case 'Medium': return '🟡';
			case 'Low': return '🟢';
			default: return '';
		}
	}

	/**
	 * Removes button data comments from content
	 */
	private cleanButtonData(content: string): string {
		return content.replace(/<!-- BUTTON_DATA: .*? -->/g, '');
	}
}