/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import * as readline from 'readline';
import * as path from '../../../util/vs/base/common/path';

// ⚠️⚠️⚠️
// This file is built into a standalone bundle, executed from the terminal.
// Avoid including unnecessary dependencies!
//
// This is used on macOS and Linux. On Windows, you'll need to make changes
// in copilotCLITerminalIntegration.ps1 instead. This is because Electron on Windows
// is not built with support for console stdin.
// ⚠️⚠️⚠️

/*
 * Universal GitHub Copilot CLI bootstrapper
 *
 * Works from any interactive shell (bash, zsh, sh, PowerShell Core (pwsh), Nushell, csh/tcsh) via shebang.
 * Responsibilities:
 *   1. Locate the real Copilot CLI binary (avoid recursion if this file shadows it).
 *   2. Offer to install if missing (npm -g @github/copilot).
 *   3. Enforce minimum version (>= REQUIRED_VERSION) with interactive update.
 *   4. Execute the real binary with original arguments and exit with its status.
 *
 * NOTE: This file intentionally keeps logic self‑contained (no external deps) so it can be dropped into PATH directly.
 */

const REQUIRED_VERSION = '0.0.342';
const PACKAGE_NAME = '@github/copilot';
const env = { ...process.env, PATH: (process.env.PATH || '').replaceAll(`${__dirname}${path.delimiter}`, '').replaceAll(`${path.delimiter}${__dirname}`, '') };

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

function log(msg: string) { process.stdout.write(msg + '\n'); }

function warn(msg: string) { process.stderr.write(msg + '\n'); }

function promptYes(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		rl.question(`${question} ['y/N'] `, (answer) => {
			resolve(answer.toLowerCase()[0] === 'y');
		});
	});
}

function semverParts(v: string) {
	const cleaned = v.replace(/^v/, '').split('.');
	return [0, 1, 2].map(i => parseInt((cleaned[i] || '0').replace(/[^0-9].*$/, ''), 10) || 0);
}

function versionGte(versionA: string, versionB: string) {
	const aa = semverParts(versionA), bb = semverParts(versionB);
	for (let i = 0; i < 3; i++) {
		if (aa[i] > bb[i]) { return true; }
		if (aa[i] < bb[i]) { return false; }
	}
	return true;
}

/**
 * Returns the version of Copilot CLI installed.
 * If not installed, then returns `undefined`, else returns an object with the version.
 * Version can be undefined if it cannot be determined.
 */
function getCopilotInfo(): { installed: true; version?: string } | undefined {
	const result = spawnSync('copilot --version', { env, shell: true, encoding: 'utf8' });
	if (result.error || result.status !== 0) {
		return undefined;
	}
	const m = result.stdout.match(/[0-9]+\.[0-9]+\.[0-9]+/);
	return m ? { version: m[0], installed: true } : { installed: true };

}

function runNpm(args: string[], label: string) {
	const result = spawnSync('npm', args, { stdio: 'inherit', env });
	if (result.error) {
		warn(`${label} failed: ${result.error.message}`);
		return false;
	}
	if (result.status !== 0) {
		warn(`${label} failed with exit code ${result.status}`);
		return false;
	}
	return true;
}

async function ensureInstalled() {
	const version = getCopilotInfo();
	if (!version) {
		warn('Cannot find GitHub Copilot CLI (https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)');
		if (await promptYes('Install GitHub Copilot CLI?')) {
			if (runNpm(['install', '-g', PACKAGE_NAME], 'Installing')) {
				return ensureInstalled();
			}
			process.exit(1);
		} else {
			process.exit(0);
		}
	}
	return version;
}

async function validateVersion(version: string) {
	if (!versionGte(version, REQUIRED_VERSION)) {
		warn(`GitHub Copilot CLI version ${version} is not compatible.`);
		log(`Version ${REQUIRED_VERSION} or later is required.`);
		if (await promptYes('Update GitHub Copilot CLI?')) {
			if (runNpm(['update', '-g', PACKAGE_NAME], 'Update')) {
				return true;
			}
			process.exit(1);
		} else {
			process.exit(0);
		}
	}
}

(async function main() {
	const info = await ensureInstalled();
	if (info?.version) {
		await validateVersion(info.version);
	}
	if (!info) {
		warn('Error: Could not locate Copilot CLI after update.');
		warn(`Try manually reinstalling with: npm install -g ${PACKAGE_NAME} (https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)`);
		process.exit(1);
	}
	const args = process.argv.slice(2);

	// In vscode we use `--clear` to indicate that the terminal should be cleared before running the command
	// Used when launching terminal in editor view (for best possible UX, so it doesn't look like a terminal)
	if (args[0] === '--clear') {
		console.clear();
		args.shift();
	}

	const { status } = spawnSync('copilot', args, { stdio: 'inherit', env });
	process.exit(status);
})();
