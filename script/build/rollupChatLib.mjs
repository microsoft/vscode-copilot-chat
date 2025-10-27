/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

import { join, dirname } from 'path';
import { defineConfig } from 'rollup';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import esbuild from 'rollup-plugin-esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CHAT_LIB_DIR = join(REPO_ROOT, 'chat-lib');
const OUTPUT_DIR = join(CHAT_LIB_DIR, 'dist', 'src');

// Entry points from extractChatLib.ts
const entryPoints = {
	'main': join(REPO_ROOT, 'src/lib/node/chatLibMain.ts'),
	'_internal/util/vs/base-common': join(REPO_ROOT, 'src/util/vs/base-common.d.ts'),
	'_internal/util/vs/vscode-globals-nls': join(REPO_ROOT, 'src/util/vs/vscode-globals-nls.d.ts'),
	'_internal/util/vs/vscode-globals-product': join(REPO_ROOT, 'src/util/vs/vscode-globals-product.d.ts'),
	'_internal/util/common/globals': join(REPO_ROOT, 'src/util/common/globals.d.ts'),
	'_internal/util/common/test/shims/vscodeTypesShim': join(REPO_ROOT, 'src/util/common/test/shims/vscodeTypesShim.ts'),
	'_internal/platform/diff/common/diffWorker': join(REPO_ROOT, 'src/platform/diff/common/diffWorker.ts'),
	'_internal/platform/tokenizer/node/tikTokenizerWorker': join(REPO_ROOT, 'src/platform/tokenizer/node/tikTokenizerWorker.ts'),
	'_internal/platform/authentication/test/node/simulationTestCopilotTokenManager': join(REPO_ROOT, 'src/platform/authentication/test/node/simulationTestCopilotTokenManager.ts'),
	'_internal/extension/completions-core/vscode-node/lib/src/test/textDocument': join(REPO_ROOT, 'src/extension/completions-core/vscode-node/lib/src/test/textDocument.ts'),
};

/**
 * @param {string} filePath
 * @param {string} newExt
 * @returns {string}
 */
function changeExt(filePath, newExt) {
	const idx = filePath.lastIndexOf('.');
	if (idx === -1) {
		return filePath + newExt;
	} else {
		return filePath.substring(0, idx) + newExt;
	}
}

export default defineConfig({
	input: entryPoints,

	output: {
		dir: OUTPUT_DIR,
		format: 'cjs',
		sourcemap: true,
		preserveModules: true,
		preserveModulesRoot: join(REPO_ROOT, 'src'),
		exports: 'auto',

		entryFileNames: function (chunkInfo) {
			const moduleId = chunkInfo.facadeModuleId;
			if (moduleId) {
				// Map chatLibMain.ts to main.js
				if (moduleId.includes('chatLibMain.ts')) {
					return 'main.js';
				}

				// Map everything else to _internal/...
				const srcPath = join(REPO_ROOT, 'src/');
				if (moduleId.startsWith(srcPath)) {
					const relativePath = moduleId.substring(srcPath.length);
					return changeExt(join('_internal', relativePath), '.js');
				}
			}
			return '[name].js';
		},
	},

	external: (id) => {
		// Keep node modules and vscode external (don't bundle)
		if (id.startsWith('vscode')) {
			return true;
		}
		// External: non-relative imports (node modules, npm packages)
		if (!id.startsWith('.') && !id.startsWith('/')) {
			return true;
		}
		// Let rollup resolve relative imports (project files)
		return false;
	},

	plugins: [
		{
			name: 'copy-files',
			buildEnd() {
				// Copy .tiktoken files
				const tokenizerDir = join(REPO_ROOT, 'src', 'platform', 'tokenizer', 'node');
				if (existsSync(tokenizerDir)) {
					const tikTokenFiles = readdirSync(tokenizerDir).filter(f => f.endsWith('.tiktoken'));

					for (const file of tikTokenFiles) {
						const srcPath = join(tokenizerDir, file);
						const destPath = join(OUTPUT_DIR, '_internal', 'platform', 'tokenizer', 'node', file);

						mkdirSync(dirname(destPath), { recursive: true });
						copyFileSync(srcPath, destPath);
					}
				}

				// Copy vscode.proposed.*.d.ts files
				const extensionDir = join(REPO_ROOT, 'src', 'extension');
				if (existsSync(extensionDir)) {
					const proposedFiles = readdirSync(extensionDir).filter(f => f.match(/^vscode\.proposed\..*\.d\.ts$/));

					for (const file of proposedFiles) {
						const srcPath = join(extensionDir, file);
						const destPath = join(OUTPUT_DIR, '_internal', 'extension', file);

						mkdirSync(dirname(destPath), { recursive: true });
						copyFileSync(srcPath, destPath);
					}
				}

				// Copy root package.json
				const rootPackageJson = join(REPO_ROOT, 'package.json');
				const destPackageJson = join(OUTPUT_DIR, 'package.json');
				copyFileSync(rootPackageJson, destPackageJson);
			}
		},

		esbuild({
			tsconfig: join(REPO_ROOT, 'tsconfig.json'),
		}),
	],

	onwarn(warning, defaultHandler) {
		// Suppress certain warnings
		if (warning.code === 'CIRCULAR_DEPENDENCY') {
			return;
		}
		if (warning.code === 'THIS_IS_UNDEFINED') {
			return;
		}
		if (warning.code === 'UNRESOLVED_IMPORT') {
			return;
		}
		defaultHandler(warning);
	},
});
