/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as watcher from '@parcel/watcher';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import { copyFile, mkdir } from 'fs/promises';
import { glob } from 'glob';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname);
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');
const isPreRelease = process.argv.includes('--prerelease');

const baseBuildOptions = {
	bundle: true,
	logLevel: 'info',
	minify: !isDev,
	outdir: './dist',
	sourcemap: isDev ? 'linked' : false,
	sourcesContent: false,
	treeShaking: true
} satisfies esbuild.BuildOptions;

const baseNodeBuildOptions = {
	...baseBuildOptions,
	external: [
		'./package.json',
		'./.vscode-test.mjs',
		'playwright',
		'keytar',
		'@azure/functions-core',
		'applicationinsights-native-metrics',
		'@opentelemetry/instrumentation',
		'@azure/opentelemetry-instrumentation-azure-sdk',
		'zeromq',
		'electron', // this is for simulation workbench,
		'sqlite3',
		...(isDev ? [] : ['dotenv', 'source-map-support'])
	],
	platform: 'node',
	mainFields: ["module", "main"], // needed for jsonc-parser,
	define: {
		'process.env.APPLICATIONINSIGHTS_CONFIGURATION_CONTENT': '"{}"'
	}
} satisfies esbuild.BuildOptions;

const nodeExtHostTestGlobs = [
	'src/**/vscode/**/*.test.{ts,tsx}',
	'src/**/vscode-node/**/*.test.{ts,tsx}',
	// deprecated
	'src/extension/**/*.test.{ts,tsx}'
];

const testBundlePlugin: esbuild.Plugin = {
	name: 'testBundlePlugin',
	setup(build) {
		build.onResolve({ filter: /[\/\\]test-extension\.ts$/ }, args => {
			if (args.kind !== 'entry-point') {
				return;
			}
			return { path: path.resolve(args.path) };
		});
		build.onLoad({ filter: /[\/\\]test-extension\.ts$/ }, async args => {
			let files = await glob(nodeExtHostTestGlobs, { cwd: REPO_ROOT, posix: true });
			files = files.map(f => path.posix.relative('src', f));
			if (files.length === 0) {
				throw new Error('No extension tests found');
			}
			return {
				contents: files
					.map(f => `require('./${f}');`)
					.join(''),
				watchDirs: files.map(path.dirname),
				watchFiles: files,
			};
		});
	}
};

const nodeExtHostSanityTestGlobs = [
	'src/**/vscode-node/**/*.sanity-test.{ts,tsx}',
];

const sanityTestBundlePlugin: esbuild.Plugin = {
	name: 'sanityTestBundlePlugin',
	setup(build) {
		build.onResolve({ filter: /[\/\\]sanity-test-extension\.ts$/ }, args => {
			if (args.kind !== 'entry-point') {
				return;
			}
			return { path: path.resolve(args.path) };
		});
		build.onLoad({ filter: /[\/\\]sanity-test-extension\.ts$/ }, async args => {
			let files = await glob(nodeExtHostSanityTestGlobs, { cwd: REPO_ROOT, posix: true });
			files = files.map(f => path.posix.relative('src', f));
			if (files.length === 0) {
				throw new Error('No extension tests found');
			}
			return {
				contents: files
					.map(f => `require('./${f}');`)
					.join(''),
				watchDirs: files.map(path.dirname),
				watchFiles: files,
			};
		});
	}
};

const shimVsCodeTypesPlugin: esbuild.Plugin = {
	name: 'shimVsCodeTypesPlugin',
	setup(build) {
		// Create a virtual module that will try to require vscode at runtime
		build.onResolve({ filter: /^vscode$/ }, args => {
			return {
				path: 'vscode-dynamic',
				namespace: 'vscode-fallback'
			};
		});

		build.onLoad({ filter: /^vscode-dynamic$/, namespace: 'vscode-fallback' }, () => {
			return {
				contents: `
					let vscode;
					// See test/simulationExtension/extension.js for where and why this is created.
					if (typeof COPILOT_SIMULATION_VSCODE !== 'undefined') {
						vscode = COPILOT_SIMULATION_VSCODE;
					} else {
						try {
							vscode = eval('require(' + JSON.stringify('vscode') + ')');
						} catch (e) {
							vscode = require('./src/util/common/test/shims/vscodeTypesShim.ts');
						}
					}
					module.exports = vscode;
				`,
				resolveDir: REPO_ROOT
			};
		});
	}
};

