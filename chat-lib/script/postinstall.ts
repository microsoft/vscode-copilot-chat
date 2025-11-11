/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

async function copyStaticAssets(srcpaths: string[], dst: string): Promise<void> {
	await Promise.all(srcpaths.map(async srcpath => {
		const src = path.join(REPO_ROOT, srcpath);
		const dest = path.join(REPO_ROOT, dst, path.basename(srcpath));
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await fs.promises.copyFile(src, dest);
	}));
}

const treeSitterGrammars: string[] = [
	'tree-sitter-c-sharp',
	'tree-sitter-cpp',
	'tree-sitter-go',
	'tree-sitter-javascript', // Also includes jsx support
	'tree-sitter-python',
	'tree-sitter-ruby',
	'tree-sitter-typescript',
	'tree-sitter-tsx',
	'tree-sitter-java',
	'tree-sitter-rust',
	'tree-sitter-php'
];

const REPO_ROOT = path.join(__dirname, '..');

async function main() {
	const vendoredTiktokenFiles = ['dist/src/_internal/platform/tokenizer/node/cl100k_base.tiktoken', 'dist/src/_internal/platform/tokenizer/node/o200k_base.tiktoken'];

	// copy static assets to dist
	await copyStaticAssets([
		...vendoredTiktokenFiles,
		...treeSitterGrammars.map(grammar => `node_modules/@vscode/tree-sitter-wasm/wasm/${grammar}.wasm`),
		'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm',
	], 'dist');

}

main();
