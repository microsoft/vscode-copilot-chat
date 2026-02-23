/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('@vscode/webview-ui-toolkit', () => ({
	provideVSCodeDesignSystem: () => ({
		register: vi.fn(),
	}),
	vsCodeButton: vi.fn(),
}));

vi.mock('dompurify', () => {
    return {
	default: {
		sanitize: (str: string) => str, // Simple pass-through for testing structure
	},
    };
});

describe('suggestionsPanelWebview', () => {
    let container: HTMLElement;
    let loadingContainer: HTMLElement;

    beforeEach(async () => {
        // Setup DOM
        document.body.innerHTML = `
            <div id="loadingContainer">
                <label>Loading suggestions:</label>
                <progress id="progress-bar"></progress>
            </div>
            <div id="solutionsContainer"></div>
        `;
        container = document.getElementById('solutionsContainer')!;
        loadingContainer = document.getElementById('loadingContainer')!;

        // Mock acquireVsCodeApi
        (window as any).acquireVsCodeApi = () => ({
		postMessage: vi.fn(),
		setState: vi.fn(),
		getState: vi.fn(),
        });

        // Import the module to run the script
        vi.resetModules();
        await import('./suggestionsPanelWebview');
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.clearAllMocks();
    });

    it('renders citation with warning correctly', async () => {
        const message = {
		command: 'solutionsUpdated',
		solutions: [
			{
				htmlSnippet: '<pre>code</pre>',
				citation: {
					message: 'Similar code detected',
					url: 'http://example.com',
				},
			},
		],
		percentage: 100,
        };

        // Dispatch message
        window.postMessage(message, '*');

        // Wait for any potential async updates
        await new Promise(resolve => setTimeout(resolve, 0));

        // Let's inspect the container
        const solutions = container.innerHTML;

        // Verify FIXED behavior
        // Check for presence of rel="noopener noreferrer"
        expect(solutions).toContain('<a href="http://example.com" target="_blank" rel="noopener noreferrer">Inspect source code</a>');

        // Check for improved warning (visible, bold, with icon)
        // Note: innerHTML might escape entities differently depending on jsdom version,
        // so we check for the expected output string or parts of it.
        // &#9888; might be rendered as the character itself.
        // Let's check loosely or try to match exactly if we know how jsdom behaves.
        // Usually innerHTML unescapes entities. &#9888; becomes ⚠.
        expect(solutions).toContain('<span style="vertical-align: text-bottom"><strong>⚠ Warning:</strong></span>');

        // Ensure aria-hidden is gone
        expect(solutions).not.toContain('aria-hidden="true"');
    });

    it('does not render malicious citation URL', async () => {
        const message = {
            command: 'solutionsUpdated',
            solutions: [
                {
                    htmlSnippet: '<pre>code</pre>',
                    citation: {
                        message: 'Similar code detected',
                        // Malicious URL
                        url: 'javascript:alert(1)',
                    },
                },
            ],
            percentage: 100,
        };

        // Dispatch message
        window.postMessage(message, '*');

        // Wait for any potential async updates
        await new Promise(resolve => setTimeout(resolve, 0));

        // Let's inspect the container
        const solutions = container.innerHTML;

        // Expect the href to be sanitized to '#'
        expect(solutions).toContain('href="#"');
        expect(solutions).not.toContain('javascript:alert(1)');
    });
});