const nodeExtHostBuildOptions = {
	...baseNodeBuildOptions,
	entryPoints: [
		{ in: './src/extension/extension/vscode-node/extension.ts', out: 'extension' },
		{ in: './src/platform/parser/node/parserWorker.ts', out: 'worker2' },
		{ in: './src/platform/tokenizer/node/tikTokenizerWorker.ts', out: 'tikTokenizerWorker' },
		{ in: './src/platform/diff/node/diffWorkerMain.ts', out: 'diffWorker' },
		{ in: './src/platform/tfidf/node/tfidfWorker.ts', out: 'tfidfWorker' },
		{ in: './src/extension/onboardDebug/node/copilotDebugWorker/index.ts', out: 'copilotDebugCommand' },
		{ in: './src/test-extension.ts', out: 'test-extension' },
		{ in: './src/sanity-test-extension.ts', out: 'sanity-test-extension' },
	],
	loader: { '.ps1': 'text' },
	plugins: [testBundlePlugin, sanityTestBundlePlugin],
	external: [
		...baseNodeBuildOptions.external,
		'vscode'
	]
} satisfies esbuild.BuildOptions;

const webExtHostBuildOptions = {
	...baseBuildOptions,
	platform: 'browser',
	entryPoints: [
		{ in: './src/extension/extension/vscode-worker/extension.ts', out: 'web' },
	],
	format: 'cjs', // Necessary to export activate function from bundle for extension
	external: [
		'vscode',
		'http',
	]
} satisfies esbuild.BuildOptions;

const nodeExtHostSimulationTestOptions = {
	...nodeExtHostBuildOptions,
	outdir: '.vscode/extensions/test-extension/dist',
	entryPoints: [
		{ in: '.vscode/extensions/test-extension/main.ts', out: './simulation-extension' }
	]
} satisfies esbuild.BuildOptions;

const nodeSimulationBuildOptions = {
	...baseNodeBuildOptions,
	entryPoints: [
		{ in: './test/simulationMain.ts', out: 'simulationMain' },
	],
	plugins: [testBundlePlugin, shimVsCodeTypesPlugin],
	external: [
		...baseNodeBuildOptions.external,
	]
} satisfies esbuild.BuildOptions;

const nodeSimulationWorkbenchUIBuildOptions = {
	...baseNodeBuildOptions,
	platform: 'browser', // @ulugbekna: important to target 'browser' for correct bundling using 'window'
	mainFields: ["browser", "module", "main"],
	entryPoints: [
		{ in: './test/simulation/workbench/simulationWorkbench.tsx', out: 'simulationWorkbench' },
	],
	alias: {
		'vscode': './src/util/common/test/shims/vscodeTypesShim.ts'
	},
	external: [
		...baseNodeBuildOptions.external,

		'../../node_modules/monaco-editor/*',

		// @ulugbekna: libs provided by node that need to be specified manually because of 'platform' is set to 'browser'
		'fs',
		'path',
		'readline',
		'child_process',
		'http',
		'assert',
	]
} satisfies esbuild.BuildOptions;

async function typeScriptServerPluginPackageJsonInstall(): Promise<void> {
	await mkdir('./node_modules/@vscode/copilot-typescript-server-plugin', { recursive: true });
	const source = path.join(__dirname, './src/extension/typescriptContext/serverPlugin/package.json');
	const destination = path.join(__dirname, './node_modules/@vscode/copilot-typescript-server-plugin/package.json');
	try {
		await copyFile(source, destination);
	} catch (error) {
		console.error('Error copying package.json:', error);
	}
}

