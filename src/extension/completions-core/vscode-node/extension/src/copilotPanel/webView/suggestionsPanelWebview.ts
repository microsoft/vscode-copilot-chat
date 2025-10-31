/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { provideVSCodeDesignSystem, vsCodeButton } from '@vscode/webview-ui-toolkit';

const solutionsContainer = document.getElementById('solutionsContainer');
const vscode = acquireVsCodeApi();
let currentFocusIndex: number;

provideVSCodeDesignSystem().register(vsCodeButton());

type Message = {
	command: string;
	solutions: {
		htmlSnippet: string;
		citation?: {
			message: string;
			url: string;
		};
	}[];
	percentage: number;
};

window.addEventListener('DOMContentLoaded', () => {
	// Notify the extension that the webview is ready
	vscode.postMessage({ command: 'webviewReady' });
});

window.addEventListener('message', function (event) {
	const message = event.data as Message; // The JSON data our extension sent

	switch (message.command) {
		case 'solutionsUpdated':
			handleSolutionUpdate(message);
			break;
		case 'navigatePreviousSolution':
			navigatePreviousSolution();
			break;
		case 'navigateNextSolution':
			navigateNextSolution();
			break;
	}
});

function handleSolutionUpdate(message: Message) {
	updateLoadingContainer(message);

	if (solutionsContainer) {
		solutionsContainer.innerHTML = message.solutions
			.map((solution, index) => {
				const renderedCitation = solution.citation
					? `<p>
						<span class="codicon codicon-warning" style="vertical-align: text-bottom" aria-hidden="true"></span>
						${solution.citation.message}
						<a href="${solution.citation.url}" target="_blank">Inspect source code</a>
					  </p>`
					: '';

				return `<h3 class='solutionHeading' id="solution-${index + 1}-heading">Suggestion ${index + 1}</h3>
				<div class='snippetContainer' aria-labelledby="solution-${index + 1}-heading" role="group">${solution.htmlSnippet
					}</div>
				${renderedCitation}
				<vscode-button role="button" class="acceptButton" id="acceptButton${index}" appearance="secondary">Accept suggestion ${index + 1
					}</vscode-button>`;
			})
			.join('');
	}
	addFocusHandlers();
	addClickHandlers();
}

function navigatePreviousSolution() {
	const snippets = document.querySelectorAll<HTMLElement>('.snippetContainer pre');
	const prevIndex = currentFocusIndex - 1;

	snippets[prevIndex]?.focus();
}

function navigateNextSolution() {
	const snippets = document.querySelectorAll<HTMLElement>('.snippetContainer pre');
	const nextIndex = (currentFocusIndex ?? -1) + 1;

	if (snippets[nextIndex]) {
		snippets[nextIndex].focus();
	} else if (snippets[0]) {
		snippets[0].focus();
	}
}

function updateLoadingContainer(message: Message) {
	const progressBar = document.getElementById('progress-bar') as HTMLProgressElement;
	const loadingContainer = document.getElementById('loadingContainer') as HTMLDivElement;
	if (!progressBar || !loadingContainer) {
		return;
	}
	if (message.percentage >= 100) {
		loadingContainer.innerHTML = `${message.solutions.length} Suggestions`;
	} else {
		const loadingLabelElement = loadingContainer.querySelector('label') as HTMLLabelElement;
		if (loadingLabelElement.textContent !== 'Loading suggestions:\u00A0') {
			loadingLabelElement.textContent = 'Loading suggestions:\u00A0';
		}
		progressBar.value = message.percentage;
	}
}

function handleFocus(index: number) {
	currentFocusIndex = index;
	vscode.postMessage({
		command: 'focusSolution',
		solutionIndex: index,
	});
}

function addFocusHandlers() {
	const snippets = document.querySelectorAll('.snippetContainer pre');
	snippets.forEach((snippet, index) => {
		snippet.addEventListener('focus', () => handleFocus(index));
		// add focus listener to button sibling as well
		const button = document.getElementById(`acceptButton${index}`);
		if (button) {
			button.addEventListener('focus', () => handleFocus(index));
		}
	});
}

function handleClick(index: number) {
	vscode.postMessage({
		command: 'acceptSolution',
		solutionIndex: index,
	});
}

function addClickHandlers() {
	const acceptButtons = document.querySelectorAll('.acceptButton');
	acceptButtons.forEach((acceptButton, index) => {
		acceptButton.addEventListener('click', () => handleClick(index));
	});
}
