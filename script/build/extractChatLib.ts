/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';

const REPO_ROOT = path.join(__dirname, '..', '..');
const TARGET_DIR = path.join(REPO_ROOT, 'tmp-chat-lib');
const execAsync = promisify(exec);

// Entry point - follow imports from the main chat-lib file
const entryPoints = [
	'src/lib/node/chat-lib-main.ts',
	'src/util/vs/base-common.d.ts',
	'src/util/vs/vscode-globals-nls.d.ts',
	'src/util/vs/vscode-globals-product.d.ts',
	'src/util/common/globals.d.ts',
];

interface FileInfo {
	srcPath: string;
	destPath: string;
	relativePath: string;
	dependencies: string[];
}

class ChatLibExtractor {
	private processedFiles = new Set<string>();
	private allFiles = new Map<string, FileInfo>();

	async extract(): Promise<void> {
		console.log('Starting chat-lib extraction...');

		// Clean target directory
		await this.cleanTargetDir();

		// Process entry points and their dependencies
		await this.processEntryPoints();

		// Copy all processed files
		await this.copyFiles();

		// Generate module files
		await this.generateModuleFiles();

		// Validate the module
		await this.validateModule();

		// Compile TypeScript to validate
		await this.compileTypeScript();

		console.log('Chat-lib extraction completed successfully!');
	}

	private async cleanTargetDir(): Promise<void> {
		if (fs.existsSync(TARGET_DIR)) {
			await fs.promises.rm(TARGET_DIR, { recursive: true, force: true });
		}
		await fs.promises.mkdir(TARGET_DIR, { recursive: true });
	}

	private async processEntryPoints(): Promise<void> {
		console.log('Processing entry points and dependencies...');

		const queue = [...entryPoints];

		while (queue.length > 0) {
			const filePath = queue.shift()!;
			if (this.processedFiles.has(filePath)) {
				continue;
			}

			const fullPath = path.join(REPO_ROOT, filePath);
			if (!fs.existsSync(fullPath)) {
				console.warn(`Warning: File not found: ${filePath}`);
				continue;
			}

			const dependencies = await this.extractDependencies(fullPath);
			const destPath = this.getDestinationPath(filePath);

			this.allFiles.set(filePath, {
				srcPath: fullPath,
				destPath,
				relativePath: filePath,
				dependencies
			});

			this.processedFiles.add(filePath);

			// Add dependencies to queue
			dependencies.forEach(dep => {
				if (!this.processedFiles.has(dep)) {
					queue.push(dep);
				}
			});
		}
	}

	private async extractDependencies(filePath: string): Promise<string[]> {
		const content = await fs.promises.readFile(filePath, 'utf-8');
		const dependencies: string[] = [];

		// Extract both import and export statements using regex
		// Matches:
		// - import ... from './path'
		// - export ... from './path'
		// - export { ... } from './path'
		const importExportRegex = /(?:import|export)\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"](\.\/[^'"]*|\.\.\/[^'"]*)['"]/g;
		let match;

		while ((match = importExportRegex.exec(content)) !== null) {
			const importPath = match[1];
			const resolvedPath = this.resolveImportPath(filePath, importPath);

			if (resolvedPath) {
				dependencies.push(resolvedPath);
			}
		}

		return dependencies;
	}

	private resolveImportPath(fromFile: string, importPath: string): string | null {
		const fromDir = path.dirname(fromFile);
		const resolved = path.resolve(fromDir, importPath);

		// If import path ends with .js, try replacing with .ts/.tsx first
		if (importPath.endsWith('.js')) {
			const baseResolved = resolved.slice(0, -3); // Remove .js
			if (fs.existsSync(baseResolved + '.ts')) {
				return path.relative(REPO_ROOT, baseResolved + '.ts');
			}
			if (fs.existsSync(baseResolved + '.tsx')) {
				return path.relative(REPO_ROOT, baseResolved + '.tsx');
			}
		}

		// Try with .ts extension
		if (fs.existsSync(resolved + '.ts')) {
			return path.relative(REPO_ROOT, resolved + '.ts');
		}

		// Try with .tsx extension
		if (fs.existsSync(resolved + '.tsx')) {
			return path.relative(REPO_ROOT, resolved + '.tsx');
		}

		// Try with .d.ts extension
		if (fs.existsSync(resolved + '.d.ts')) {
			return path.relative(REPO_ROOT, resolved + '.d.ts');
		}

		// Try with index.ts
		if (fs.existsSync(path.join(resolved, 'index.ts'))) {
			return path.relative(REPO_ROOT, path.join(resolved, 'index.ts'));
		}

		// Try with index.tsx
		if (fs.existsSync(path.join(resolved, 'index.tsx'))) {
			return path.relative(REPO_ROOT, path.join(resolved, 'index.tsx'));
		}

		// Try with index.d.ts
		if (fs.existsSync(path.join(resolved, 'index.d.ts'))) {
			return path.relative(REPO_ROOT, path.join(resolved, 'index.d.ts'));
		}

		// Try as-is
		if (fs.existsSync(resolved)) {
			return path.relative(REPO_ROOT, resolved);
		}

		// If we get here, the file was not found - throw an error
		throw new Error(`Import file not found: ${importPath} (resolved to ${resolved}) imported from ${fromFile}`);
	}


