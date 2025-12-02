/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { getLanguage, ILanguage } from '../../../../../util/common/languages';
import { Uri } from '../../../../../vscodeTypes';
import { FilePathCodeMarker } from '../selectionContextHelpers';

describe('FilePathCodeMarker', () => {
	describe('forLanguage', () => {
		it('returns correct marker for TypeScript', () => {
			const language = getLanguage('typescript');
			const marker = FilePathCodeMarker.forLanguage(language);
			expect(marker).toBe('// FILEPATH');
		});

		it('returns correct marker for Python', () => {
			const language = getLanguage('python');
			const marker = FilePathCodeMarker.forLanguage(language);
			expect(marker).toBe('# FILEPATH');
		});

		it('returns correct marker for HTML', () => {
			const language = getLanguage('html');
			const marker = FilePathCodeMarker.forLanguage(language);
			expect(marker).toBe('<!-- FILEPATH');
		});

		it('returns correct marker for CSS', () => {
			const language = getLanguage('css');
			const marker = FilePathCodeMarker.forLanguage(language);
			expect(marker).toBe('/* FILEPATH');
		});

		it('returns correct marker for SQL', () => {
			const language = getLanguage('sql');
			const marker = FilePathCodeMarker.forLanguage(language);
			expect(marker).toBe('-- FILEPATH');
		});

		it('returns correct marker for Ruby', () => {
			const language = getLanguage('ruby');
			const marker = FilePathCodeMarker.forLanguage(language);
			expect(marker).toBe('# FILEPATH');
		});
	});

	describe('forUri', () => {
		it('returns correct marker with file path for TypeScript', () => {
			const language = getLanguage('typescript');
			const uri = Uri.file('/home/user/project/src/index.ts');
			const marker = FilePathCodeMarker.forUri(language, uri);
			expect(marker).toBe('// FILEPATH: /home/user/project/src/index.ts');
		});

		it('returns correct marker with file path for Python', () => {
			const language = getLanguage('python');
			const uri = Uri.file('/home/user/project/main.py');
			const marker = FilePathCodeMarker.forUri(language, uri);
			expect(marker).toBe('# FILEPATH: /home/user/project/main.py');
		});

		it('handles paths with special characters', () => {
			const language = getLanguage('typescript');
			const uri = Uri.file('/home/user/my-project/src/[id].ts');
			const marker = FilePathCodeMarker.forUri(language, uri);
			expect(marker).toBe('// FILEPATH: /home/user/my-project/src/[id].ts');
		});

		it('handles Windows-style paths', () => {
			const language = getLanguage('typescript');
			const uri = Uri.file('C:/Users/user/project/src/index.ts');
			const marker = FilePathCodeMarker.forUri(language, uri);
			expect(marker).toContain('// FILEPATH:');
			expect(marker).toContain('index.ts');
		});
	});

	describe('testLine', () => {
		it('returns true for valid TypeScript file path marker', () => {
			const language = getLanguage('typescript');
			const code = '// FILEPATH: /home/user/project/src/index.ts';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(true);
		});

		it('returns true for valid Python file path marker', () => {
			const language = getLanguage('python');
			const code = '# FILEPATH: /home/user/project/main.py';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(true);
		});

		it('returns true for marker with leading whitespace', () => {
			const language = getLanguage('typescript');
			const code = '    // FILEPATH: /home/user/project/src/index.ts';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(true);
		});

		it('returns true for marker with tabs as leading whitespace', () => {
			const language = getLanguage('typescript');
			const code = '\t\t// FILEPATH: /home/user/project/src/index.ts';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(true);
		});

		it('returns false for regular comment without FILEPATH', () => {
			const language = getLanguage('typescript');
			const code = '// This is a regular comment';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(false);
		});

		it('returns false for code line', () => {
			const language = getLanguage('typescript');
			const code = 'const x = 1;';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(false);
		});

		it('returns false for empty string', () => {
			const language = getLanguage('typescript');
			expect(FilePathCodeMarker.testLine(language, '')).toBe(false);
		});

		it('returns false for whitespace only string', () => {
			const language = getLanguage('typescript');
			expect(FilePathCodeMarker.testLine(language, '   ')).toBe(false);
		});

		it('returns false for FILEPATH marker with wrong comment style', () => {
			const language = getLanguage('typescript');
			// TypeScript uses //, not #
			const code = '# FILEPATH: /home/user/project/main.py';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(false);
		});

		it('returns false for partial FILEPATH marker', () => {
			const language = getLanguage('typescript');
			const code = '// FILE: /home/user/project/src/index.ts';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(false);
		});

		it('returns true for just the marker without path', () => {
			const language = getLanguage('typescript');
			const code = '// FILEPATH';
			expect(FilePathCodeMarker.testLine(language, code)).toBe(true);
		});
	});

	describe('round trip consistency', () => {
		it('forUri output is recognized by testLine', () => {
			const language = getLanguage('typescript');
			const uri = Uri.file('/home/user/project/src/index.ts');
			const marker = FilePathCodeMarker.forUri(language, uri);
			expect(FilePathCodeMarker.testLine(language, marker)).toBe(true);
		});

		it('forLanguage output is recognized by testLine', () => {
			const language = getLanguage('python');
			const marker = FilePathCodeMarker.forLanguage(language);
			expect(FilePathCodeMarker.testLine(language, marker)).toBe(true);
		});

		it('works for various languages', () => {
			const languages = ['typescript', 'javascript', 'python', 'ruby', 'go', 'rust', 'java'];
			for (const langId of languages) {
				const language = getLanguage(langId);
				const marker = FilePathCodeMarker.forLanguage(language);
				expect(FilePathCodeMarker.testLine(language, marker)).toBe(true);
			}
		});
	});
});