const typeScriptServerPluginBuildOptions = {
	bundle: true,
	format: 'cjs',
	// keepNames: true,
	logLevel: 'info',
	minify: !isDev,
	outdir: './node_modules/@vscode/copilot-typescript-server-plugin/dist',
	platform: 'node',
	sourcemap: isDev ? 'linked' : false,
	sourcesContent: false,
	treeShaking: true,
	external: [
		"typescript",
		"typescript/lib/tsserverlibrary"
	],
	entryPoints: [
		{ in: './src/extension/typescriptContext/serverPlugin/src/node/main.ts', out: 'main' },
	]
} satisfies esbuild.BuildOptions;

async function main() {
	if (!isDev) {
		applyPackageJsonPatch(isPreRelease);
	}

	await typeScriptServerPluginPackageJsonInstall();

	if (isWatch) {

		const contexts: esbuild.BuildContext[] = [];

		const nodeExtHostContext = await esbuild.context(nodeExtHostBuildOptions);
		contexts.push(nodeExtHostContext);

		const webExtHostContext = await esbuild.context(webExtHostBuildOptions);
		contexts.push(webExtHostContext);

		const nodeSimulationContext = await esbuild.context(nodeSimulationBuildOptions);
		contexts.push(nodeSimulationContext);

		const nodeSimulationWorkbenchUIContext = await esbuild.context(nodeSimulationWorkbenchUIBuildOptions);
		contexts.push(nodeSimulationWorkbenchUIContext);

		const nodeExtHostSimulationContext = await esbuild.context(nodeExtHostSimulationTestOptions);
		contexts.push(nodeExtHostSimulationContext);

		const typeScriptServerPluginContext = await esbuild.context(typeScriptServerPluginBuildOptions);
		contexts.push(typeScriptServerPluginContext);

		let debounce: NodeJS.Timeout | undefined;

		const rebuild = async () => {
			if (debounce) {
				clearTimeout(debounce);
			}

			debounce = setTimeout(async () => {
				console.log('[watch] build started');
				for (const ctx of contexts) {
					try {
						await ctx.cancel();
						await ctx.rebuild();
					} catch (error) {
						console.error('[watch]', error);
					}
				}
				console.log('[watch] build finished');
			}, 100);
		};


		watcher.subscribe(REPO_ROOT, (err, events) => {
			for (const event of events) {
				console.log(`File change detected: ${event.path}`);
			}
			rebuild();
		}, {
			ignore: [
				`**/.git/**`,
				`**/.simulation/**`,
				`**/test/outcome/**`,
				`.vscode-test/**`,
				`**/.venv/**`,
				`**/dist/**`,
				`**/node_modules/**`,
				`**/*.txt`,
				`**/baseline.json`,
				`**/baseline.old.json`,
				`**/*.w.json`,
				'**/*.sqlite',
				'**/*.sqlite-journal',
			]
		});
		rebuild();
	} else {
		await Promise.all([
			esbuild.build(nodeExtHostBuildOptions),
			esbuild.build(webExtHostBuildOptions),
			esbuild.build(nodeSimulationBuildOptions),
			esbuild.build(nodeSimulationWorkbenchUIBuildOptions),
			esbuild.build(nodeExtHostSimulationTestOptions),
			esbuild.build(typeScriptServerPluginBuildOptions),
		]);
	}
}

function applyPackageJsonPatch(isPreRelease: boolean) {
	const packagejsonPath = path.join(__dirname, './package.json');
	const json = JSON.parse(fs.readFileSync(packagejsonPath).toString());

	const newProps: any = {
		buildType: 'prod',
		isPreRelease,
	};

	const patchedPackageJson = Object.assign(json, newProps);

	// Remove fields which might reveal our development process
	delete patchedPackageJson['scripts'];
	delete patchedPackageJson['devDependencies'];
	delete patchedPackageJson['dependencies'];

	fs.writeFileSync(packagejsonPath, JSON.stringify(patchedPackageJson));
}

main();
