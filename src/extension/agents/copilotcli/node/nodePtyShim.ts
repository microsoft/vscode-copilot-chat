/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';

let shimCreated: Promise<void> | undefined = undefined;

/**
 * Creates a node-pty ESM shim that @github/copilot can import.
 *
 * MUST be called before any `import('@github/copilot/sdk')` or `import('@github/copilot')`.
 *
 * @github/copilot has hardcoded ESM imports: import{spawn}from"node-pty"
 * We create a shim module that uses createRequire to load VS Code's bundled node-pty.
 *
 * @param extensionPath The extension's path (where to create the shim)
 * @param vscodeAppRoot VS Code's installation path (where node-pty is located)
 */
export async function ensureNodePtyShim(extensionPath: string, vscodeAppRoot: string): Promise<void> {
	if (shimCreated) {
		return shimCreated;
	}

	shimCreated = _ensureNodePtyShim(extensionPath, vscodeAppRoot);
	return shimCreated;
}

async function _ensureNodePtyShim(extensionPath: string, vscodeAppRoot: string): Promise<void> {
	const nodePtyDir = path.join(extensionPath, 'node_modules', 'node-pty');
	const vscodeNodePtyPath = path.join(vscodeAppRoot, 'node_modules', 'node-pty', 'lib', 'index.js');

	try {
		// Remove any existing node-pty (might be from other packages' dependencies)
		try {
			await fs.rm(nodePtyDir, { recursive: true, force: true });
		} catch {
			// Ignore if doesn't exist
		}

		await fs.mkdir(nodePtyDir, { recursive: true });

		// Create package.json with ESM type
		const packageJson = {
			name: 'node-pty',
			version: '1.0.0',
			type: 'module',
			exports: './index.mjs'
		};
		await fs.writeFile(
			path.join(nodePtyDir, 'package.json'),
			JSON.stringify(packageJson, null, 2)
		);

		// Create index.mjs that dynamically loads VS Code's node-pty at runtime
		// Use the full absolute path to VS Code's node-pty to avoid module resolution issues
		const indexMjs = `// ESM wrapper for VS Code's bundled node-pty
// This shim allows @github/copilot (ESM) to import node-pty from VS Code (CommonJS)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load VS Code's node-pty (CommonJS) using absolute path
const nodePty = require('${vscodeNodePtyPath.replace(/\\/g, '\\\\')}');

// Re-export all named exports
export const spawn = nodePty.spawn;
export const IPty = nodePty.IPty;
export const native = nodePty.native;

// Re-export default
export default nodePty;
`;
		await fs.writeFile(path.join(nodePtyDir, 'index.mjs'), indexMjs);

	} catch (error) {
		console.warn('Failed to create node-pty shim:', error);
		throw error;
	}
}
