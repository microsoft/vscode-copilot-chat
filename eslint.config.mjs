/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
import stylisticEslint from '@stylistic/eslint-plugin';
import tsEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importEslint from 'eslint-plugin-import';
import jsdocEslint from 'eslint-plugin-jsdoc';
import fs from 'fs';
import path from 'path';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'url';

import headerEslint from 'eslint-plugin-header';
headerEslint.rules.header.meta.schema = false;

import localEslint from './.eslintplugin/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ignores = fs.readFileSync(path.join(__dirname, '.eslint-ignore'), 'utf8')
	.toString()
	.split(/\r\n|\n/)
	.filter(line => line && !line.startsWith('#'));

export default tseslint.config(
	// Global ignores
	{
		ignores: [
			...ignores,
			'!**/.eslint-plugin-local/**/*'
		],
	},
	// All js/ts files
	{
		files: [
			'**/*.{js,jsx,mjs,cjs,ts,tsx}',
		],
		ignores: [
			'./src/extension/completions-core/**/*'
		],
		languageOptions: {
			parser: tsParser,
		},
		plugins: {
			'@stylistic': stylisticEslint,
			'header': headerEslint,
		},
		rules: {
			'indent': [
				'error',
				'tab',
				{
					ignoredNodes: [
						'SwitchCase',
						'ClassDeclaration',
						'TemplateLiteral *' // Conflicts with tsfmt
					]
				}
			],
			'constructor-super': 'error',
			'curly': 'error',
			'eqeqeq': 'error',
			'prefer-const': [
				'error',
				{
					destructuring: 'all'
				}
			],
			'no-buffer-constructor': 'error',
			'no-caller': 'error',
			'no-case-declarations': 'error',
			'no-debugger': 'error',
			'no-duplicate-case': 'error',
			'no-duplicate-imports': 'error',
			'no-eval': 'error',
			'no-async-promise-executor': 'error',
			'no-extra-semi': 'error',
			'no-new-wrappers': 'error',
			'no-redeclare': 'off',
			'no-sparse-arrays': 'error',
			'no-throw-literal': 'error',
			'no-unsafe-finally': 'error',
			'no-unused-labels': 'error',
			'no-restricted-globals': [
				'error',
				'name',
				'length',
				'event',
				'closed',
				'external',
				'status',
				'origin',
				'orientation',
				'context'
			], // non-complete list of globals that are easy to access unintentionally
			'no-var': 'error',
			'semi': 'error',
			'header/header': [
				'error',
				'block',
				[
					'---------------------------------------------------------------------------------------------',
					' *  Copyright (c) Microsoft Corporation. All rights reserved.',
					' *  Licensed under the MIT License. See License.txt in the project root for license information.',
					' *--------------------------------------------------------------------------------------------'
				]
			]
		},
		settings: {
			'import/resolver': {
				typescript: {
					extensions: ['.ts', '.tsx']
				}
			}
		},
	},
	// All ts files
	{
		files: [
			'**/*.{ts,tsx}',
		],
		languageOptions: {
			parser: tsParser,
		},
		plugins: {
			'@typescript-eslint': tsEslint,
			'@stylistic': stylisticEslint,
			'jsdoc': jsdocEslint,
		},
		rules: {
			'jsdoc/no-types': 'error',
			'@stylistic/member-delimiter-style': 'error',
			'@typescript-eslint/naming-convention': [
				'error',
				{
					selector: 'class',
					format: ['PascalCase']
				}
			],
		},
		settings: {
			'import/resolver': {
				typescript: {
					extensions: ['.ts', '.tsx']
				}
			}
		},
	},
	// Main extension sources
	{
		files: [
			'src/**/*.{ts,tsx}',
			'test/**/*.{ts,tsx}',
		],
		ignores: [
			'**/.esbuild.ts',
		],
		languageOptions: {
			parser: tseslint.parser,
		},
		plugins: {
			'import': importEslint,
			'local': localEslint,
		},
		rules: {
			'no-restricted-imports': [
				'error',
				// node: builtins
				'assert',
				'assert/strict',
				'async_hooks',
				'buffer',
				'child_process',
				'cluster',
				'console',
				'constants',
				'crypto',
				'dgram',
				'diagnostics_channel',
				'dns',
				'dns/promises',
				'domain',
				'events',
				'fs',
				'fs/promises',
				'http',
				'http2',
				'https',
				'inspector',
				'module',
				'net',
				'os',
				'path',
				'path/posix',
				'path/win32',
				'perf_hooks',
				'process',
				'punycode',
				'querystring',
				'readline',
				'readline/promises',
				'repl',
				'stream',
				'stream/consumers',
				'stream/promises',
				'stream/web',
				'string_decoder',
				'sys',
				'timers',
				'timers/promises',
				'tls',
				'trace_events',
				'tty',
				'url',
				'util',
				'util/types',
				'v8',
				'vm',
				'wasi',
				'worker_threads',
				'zlib',
				// node: dependencies
				'@humanwhocodes/gitignore-to-minimatch',
				'@vscode/extension-telemetry',
				'applicationinsights',
				'ignore',
				'isbinaryfile',
				'minimatch',
				'source-map-support',
				'vscode-tas-client',
				'web-tree-sitter'
			],
			'import/no-restricted-paths': [
				'error',
				{
					zones: [
						{
							target: '**/common/**',
							from: [
								'**/vscode/**',
								'**/node/**',
								'**/vscode-node/**',
								'**/worker/**',
								'**/vscode-worker/**'
							]
						},
						{
							target: '**/vscode/**',
							from: [
								'**/node/**',
								'**/vscode-node/**',
								'**/worker/**',
								'**/vscode-worker/**'
							]
						},
						{
							target: '**/node/**',
							from: [
								'**/vscode/**',
								'**/vscode-node/**',
								'**/worker/**',
								'**/vscode-worker/**'
							]
						},
						{
							target: '**/vscode-node/**',
							from: [
								'**/worker/**',
								'**/vscode-worker/**'
							]
						},
						{
							target: '**/worker/**',
							from: [
								'**/vscode/**',
								'**/node/**',
								'**/vscode-node/**',
								'**/vscode-worker/**'
							]
						},
						{
							target: '**/vscode-worker/**',
							from: [
								'**/node/**',
								'**/vscode-node/**'
							]
						},
						{
							target: './src/',
							from: './test/'
						},
						{
							target: './src/util',
							from: ['./src/platform', './src/extension']
						},
						{
							target: './src/platform',
							from: ['./src/extension']
						},
						{
							target: ['./test', '!./test/base/extHostContext/*.ts'],
							from: ['**/vscode-node/**', '**/vscode-worker/**']
						}
					]
				}
			],
			'local/no-instanceof-uri': ['error'],
			'local/no-test-imports': ['error'],
			'local/no-runtime-import': [
				'error',
				{
					test: ['vscode'],
					'src/**/common/**/*': ['vscode'],
					'src/**/node/**/*': ['vscode']
				}
			],
			'local/no-funny-filename': ['error'],
			'local/no-bad-gdpr-comment': ['error'],
			'local/no-gdpr-event-name-mismatch': ['error'],
			'local/no-unlayered-files': ['error'],
			'local/no-restricted-copilot-pr-string': [
				'error',
				{
					className: 'GitHubPullRequestProviders',
					string: 'Generate with Copilot'
				}
			],
		}
	},
	{
		files: ['**/{vscode-node,node}/**/*.ts', '**/{vscode-node,node}/**/*.tsx'],
		rules: {
			'no-restricted-imports': 'off'
		}
	},
	{
		files: ['**/*.js'],
		rules: {
			'jsdoc/no-types': 'off'
		}
	},
	{
		files: ['src/extension/**/*.tsx'],
		rules: {
			'local/no-missing-linebreak': 'error'
		}
	},
	{
		files: ['**/*.test.ts', '**/*.test.tsx'],
		rules: {
			'local/no-test-only': 'error'
		}
	},
	{
		files: [
			'test/**',
			'src/vscodeTypes.ts',
			'script/**',
			'src/extension/*.d.ts',
			'build/**'
		],
		rules: {
			'local/no-unlayered-files': 'off',
			'no-restricted-imports': 'off'
		}
	}
);
