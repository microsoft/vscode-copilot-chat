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
			const content = await fs.promises.readFile(fileInfo.srcPath, 'utf-8');

			// Write to destination
			await fs.promises.writeFile(fileInfo.destPath, content);
		}
	}



	private transformFileContent(content: string, filePath: string): string {
		let transformed = content;

		// Remove VS Code imports
		// transformed = transformed.replace(/import\s+.*\s+from\s+['"]+vscode['"]+;?\s*\n/g, '');

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
		console.log('Using static module files already present in chat-lib directory...');

		// Copy main.ts from src/lib/node/chat-lib-main.ts
		const mainTsPath = path.join(REPO_ROOT, 'src', 'lib', 'node', 'chat-lib-main.ts');
		const mainTsContent = await fs.promises.readFile(mainTsPath, 'utf-8');
		const transformedMainTs = this.transformFileContent(mainTsContent, 'src/lib/node/chat-lib-main.ts');
		await fs.promises.writeFile(path.join(TARGET_DIR, 'main.ts'), transformedMainTs);

		// Copy all vscode.proposed.*.d.ts files
		await this.copyVSCodeProposedTypes();
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