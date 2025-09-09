/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { downloadZMQ } from '@vscode/zeromq';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { compressTikToken } from './build/compressTikToken';
import { copyStaticAssets } from './build/copyStaticAssets';

// Check Node.js version before proceeding
function checkNodeVersion(): void {
	const packageJsonPath = path.join(__dirname, 'package.json');
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	
	const requiredNodeVersion = packageJson.engines?.node;
	if (!requiredNodeVersion) {
		return;
	}
	
	const currentNodeVersion = process.version;
	const currentVersion = currentNodeVersion.slice(1);
	
	const requiredMatch = requiredNodeVersion.match(/>=(\d+)\.(\d+)\.(\d+)/);
	if (!requiredMatch) {
		return;
	}
	
	const [, reqMajor, reqMinor, reqPatch] = requiredMatch.map(Number);
	const [currentMajor, currentMinor, currentPatch] = currentVersion.split('.').map(Number);
	
	const isVersionValid = 
		currentMajor > reqMajor || 
		(currentMajor === reqMajor && currentMinor > reqMinor) ||
		(currentMajor === reqMajor && currentMinor === reqMinor && currentPatch >= reqPatch);
	
	if (!isVersionValid) {
		console.error('\n❌ Node.js version requirement not met!');
		console.error(`Required: ${requiredNodeVersion}`);
		console.error(`Current:  ${currentNodeVersion}`);
		console.error('\nPlease upgrade your Node.js version.');
		console.error('Run: npm run check-env for detailed instructions.');
		process.exit(1);
	}
}

export interface ITreeSitterGrammar {
	name: string;
	/**
	 * A custom .wasm filename if the grammar node module doesn't follow the standard naming convention
	 */
	filename?: string;
	/**
	 * The path where we should spawn `tree-sitter build-wasm`
	 */
	projectPath?: string;
}

const treeSitterGrammars: ITreeSitterGrammar[] = [
	{
		name: 'tree-sitter-c-sharp',
		filename: 'tree-sitter-c_sharp.wasm' // non-standard filename
	},
	{
		name: 'tree-sitter-cpp',
	},
	{
		name: 'tree-sitter-go',
	},
	{
		name: 'tree-sitter-javascript', // Also includes jsx support
	},
	{
		name: 'tree-sitter-python',
	},
	{
		name: 'tree-sitter-ruby',
	},
	{
		name: 'tree-sitter-typescript',
		projectPath: 'tree-sitter-typescript/typescript', // non-standard path
	},
	{
		name: 'tree-sitter-tsx',
		projectPath: 'tree-sitter-typescript/tsx', // non-standard path
	},
	{
		name: 'tree-sitter-java',
	},
	{
		name: 'tree-sitter-rust',
	},
	{
		name: 'tree-sitter-php'
	}
];

const REPO_ROOT = path.join(__dirname, '..');

async function main() {
	// Check Node.js version before starting
	checkNodeVersion();
	
	await fs.promises.mkdir(path.join(REPO_ROOT, '.build'), { recursive: true });

	const vendoredTiktokenFiles = ['src/platform/tokenizer/node/cl100k_base.tiktoken', 'src/platform/tokenizer/node/o200k_base.tiktoken'];

	for (const tokens of vendoredTiktokenFiles) {
		await compressTikToken(tokens, `dist/${path.basename(tokens)}`);
	}

	// copy static assets to dist
	await copyStaticAssets([
		...treeSitterGrammars.map(grammar => `node_modules/@vscode/tree-sitter-wasm/wasm/${grammar.name}.wasm`),
		'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm',
	], 'dist');

	await downloadZMQ();

	// Check if the base cache file exists
	const baseCachePath = path.join('test', 'simulation', 'cache', 'base.sqlite');
	if (!fs.existsSync(baseCachePath)) {
		throw new Error(`Base cache file does not exist at ${baseCachePath}. Please ensure that you have git lfs installed and initialized before the repository is cloned.`);
	}

	await copyStaticAssets([
		`node_modules/@anthropic-ai/claude-code/cli.js`,
		`node_modules/@anthropic-ai/claude-code/yoga.wasm`,
		// `node_modules/@anthropic-ai/claude-code/vendor/ripgrep/${process.arch}-${process.platform}/ripgrep`,
	], 'dist');
}

main();