	private getDestinationPath(filePath: string): string {
		// Convert src/... to _internal/...
		const relativePath = filePath.replace(/^src\//, '_internal/');
		return path.join(TARGET_DIR, relativePath);
	}

	private async copyFiles(): Promise<void> {
		console.log(`Copying ${this.allFiles.size} files...`);

		for (const [, fileInfo] of this.allFiles) {
			// Skip the main entry point file since it becomes top-level main.ts
			if (fileInfo.relativePath === 'src/lib/node/chat-lib-main.ts') {
				continue;
			}

			await fs.promises.mkdir(path.dirname(fileInfo.destPath), { recursive: true });

			// Read source file
			let content = await fs.promises.readFile(fileInfo.srcPath, 'utf-8');

			// Add JSX pragma comments to .tsx files
			if (fileInfo.srcPath.endsWith('.tsx')) {
				content = this.addJsxPragmas(content);
			}

			// Write to destination
			await fs.promises.writeFile(fileInfo.destPath, content);
		}
	}

	private addJsxPragmas(content: string): string {
		const jsxPragmas = `
// Equivalent to jsx = 'react' in tsconfig.json.
/** @jsxRuntime classic */
// Equivalent to jsxFactory = 'vscpp' in tsconfig.json. vscpp is exported globally by @vscode/prompt-tsx
/** @jsx vscpp */
// Equivalent to jsxFragmentFactory = 'vscppf' in tsconfig.json. vscppf is exported globally by @vscode/prompt-tsx
/** @jsxFrag vscppf */
`;

		// Find the end of the copyright header (look for the closing comment)
		const copyrightEndMatch = content.match(/\*--------------------------------------------------------------------------------------------\*\/\n/);

		if (copyrightEndMatch) {
			const insertionPoint = copyrightEndMatch.index! + copyrightEndMatch[0].length;
			return content.slice(0, insertionPoint) + jsxPragmas + content.slice(insertionPoint);
		} else {
			// If no copyright header found, add at the beginning
			return jsxPragmas + content;
		}
	}

	private transformFileContent(content: string, filePath: string): string {
		let transformed = content;

		// Remove VS Code imports
		transformed = transformed.replace(/import\s+.*\s+from\s+['"]+vscode['"]+;?\s*\n/g, '');

		// Rewrite relative imports to work in _internal structure
		transformed = transformed.replace(
			/import\s+([^'"]*)\s+from\s+['"](\.\/[^'"]*|\.\.\/[^'"]*)['"]/g,
			(match, importClause, importPath) => {
				const rewrittenPath = this.rewriteImportPath(filePath, importPath);
				return `import ${importClause} from '${rewrittenPath}'`;
			}
		);

		return transformed;
	}

	private rewriteImportPath(fromFile: string, importPath: string): string {
		// For main.ts, rewrite relative imports to use ./_internal structure
		if (fromFile === 'src/lib/node/chat-lib-main.ts') {
			// Convert ../../extension/... to ./_internal/extension/...
			// Convert ../../platform/... to ./_internal/platform/...
			// Convert ../../util/... to ./_internal/util/...
			return importPath.replace(/^\.\.\/\.\.\//, './_internal/');
		}

		// For other files, don't change the import path
		return importPath;
	}

	private async generateModuleFiles(): Promise<void> {
		console.log('Generating module files...');

		// Generate package.json
		const packageJson = {
			name: '@vscode/chat-lib',
			version: '0.1.0',
			description: 'Chat and inline editing SDK extracted from VS Code Copilot Chat',
			main: 'main.ts',
			engines: {
				node: '>=22.14.0'
			},
			peerDependencies: {
				typescript: '^5.0.0'
			},
			keywords: ['chat', 'ai', 'sdk', 'vscode', 'copilot'],
			license: 'MIT',
			files: [
				'main.ts',
				'_internal/**/*.ts',
				'README.md',
				'LICENSE.txt'
			],
			scripts: {
				build: 'echo "TBD: Build step not defined"',
				test: 'echo "TBD: Test step not defined"'
			}
		};

		await fs.promises.writeFile(
			path.join(TARGET_DIR, 'package.json'),
			JSON.stringify(packageJson, null, 2)
		);

		// Copy main.ts from src/lib/node/chat-lib-main.ts
		const mainTsPath = path.join(REPO_ROOT, 'src', 'lib', 'node', 'chat-lib-main.ts');
		const mainTsContent = await fs.promises.readFile(mainTsPath, 'utf-8');
		const transformedMainTs = this.transformFileContent(mainTsContent, 'src/lib/node/chat-lib-main.ts');
		await fs.promises.writeFile(path.join(TARGET_DIR, 'main.ts'), transformedMainTs);

		// Copy all vscode.proposed.*.d.ts files
		await this.copyVSCodeProposedTypes();

		// Generate tsconfig.json
		const tsConfig = {
			compilerOptions: {
				module: 'commonjs',
				target: 'es2022',
				lib: ['ES2022'],
				sourceMap: true,
				jsx: 'react',

				"experimentalDecorators": true,
				"noImplicitOverride": true,
				"noUnusedLocals": true,
				"useDefineForClassFields": false,
				"allowUnreachableCode": false,
				"strict": true,
				"exactOptionalPropertyTypes": false,
				"useUnknownInCatchVariables": false,
				"noFallthroughCasesInSwitch": true,
				"forceConsistentCasingInFileNames": true,
				"allowSyntheticDefaultImports": true,
				"esModuleInterop": true,
				"skipLibCheck": true

				// declaration: true,
				// outDir: './dist',
				// rootDir: '.',
				// strict: true,
				// noImplicitAny: false,
				// experimentalDecorators: true,
				// emitDecoratorMetadata: true,
				// esModuleInterop: true,
				// skipLibCheck: true,
				// forceConsistentCasingInFileNames: true,
				// moduleResolution: 'node',
				// resolveJsonModule: true,
				// allowSyntheticDefaultImports: true
			},
			include: ['**/*.ts', '**/*.tsx'],
			exclude: ['node_modules', 'dist']
		};

		await fs.promises.writeFile(
			path.join(TARGET_DIR, 'tsconfig.json'),
			JSON.stringify(tsConfig, null, 2)
		);

		// Generate README.md
		const readme = `# @vscode/chat-lib

Chat and inline editing SDK extracted from VS Code Copilot Chat.

## Installation

\`\`\`bash
npm install @vscode/chat-lib
\`\`\`

## Usage

\`\`\`typescript
import { LineRange, Position, Observable } from '@vscode/chat-lib';

// Use the SDK with custom service implementations
const range = new LineRange(1, 10);
const position = new Position(5, 0);
\`\`\`

## License

MIT
`;
		await fs.promises.writeFile(path.join(TARGET_DIR, 'README.md'), readme);

		// Copy license if it exists
		const licensePath = path.join(REPO_ROOT, 'LICENSE.txt');
		if (fs.existsSync(licensePath)) {
			await fs.promises.copyFile(licensePath, path.join(TARGET_DIR, 'LICENSE.txt'));
		}
	}

	private async validateModule(): Promise<void> {
		console.log('Validating module...');

		// Check if main files exist
		const requiredFiles = ['package.json', 'main.ts'];
		for (const file of requiredFiles) {
			const filePath = path.join(TARGET_DIR, file);
			if (!fs.existsSync(filePath)) {
				throw new Error(`Required file missing: ${file}`);
			}
		}

		console.log('Module validation passed!');
	}

	private async copyVSCodeProposedTypes(): Promise<void> {
		console.log('Copying VS Code proposed API types...');

		// Find all vscode.proposed.*.d.ts files in src/extension/
		const extensionDir = path.join(REPO_ROOT, 'src', 'extension');
		const proposedTypeFiles = await glob('vscode.proposed.*.d.ts', { cwd: extensionDir });

		for (const file of proposedTypeFiles) {
			const srcPath = path.join(extensionDir, file);
			const destPath = path.join(TARGET_DIR, '_internal', 'extension', file);

			await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
			await fs.promises.copyFile(srcPath, destPath);
		}

		console.log(`Copied ${proposedTypeFiles.length} VS Code proposed API type files and additional .d.ts files`);
	}

	private async compileTypeScript(): Promise<void> {
		console.log('Compiling TypeScript to validate module...');

		try {
			// Change to the target directory and run TypeScript compiler
			const { stdout, stderr } = await execAsync('npx tsc --noEmit', {
				cwd: TARGET_DIR,
				timeout: 60000 // 60 second timeout
			});

			if (stderr) {
				console.warn('TypeScript compilation warnings:', stderr);
			}

			console.log('TypeScript compilation successful!');
		} catch (error: any) {
			console.error('TypeScript compilation failed:', error.stdout || error.message);
			throw new Error(`TypeScript compilation failed: ${error.stdout || error.message}`);
		}
	}
}

// Main execution
async function main(): Promise<void> {
	try {
		const extractor = new ChatLibExtractor();
		await extractor.extract();
	} catch (error) {
		console.error('Extraction failed:', error);
		process.exit(1);
	}
}

if (require.main === module) {
	main();
}