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
 * @github/copilot/sdk/index.js depends on @github/copilot/worker/*.js files.
 * We need to copy these files into the sdk directory to ensure they are available at runtime.
 */
async function copyCopilotCliWorkerFiles() {
	const sourceDir = path.join(REPO_ROOT, 'node_modules', '@github', 'copilot', 'worker');
	const targetDir = path.join(REPO_ROOT, 'node_modules', '@github', 'copilot', 'sdk', 'worker');

	await copyCopilotCLIFolders(sourceDir, targetDir);
}

async function copyCopilotCliSharpFiles() {
	const sourceDir = path.join(REPO_ROOT, 'node_modules', '@github', 'copilot', 'sharp');
	const targetDir = path.join(REPO_ROOT, 'node_modules', '@github', 'copilot', 'sdk', 'sharp');

	await copyCopilotCLIFolders(sourceDir, targetDir);
}

async function copyCopilotCLIFolders(sourceDir: string, targetDir: string) {
	await fs.promises.rm(targetDir, { recursive: true, force: true });
	await fs.promises.mkdir(targetDir, { recursive: true });
	await fs.promises.cp(sourceDir, targetDir, { recursive: true, force: true });
}

/**
 * Patches the bundled @github/copilot CLI so session-scoped external models appear
 * alongside GitHub Copilot models in the /select-model picker, and their completions
 * can route to configured OpenAI-compatible endpoints instead of the GitHub API.
 *
 * Two targeted string replacements — easily reversible via .bak files created here:
 *
 *  1. npm-loader.js: skip the sealed native binary so our patched index.js runs.
 *  2. index.js: inject a globalThis.fetch interceptor for external model completions
 *     routing, and extend wqn() to append external models from env.
 *
 * The env vars that drive this at runtime (set by copilotCLITerminalIntegration.ts):
 *   COPILOT_EXTERNAL_MODELS        — comma-separated list of external model IDs
 *   COPILOT_EXTERNAL_MODEL_ROUTES  — JSON map of model ID -> { baseUrl, authorization? }
 *   COPILOT_LOCAL_MODELS           — backward-compatible local model list
 *   COPILOT_LOCAL_BASE_URL         — backward-compatible default local provider base URL
 */
