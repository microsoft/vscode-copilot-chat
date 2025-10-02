/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Recursively finds all strings matching the pattern %key% in a JSON object
 */
function findLocalizationKeys(obj: any, keys: Set<string> = new Set()): Set<string> {
	if (typeof obj === 'string') {
		// Match strings like %github.copilot.badge.signUp%
		const match = /^%([^%]+)%$/.exec(obj);
		if (match) {
			// Remove the % symbols to get just the key
			const key = match[1];
			keys.add(key);
		}
	} else if (Array.isArray(obj)) {
		for (const item of obj) {
			findLocalizationKeys(item, keys);
		}
	} else if (obj !== null && typeof obj === 'object') {
		for (const value of Object.values(obj)) {
			findLocalizationKeys(value, keys);
		}
	}
	return keys;
}

async function main() {
	const packageJsonPath = path.join(REPO_ROOT, 'package.json');
	const packageNlsPath = path.join(REPO_ROOT, 'package.nls.json');

	// Read package.json
	const packageJsonContent = await fs.promises.readFile(packageJsonPath, 'utf-8');
	const packageJson = JSON.parse(packageJsonContent);

	// Read package.nls.json
	const packageNlsContent = await fs.promises.readFile(packageNlsPath, 'utf-8');
	const packageNls = JSON.parse(packageNlsContent);

	// Find all localization keys in package.json
	const localizationKeys = findLocalizationKeys(packageJson);

	console.log(`Found ${localizationKeys.size} localization keys in package.json`);

	// Get all keys from package.nls.json
	const nlsKeys = new Set(Object.keys(packageNls));
	console.log(`Found ${nlsKeys.size} keys in package.nls.json`);

	// Check for missing keys
	const missingKeys: string[] = [];
	for (const key of localizationKeys) {
		if (!nlsKeys.has(key)) {
			missingKeys.push(key);
		}
	}

	if (missingKeys.length > 0) {
		console.error('\n❌ ERROR: The following localization keys are used in package.json but not defined in package.nls.json:');
		for (const key of missingKeys.sort()) {
			console.error(`  - ${key}`);
		}
		process.exit(1);
	}

	console.log('\n✅ All localization keys in package.json are defined in package.nls.json');
}

main().catch(error => {
	console.error('Error:', error);
	process.exit(1);
});
