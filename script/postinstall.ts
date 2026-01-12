/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { compressTikToken } from './build/compressTikToken';
import { copyStaticAssets } from './build/copyStaticAssets';

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

/**
 * @github/copilot depends on sharp which has native dependencies that are hard to distribute.
 * This function creates a shim for the sharp module that @github/copilot expects.
 * The shim provides a minimal implementation of the sharp API to satisfy @github/copilot's requirements.
 * Its non-functional and only intended to make the module load without errors.
 *
 * We create a directory @github/copilot/node_modules/sharp, so that
 * the node module resolution algorithm finds our shim instead of trying to load the real sharp module. This also ensure the shims are specific to this package.
 */
async function createCopilotCliSharpShim() {
	const copilotCli = path.join(REPO_ROOT, 'node_modules', '@github', 'copilot');
	const sharpShim = path.join(copilotCli, 'node_modules', 'sharp');

	const copilotPackageJsonFile = path.join(copilotCli, 'package.json');
	const copilotPackageJson = JSON.parse(fs.readFileSync(copilotPackageJsonFile, 'utf-8'));
	if (copilotPackageJson.dependencies) {
		delete copilotPackageJson.dependencies.sharp;
	}

	await fs.promises.writeFile(copilotPackageJsonFile, JSON.stringify(copilotPackageJson, undefined, 2), 'utf-8');
	await fs.promises.rm(sharpShim, { recursive: true, force: true });
	await fs.promises.mkdir(path.join(sharpShim, 'lib'), { recursive: true });
	await fs.promises.writeFile(path.join(sharpShim, 'package.json'), JSON.stringify({
		"name": "sharp",
		"type": "commonjs",
		"main": "lib/index.js"
	}, undefined, 2));
	await fs.promises.writeFile(path.join(sharpShim, 'lib', 'index.js'), `
const Sharp = function (inputBuffer, options) {
	if (arguments.length === 1 && !is.defined(input)) {
		throw new Error('Invalid input');
	}
	if (!(this instanceof Sharp)) {
		return new Sharp(input, options);
	}
	this.inputBuffer = inputBuffer;
	return this;
};

Sharp.prototype.resize = function () {
	const that = this;
	const img = {
		toBuffer: () => that.inputBuffer,
		png: () => img,
		jpeg: () => img
	};
	return img;
};

module.exports = Sharp;
`);

}

/**
 * @github/copilot/sdk/index.js depends on @github/copilot/worker/*.js files.
 * We need to copy these files into the sdk directory to ensure they are available at runtime.
 */
async function copyCopilotCliWorkerFiles() {
	const sourceDir = path.join(REPO_ROOT, 'node_modules', '@github', 'copilot', 'worker');
	const targetDir = path.join(REPO_ROOT, 'node_modules', '@github', 'copilot', 'sdk', 'worker');

	await fs.promises.rm(targetDir, { recursive: true, force: true });
	await fs.promises.mkdir(targetDir, { recursive: true });
	await fs.promises.cp(sourceDir, targetDir, { recursive: true, force: true });
}

async function main() {
	await fs.promises.mkdir(path.join(REPO_ROOT, '.build'), { recursive: true });

	const vendoredTiktokenFiles = ['src/platform/tokenizer/node/cl100k_base.tiktoken', 'src/platform/tokenizer/node/o200k_base.tiktoken'];

	for (const tokens of vendoredTiktokenFiles) {
		await compressTikToken(tokens, `dist/${path.basename(tokens)}`);
	}

	// copy static assets to dist
	await copyStaticAssets([
		...treeSitterGrammars.map(grammar => `node_modules/@vscode/tree-sitter-wasm/wasm/${grammar.name}.wasm`),
		'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm',
		'node_modules/@github/blackbird-external-ingest-utils/pkg/nodejs/external_ingest_utils_bg.wasm',
	], 'dist');

	await createCopilotCliSharpShim();
	await copyCopilotCliWorkerFiles();

	// Check if the base cache file exists
	const baseCachePath = path.join('test', 'simulation', 'cache', 'base.sqlite');
	if (!fs.existsSync(baseCachePath)) {
		throw new Error(`Base cache file does not exist at ${baseCachePath}. Please ensure that you have git lfs installed and initialized before the repository is cloned.`);
	}

	await copyStaticAssets([
		`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`,
	], 'dist');
}

main();