async function patchCopilotCLIForLocalModels() {
	const CLI_DIR = path.join(REPO_ROOT, 'node_modules', '@github', 'copilot');

	// --- npm-loader.js: skip native sealed binary, use index.js instead ---
	const loaderPath = path.join(CLI_DIR, 'npm-loader.js');
	const loaderOrig = await fs.promises.readFile(loaderPath, 'utf8');
	const LOADER_OLD = `import{spawnSync as e}from"node:child_process";import{fileURLToPath as s}from"node:url";async function t(){try{const o=s(import.meta.resolve(\`@github/copilot-\${process.platform}-\${process.arch}\`)),r=e(o,process.argv.slice(2),{stdio:"inherit"});process.exit(r.status??1)}catch{}`;
	const LOADER_NEW = `import{spawnSync as e}from"node:child_process";import{fileURLToPath as s}from"node:url";async function t(){/* PATCHED: skip sealed native binary so index.js (which has local-model patches) runs instead */`;
	if (loaderOrig.includes(LOADER_OLD)) {
		await fs.promises.writeFile(loaderPath + '.bak', loaderOrig);
		await fs.promises.writeFile(loaderPath, loaderOrig.replace(LOADER_OLD, LOADER_NEW));
		console.log('[postinstall] patched npm-loader.js');
	} else if (!loaderOrig.includes('PATCHED: skip sealed native binary')) {
		console.warn('[postinstall] WARNING: npm-loader.js patch anchor not found — skipping (CLI may have updated)');
	}

	// --- index.js patch 1: fetch interceptor for external model completions routing ---
	const indexPath = path.join(CLI_DIR, 'index.js');
	const indexOrig = await fs.promises.readFile(indexPath, 'utf8');
	const INDEX_ANCHOR_OLD = '*/\nimport __module from "module";\nimport __path from "path";\nconst __rootRequire = __module.createRequire(import.meta.url);';
	const INDEX_ANCHOR_NEW = `*/
// PATCH START: external model injection
{const __extIds=(process.env.COPILOT_EXTERNAL_MODELS||process.env.COPILOT_LOCAL_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean);const __routes={};try{const raw=process.env.COPILOT_EXTERNAL_MODEL_ROUTES;if(raw){const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){for(const [id,route] of Object.entries(parsed)){if(!id||!route)continue;if(typeof route==='string'){__routes[id]={baseUrl:route};continue;}if(typeof route!=='object'||Array.isArray(route))continue;const baseUrl=typeof route.baseUrl==='string'?route.baseUrl:undefined;const authorization=typeof route.authorization==='string'?route.authorization:undefined;if(baseUrl){__routes[id]={baseUrl,authorization};}}}}}catch{}const __localBase=(process.env.COPILOT_LOCAL_BASE_URL||process.env.COPILOT_EXTERNAL_BASE_URL||'http://127.0.0.1:11434/v1');for(const id of (process.env.COPILOT_LOCAL_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean)){if(!__routes[id]){__routes[id]={baseUrl:__localBase,authorization:'Bearer local'};}}if(__extIds.length>0){const __origFetch=globalThis.fetch;globalThis.fetch=async(url,opts)=>{if(opts?.body){try{const body=typeof opts.body==='string'?JSON.parse(opts.body):opts.body;const route=body?.model?__routes[body.model]:undefined;if(route&&String(url).includes('/chat/completions')){const headers={...(opts.headers||{}),'Content-Type':'application/json'};if(route.authorization&&!headers.Authorization&&!headers.authorization){headers.Authorization=route.authorization;}const base=String(route.baseUrl||'').replace(/\/$/,'');return __origFetch(base+'/chat/completions',{...opts,headers});}}catch{}}return __origFetch(url,opts);};}}
// PATCH END: external model injection
import __module from "module";
import __path from "path";
const __rootRequire = __module.createRequire(import.meta.url);`;

	// --- index.js patch 2: wqn() append external models to picker list ---
	const WQN_OLD = `function wqn(t){return t.filter(e=>zO(e.id)&&NC(e.id,t)).sort((e,n)=>GW.indexOf(e.id)-GW.indexOf(n.id))}`;
	const WQN_NEW = `function wqn(t){const __base=t.filter(e=>zO(e.id)&&NC(e.id,t)).sort((e,n)=>GW.indexOf(e.id)-GW.indexOf(n.id));const __externalIds=(process.env.COPILOT_EXTERNAL_MODELS||process.env.COPILOT_LOCAL_MODELS||'').split(',').map(s=>s.trim()).filter(id=>id&&!__base.find(m=>m.id===id));return[...__base,...__externalIds.map(id=>({id,name:id,billing:{multiplier:0},policy:{state:'enabled'}}))]}`;

	let indexPatched = indexOrig;
	let changed = false;

	if (indexOrig.includes(INDEX_ANCHOR_OLD)) {
		indexPatched = indexPatched.replace(INDEX_ANCHOR_OLD, INDEX_ANCHOR_NEW);
		changed = true;
		console.log('[postinstall] patched index.js: fetch interceptor');
	} else if (!indexOrig.includes('PATCH START: external model injection')) {
		console.warn('[postinstall] WARNING: index.js fetch-interceptor anchor not found — skipping (CLI may have updated)');
	}

	if (indexOrig.includes(WQN_OLD)) {
		indexPatched = indexPatched.replace(WQN_OLD, WQN_NEW);
		changed = true;
		console.log('[postinstall] patched index.js: wqn() external models');
	} else if (!indexOrig.includes('__externalIds=(process.env.COPILOT_EXTERNAL_MODELS')) {
		console.warn('[postinstall] WARNING: index.js wqn() anchor not found — skipping (CLI may have updated)');
	}

	if (changed) {
		await fs.promises.writeFile(indexPath + '.bak', indexOrig);
		await fs.promises.writeFile(indexPath, indexPatched);
	}
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

	await copyCopilotCliWorkerFiles();
	await copyCopilotCliSharpFiles();
	await patchCopilotCLIForLocalModels();

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
