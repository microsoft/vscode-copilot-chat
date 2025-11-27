/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { InlineEditRequestLogContext } from '../../common/inlineEditLogContext';
import { Icon } from '../../common/utils/utils';

describe('InlineEditRequestLogContext', () => {
	describe('icon state', () => {
		it('should return undefined icon by default', () => {
			const logContext = new InlineEditRequestLogContext('/test/file.ts', 1, undefined);
			expect(logContext.getIcon()).toBeUndefined();
		});

		it('should set circleSlash icon when markAsNoSuggestions is called', () => {
			const logContext = new InlineEditRequestLogContext('/test/file.ts', 1, undefined);
			logContext.markAsNoSuggestions();
			expect(logContext.getIcon()).toBe(Icon.circleSlash.themeIcon);
		});

		it('should set lightbulbFull icon when setResponseResults is called with results', () => {
			const logContext = new InlineEditRequestLogContext('/test/file.ts', 1, undefined);
			logContext.setResponseResults([{ some: 'result' }]);
			expect(logContext.getIcon()).toBe(Icon.lightbulbFull.themeIcon);
		});

		it('should set skipped icon when setIsSkipped is called', () => {
			const logContext = new InlineEditRequestLogContext('/test/file.ts', 1, undefined);
			logContext.setIsSkipped();
			expect(logContext.getIcon()).toBe(Icon.skipped.themeIcon);
		});
	});

	describe('includeInLogTree', () => {
		it('should be false by default', () => {
			const logContext = new InlineEditRequestLogContext('/test/file.ts', 1, undefined);
			expect(logContext.includeInLogTree).toBe(false);
		});

		it('should be true after markAsNoSuggestions is called', () => {
			const logContext = new InlineEditRequestLogContext('/test/file.ts', 1, undefined);
			logContext.markAsNoSuggestions();
			expect(logContext.includeInLogTree).toBe(true);
		});

		it('should be false after setIsSkipped is called', () => {
			const logContext = new InlineEditRequestLogContext('/test/file.ts', 1, undefined);
			logContext.setIsSkipped();
			expect(logContext.includeInLogTree).toBe(false);
		});
	});
});
