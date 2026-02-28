/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration script to convert relative imports to #src/ path aliases.
 *
 * Usage:
 *   tsx script/migrateToPathAliases.ts [--dry-run]
 *
 * This script transforms relative imports like:
 *   import { foo } from '../../util/common/foo';
 * Into:
 *   import { foo } from '#src/util/common/foo';
 *
 * Files excluded from migration:
 * - src/util/vs/** (VS Code core copies)
 * - src/extension/completions-core/** (separate embedded project)
 * - *.d.ts files
 * - Files containing "//!!! DO NOT modify" header
 */

import * as fs from 'fs';
import { glob } from 'glob';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const DRY_RUN = process.argv.includes('--dry-run');

// Patterns to exclude from migration
const EXCLUDED_PATTERNS = [
	'src/util/vs/**/*',
	'src/extension/completions-core/**/*',
	'src/extension/typescriptContext/serverPlugin/**/*', // Separate build with own tsconfig
	'**/*.d.ts',
];

// Header that indicates a file should not be modified
const DO_NOT_MODIFY_HEADER = '//!!! DO NOT modify';

interface MigrationResult {
	file: string;
	changes: number;
	skipped: boolean;
	skipReason?: string;
}

/**
 * Check if a file should be excluded based on header content
 */
function hasDoNotModifyHeader(content: string): boolean {
	const firstLines = content.slice(0, 500);
	return firstLines.includes(DO_NOT_MODIFY_HEADER);
}

/**
 * Resolve a relative import path to an absolute path
 */
function resolveImportPath(importPath: string, fromFile: string): string | null {
	const fromDir = path.dirname(fromFile);
	const resolved = path.resolve(fromDir, importPath);

	// Handle various extensions
	const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

	for (const ext of extensions) {
		const fullPath = resolved + ext;
		if (fs.existsSync(fullPath)) {
			return fullPath;
		}
	}

	return null;
}

/**
 * Convert an absolute path to a #src/ import path
 */
function toSrcAliasPath(absolutePath: string): string | null {
	// Check if the path is under src/
	if (!absolutePath.startsWith(SRC_DIR + path.sep)) {
		return null;
	}

	// Get relative path from src/
	let relativePath = path.relative(SRC_DIR, absolutePath);

	// Normalize to forward slashes
	relativePath = relativePath.split(path.sep).join('/');

	// Remove index suffix
	if (relativePath.endsWith('/index.ts') || relativePath.endsWith('/index.tsx')) {
		relativePath = relativePath.replace(/\/index\.tsx?$/, '');
	}

	// Remove .ts/.tsx extension
	relativePath = relativePath.replace(/\.tsx?$/, '');

	return `#src/${relativePath}`;
}

/**
 * Transform imports in a file content
 */
function transformImports(content: string, filePath: string): { content: string; changes: number } {
	let changes = 0;

	// Match import and export statements with relative paths
	// This regex matches:
	// - import ... from '...'
	// - import ... from "..."
	// - export ... from '...'
	// - export ... from "..."
	// - import('...')
	// - require('...')
	const importRegex = /(?:(?:import|export)\s+(?:(?:[\w{}\s*,]+)\s+from\s+)?|(?:import|require)\s*\(\s*)(['"])(\.[^'"]+)\1/g;

	const newContent = content.replace(importRegex, (match, quote, importPath) => {
		// Only process relative imports
		if (!importPath.startsWith('.')) {
			return match;
		}

		// Resolve the import path to an absolute path
		const absolutePath = resolveImportPath(importPath, filePath);
		if (!absolutePath) {
			// Can't resolve, skip
			return match;
		}

		// Check if the resolved path is under src/
		const aliasPath = toSrcAliasPath(absolutePath);
		if (!aliasPath) {
			// Not under src/, keep relative
			return match;
		}

		changes++;
		return match.replace(importPath, aliasPath);
	});

	return { content: newContent, changes };
}

/**
 * Process a single file
 */
function processFile(filePath: string): MigrationResult {
	const relativePath = path.relative(REPO_ROOT, filePath);

	// Read file content
	const content = fs.readFileSync(filePath, 'utf-8');

	// Check for DO NOT MODIFY header
	if (hasDoNotModifyHeader(content)) {
		return { file: relativePath, changes: 0, skipped: true, skipReason: 'DO NOT modify header' };
	}

	// Transform imports
	const { content: newContent, changes } = transformImports(content, filePath);

	if (changes > 0 && !DRY_RUN) {
		fs.writeFileSync(filePath, newContent, 'utf-8');
	}

	return { file: relativePath, changes, skipped: false };
}

async function main() {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`  Path Alias Migration Script`);
	console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes will be written)' : 'LIVE'}`);
	console.log(`${'='.repeat(60)}\n`);

	// Find all TypeScript files in src/ excluding patterns
	const files = await glob('src/**/*.{ts,tsx}', {
		cwd: REPO_ROOT,
		posix: true,
		ignore: EXCLUDED_PATTERNS,
		absolute: true,
	});

	console.log(`Found ${files.length} files to process\n`);

	const results: MigrationResult[] = [];
	let totalChanges = 0;
	let filesChanged = 0;
	let filesSkipped = 0;

	for (const file of files) {
		const result = processFile(file);
		results.push(result);

		if (result.skipped) {
			filesSkipped++;
		} else if (result.changes > 0) {
			filesChanged++;
			totalChanges += result.changes;
			console.log(`  ${result.file}: ${result.changes} import(s) changed`);
		}
	}

	console.log(`\n${'='.repeat(60)}`);
	console.log(`  Summary:`);
	console.log(`  - Files processed: ${files.length}`);
	console.log(`  - Files changed: ${filesChanged}`);
	console.log(`  - Files skipped: ${filesSkipped}`);
	console.log(`  - Total imports changed: ${totalChanges}`);
	if (DRY_RUN) {
		console.log(`\n  Run without --dry-run to apply changes.`);
	}
	console.log(`${'='.repeat(60)}\n`);
}

main().catch(err => {
	console.error('Migration failed:', err);
	process.exit(1);
});
