/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import { ILogService } from '../../../../platform/log/common/logService';

let shimCreated: Promise<void> | undefined = undefined;

/**
 * Copies the node-pty files from VS Code's installation into a @github/copilot location
 *
 * MUST be called before any `import('@github/copilot/sdk')` or `import('@github/copilot')`.
 *
 * @github/copilot bundles the node-pty code and its no longer possible to shim the package.
 *
 * @param extensionPath The extension's path (where to create the shim)
 * @param vscodeAppRoot VS Code's installation path (where node-pty is located)
 */
export async function ensureNodePtyShim(extensionPath: string, vscodeAppRoot: string, logService: ILogService): Promise<void> {
	if (shimCreated) {
		return shimCreated;
	}

	shimCreated = _ensureNodePtyShim(extensionPath, vscodeAppRoot, logService);
	return shimCreated;
}

async function _ensureNodePtyShim(extensionPath: string, vscodeAppRoot: string, logService: ILogService): Promise<void> {
	const nodePtyDir = path.join(extensionPath, 'node_modules', '@github', 'copilot', 'prebuilds', process.platform + "-" + process.arch);
	const vscodeNodePtyPath = path.join(vscodeAppRoot, 'node_modules', 'node-pty', 'build', 'Release');

	try {
		const files = (await fs.readdir(vscodeNodePtyPath)).map(f => path.join(vscodeNodePtyPath, f));
		await fs.mkdir(nodePtyDir, { recursive: true });
		await Promise.all(files.map(async file => {
			const dest = path.join(nodePtyDir, path.basename(file));
			if ((await fs.stat(dest).then(stat => stat.isFile()).catch(() => false)) === false) {
				await fs.copyFile(file, dest);
			}
		}));
	} catch (error) {
		logService.error(`Failed to create node-pty shim (vscode dir: ${vscodeNodePtyPath}, extension dir: ${nodePtyDir})`, error);
		throw error;
	}
}
