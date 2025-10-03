/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as fs from 'fs';
import { glob } from 'glob';
import * as path from 'path';
import { promisify } from 'util';

const REPO_ROOT = path.join(__dirname, '..', '..');
const CHAT_LIB_DIR = path.join(REPO_ROOT, 'chat-lib');
const TARGET_DIR = path.join(CHAT_LIB_DIR, 'src');
const execAsync = promisify(exec);

// Entry point - follow imports from the main chat-lib file
const entryPoints = [
	'src/lib/node/chatLibMain.ts',
	'src/util/vs/base-common.d.ts',
	'src/util/vs/vscode-globals-nls.d.ts',
	'src/util/vs/vscode-globals-product.d.ts',
	'src/util/common/globals.d.ts',
	'src/util/common/test/shims/vscodeTypesShim.ts',
	'src/platform/diff/common/diffWorker.ts',
	'src/platform/tokenizer/node/tikTokenizerWorker.ts',
	// For tests:
	'src/platform/authentication/test/node/simulationTestCopilotTokenManager.ts',
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

		// Use static module files
		await this.generateModuleFiles();

		// Validate the module
		await this.validateModule();

		// Compile TypeScript to validate
		await this.compileTypeScript();

		console.log('Chat-lib extraction completed successfully!');
	}

	private async cleanTargetDir(): Promise<void> {
		// Remove and recreate the src directory
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
		// Updated regex to match all relative imports (including multiple ../ segments)
		const importExportRegex = /(?:import|export)\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"](\.\.?\/[^'"]*)['"]/g;
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
				return this.normalizePath(path.relative(REPO_ROOT, baseResolved + '.ts'));
			}
			if (fs.existsSync(baseResolved + '.tsx')) {
				return this.normalizePath(path.relative(REPO_ROOT, baseResolved + '.tsx'));
			}
		}

		// Try with .ts extension
		if (fs.existsSync(resolved + '.ts')) {
			return this.normalizePath(path.relative(REPO_ROOT, resolved + '.ts'));
		}

		// Try with .tsx extension
		if (fs.existsSync(resolved + '.tsx')) {
			return this.normalizePath(path.relative(REPO_ROOT, resolved + '.tsx'));
		}

		// Try with .d.ts extension
		if (fs.existsSync(resolved + '.d.ts')) {
			return this.normalizePath(path.relative(REPO_ROOT, resolved + '.d.ts'));
		}

		// Try with index.ts
		if (fs.existsSync(path.join(resolved, 'index.ts'))) {
			return this.normalizePath(path.relative(REPO_ROOT, path.join(resolved, 'index.ts')));
		}

		// Try with index.tsx
		if (fs.existsSync(path.join(resolved, 'index.tsx'))) {
			return this.normalizePath(path.relative(REPO_ROOT, path.join(resolved, 'index.tsx')));
		}

		// Try with index.d.ts
		if (fs.existsSync(path.join(resolved, 'index.d.ts'))) {
			return this.normalizePath(path.relative(REPO_ROOT, path.join(resolved, 'index.d.ts')));
		}

		// Try as-is
		if (fs.existsSync(resolved)) {
			return this.normalizePath(path.relative(REPO_ROOT, resolved));
		}

		// If we get here, the file was not found - throw an error
		throw new Error(`Import file not found: ${importPath} (resolved to ${resolved}) imported from ${fromFile}`);
	}

	private normalizePath(filePath: string): string {
		// Normalize path separators to forward slashes for consistency across platforms
		return filePath.replace(/\\/g, '/');
	}

	private getDestinationPath(filePath: string): string {
		// Normalize the input path first, then convert src/... to _internal/...
		const normalizedPath = this.normalizePath(filePath);
		const relativePath = normalizedPath.replace(/^src\//, '_internal/');
		return path.join(TARGET_DIR, relativePath);
	}

	private async copyFiles(): Promise<void> {
		console.log(`Copying ${this.allFiles.size} files...`);

		for (const [, fileInfo] of this.allFiles) {
			// Skip the main entry point file since it becomes top-level main.ts
			if (fileInfo.relativePath === 'src/lib/node/chatLibMain.ts') {
				continue;
			}

			await fs.promises.mkdir(path.dirname(fileInfo.destPath), { recursive: true });			// Read source file
			const content = await fs.promises.readFile(fileInfo.srcPath, 'utf-8');

			// Transform content to replace vscode imports and fix relative paths
			const transformedContent = this.transformFileContent(content, fileInfo.relativePath);

			// Write to destination
			await fs.promises.writeFile(fileInfo.destPath, transformedContent);
		}
	}



	private transformFileContent(content: string, filePath: string): string {
		let transformed = content;

		// Rewrite non-type imports of 'vscode' to use vscodeTypesShim
		transformed = this.rewriteVscodeImports(transformed, filePath);

		// Rewrite imports from local vscodeTypes to use vscodeTypesShim
		transformed = this.rewriteVscodeTypesImports(transformed, filePath);

		// Only rewrite relative imports for main.ts (chatLibMain.ts)
		if (filePath === 'src/lib/node/chatLibMain.ts') {
			transformed = transformed.replace(
				/import\s+([^'"]*)\s+from\s+['"](\.\/[^'"]*|\.\.\/[^'"]*)['"]/g,
				(match, importClause, importPath) => {
					const rewrittenPath = this.rewriteImportPath(filePath, importPath);
					return `import ${importClause} from '${rewrittenPath}'`;
				}
			);
		}

		return transformed;
	}

	private rewriteVscodeImports(content: string, filePath: string): string {
		// Don't rewrite vscode imports in the main vscodeTypes.ts file
		if (filePath === 'src/vscodeTypes.ts') {
			return content;
		}

		// Pattern to match import statements from 'vscode'
		// This regex captures:
		// - import * as vscode from 'vscode'
		// - import { Uri, window } from 'vscode'
		// - import vscode from 'vscode'
		// But NOT type-only imports like:
		// - import type { Uri } from 'vscode'
		// - import type * as vscode from 'vscode'
		const vscodeImportRegex = /^(\s*import\s+)(?!type\s+)([^'"]*)\s+from\s+['"]vscode['"];?\s*$/gm;

		return content.replace(vscodeImportRegex, (match, importPrefix, importClause) => {
			// Calculate the relative path to vscodeTypesShim based on the current file location
			const shimPath = this.getVscodeTypesShimPath(filePath);
			return `${importPrefix}${importClause.trim()} from '${shimPath}';`;
		});
	}

	private rewriteVscodeTypesImports(content: string, filePath: string): string {
		// Don't rewrite vscodeTypes imports in the main vscodeTypes.ts file itself
		if (filePath === 'src/vscodeTypes.ts') {
			return content;
		}

		// Don't rewrite in the vscodeTypesShim file itself to avoid circular imports
		if (filePath === 'src/util/common/test/shims/vscodeTypesShim.ts') {
			return content;
		}

		// Pattern to match non-type imports from local vscodeTypes
		// This regex captures imports like:
		// - import { ChatErrorLevel } from '../../../vscodeTypes'
		// - import * as vscodeTypes from '../../../vscodeTypes'
		// But NOT type-only imports like:
		// - import type { ChatErrorLevel } from '../../../vscodeTypes'
		const vscodeTypesImportRegex = /^(\s*import\s+)(?!type\s+)([^'"]*)\s+from\s+['"]([^'"]*\/vscodeTypes)['"];?\s*$/gm;

		return content.replace(vscodeTypesImportRegex, (match, importPrefix, importClause, importPath) => {
			// Calculate the relative path to vscodeTypesShim based on the current file location
			const shimPath = this.getVscodeTypesShimPath(filePath);
			return `${importPrefix}${importClause.trim()} from '${shimPath}';`;
		});
	}

	private getVscodeTypesShimPath(filePath: string): string {
		// For main.ts (chatLibMain.ts), use the _internal structure
		if (filePath === 'src/lib/node/chatLibMain.ts') {
			return './_internal/util/common/test/shims/vscodeTypesShim';
		}

		// For other files, calculate relative path from their location to the shim
		// The target shim location will be: _internal/util/common/test/shims/vscodeTypesShim
		// Files are placed in: _internal/<original_path_without_src>

		// Remove 'src/' prefix and calculate depth
		const relativePath = filePath.replace(/^src\//, '');
		const pathSegments = relativePath.split('/');
		const depth = pathSegments.length - 1; // -1 because the last segment is the filename

		// Go up 'depth' levels, then down to the shim
		const upLevels = '../'.repeat(depth);
		return `${upLevels}util/common/test/shims/vscodeTypesShim`;
	}

	private rewriteImportPath(fromFile: string, importPath: string): string {
		// For main.ts, rewrite relative imports to use ./_internal structure
		if (fromFile === 'src/lib/node/chatLibMain.ts') {
			// Convert ../../extension/... to ./_internal/extension/...
			// Convert ../../platform/... to ./_internal/platform/...
			// Convert ../../util/... to ./_internal/util/...
			return importPath.replace(/^\.\.\/\.\.\//, './_internal/');
		}

		// For other files, don't change the import path
		return importPath;
	}

	private async generateModuleFiles(): Promise<void> {
		console.log('Using static module files already present in chat-lib directory...');

		// Copy main.ts from src/lib/node/chatLibMain.ts
		const mainTsPath = path.join(REPO_ROOT, 'src', 'lib', 'node', 'chatLibMain.ts');
		const mainTsContent = await fs.promises.readFile(mainTsPath, 'utf-8');
		const transformedMainTs = this.transformFileContent(mainTsContent, 'src/lib/node/chatLibMain.ts');
		await fs.promises.writeFile(path.join(TARGET_DIR, 'main.ts'), transformedMainTs);

		// Copy root package.json to chat-lib/src
		await this.copyRootPackageJson();

		// Copy all vscode.proposed.*.d.ts files
		await this.copyVSCodeProposedTypes();

		// Copy all tiktoken files
		await this.copyTikTokenFiles();
	}

	private async validateModule(): Promise<void> {
		console.log('Validating module...');

		// Check if static files exist in chat-lib directory
		const staticFiles = ['package.json', 'tsconfig.json', 'README.md', 'LICENSE.txt'];
		for (const file of staticFiles) {
			const filePath = path.join(CHAT_LIB_DIR, file);
			if (!fs.existsSync(filePath)) {
				throw new Error(`Required static file missing: ${file}`);
			}
		}

		// Check if main.ts exists in src directory
		const mainTsPath = path.join(TARGET_DIR, 'main.ts');
		if (!fs.existsSync(mainTsPath)) {
			throw new Error(`Required file missing: src/main.ts`);
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

	private async copyTikTokenFiles(): Promise<void> {
		console.log('Copying tiktoken files...');

		// Find all .tiktoken files in src/platform/tokenizer/node/
		const tokenizerDir = path.join(REPO_ROOT, 'src', 'platform', 'tokenizer', 'node');
		const tikTokenFiles = await glob('*.tiktoken', { cwd: tokenizerDir });

		for (const file of tikTokenFiles) {
			const srcPath = path.join(tokenizerDir, file);
			const destPath = path.join(TARGET_DIR, '_internal', 'platform', 'tokenizer', 'node', file);

			await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
			await fs.promises.copyFile(srcPath, destPath);
		}

		console.log(`Copied ${tikTokenFiles.length} tiktoken files`);
	}

	private async copyRootPackageJson(): Promise<void> {
		console.log('Copying root package.json to chat-lib/src...');

		const srcPath = path.join(REPO_ROOT, 'package.json');
		const destPath = path.join(TARGET_DIR, 'package.json');

		await fs.promises.copyFile(srcPath, destPath);
		console.log('Root package.json copied successfully!');

		// Update chat-lib package.json dependencies
		await this.updateChatLibDependencies();
	}

	private async updateChatLibDependencies(): Promise<void> {
		console.log('Updating chat-lib package.json dependencies...');

		const rootPackageJsonPath = path.join(REPO_ROOT, 'package.json');
		const chatLibPackageJsonPath = path.join(CHAT_LIB_DIR, 'package.json');

		// Read both package.json files
		const rootPackageJson = JSON.parse(await fs.promises.readFile(rootPackageJsonPath, 'utf-8'));
		const chatLibPackageJson = JSON.parse(await fs.promises.readFile(chatLibPackageJsonPath, 'utf-8'));

		// Combine all dependencies and devDependencies from root
		const rootDependencies = {
			...(rootPackageJson.dependencies || {}),
			...(rootPackageJson.devDependencies || {})
		};

		let updatedCount = 0;
		let removedCount = 0;
		const changes: string[] = [];

		// Update existing dependencies in chat-lib with versions from root
		for (const depType of ['dependencies', 'devDependencies']) {
			if (chatLibPackageJson[depType]) {
				const dependencyNames = Object.keys(chatLibPackageJson[depType]);

				for (const depName of dependencyNames) {
					if (rootDependencies[depName]) {
						// Update version if it exists in root
						const oldVersion = chatLibPackageJson[depType][depName];
						const newVersion = rootDependencies[depName];

						if (oldVersion !== newVersion) {
							chatLibPackageJson[depType][depName] = newVersion;
							changes.push(`  Updated ${depName}: ${oldVersion} → ${newVersion}`);
							updatedCount++;
						}
					} else {
						// Remove dependency if it no longer exists in root
						delete chatLibPackageJson[depType][depName];
						changes.push(`  Removed ${depName} (no longer in root package.json)`);
						removedCount++;
					}
				}

				// Clean up empty dependency objects
				if (Object.keys(chatLibPackageJson[depType]).length === 0) {
					delete chatLibPackageJson[depType];
				}
			}
		}

		// Write the updated chat-lib package.json
		await fs.promises.writeFile(
			chatLibPackageJsonPath,
			JSON.stringify(chatLibPackageJson, null, '\t') + '\n'
		);

		console.log(`Chat-lib dependencies updated: ${updatedCount} updated, ${removedCount} removed`);
		if (changes.length > 0) {
			console.log('Changes made:');
			changes.forEach(change => console.log(change));
		}
	}

	private async compileTypeScript(): Promise<void> {
		console.log('Compiling TypeScript to validate module...');

		try {
			// Change to the chat-lib directory and run TypeScript compiler
			const { stdout, stderr } = await execAsync('npx tsc --noEmit', {
				cwd: CHAT_LIB_DIR,
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