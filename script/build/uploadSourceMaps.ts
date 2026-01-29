/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClientAssertionCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import * as fs from 'fs';
import * as path from 'path';

const root = path.dirname(path.dirname(__dirname));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = packageJson.version;

// CLI arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const versionOverride = args.find(a => a.startsWith('--version='))?.split('=')[1];
const uploadVersion = versionOverride || version;

async function main(): Promise<void> {
	const sourceMapDir = path.join(root, 'dist-sourcemaps');

	if (!fs.existsSync(sourceMapDir)) {
		console.log(`Source maps directory not found: ${sourceMapDir}`);
		console.log('Skipping upload. Run "npm run build" to generate source maps.');
		return;
	}

	if (!process.env.AZURE_STORAGE_ACCOUNT) {
		console.error('Error: AZURE_STORAGE_ACCOUNT environment variable is required');
		console.error('Usage: tsx uploadSourceMaps.ts [--dry-run] [--version=<version>]');
		console.error('Environment variables:');
		console.error('  AZURE_STORAGE_ACCOUNT - Azure storage account name');
		console.error('  AZURE_TENANT_ID       - Azure tenant ID for WIF authentication');
		console.error('  AZURE_CLIENT_ID       - Azure client ID for WIF authentication');
		console.error('  AZURE_ID_TOKEN        - Azure ID token for WIF authentication');

		process.exit(1);
	}

	const files = fs.readdirSync(sourceMapDir).filter(f => f.endsWith('.map'));

	if (files.length === 0) {
		console.log(`No source maps found in ${sourceMapDir}`);
		return;
	}

	const storageAccount = process.env.AZURE_STORAGE_ACCOUNT;
	const blobServiceUrl = `https://${storageAccount}.blob.core.windows.net`;
	const prefix = `sourcemaps/${uploadVersion}`;

	console.log(`Version: ${uploadVersion}`);
	console.log(`Uploading ${files.length} source maps to: ${blobServiceUrl}/$web/${prefix}/`);

	if (isDryRun) {
		console.log(`[DRY RUN] Would upload ${files.length} source maps:`);
		for (const file of files) {
			const filePath = path.join(sourceMapDir, file);
			const fileSize = fs.statSync(filePath).size;
			console.log(`  - ${file} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
		}
		return;
	}

	// Azure Workload Identity Federation credentials (same pattern as VS Code)
	const credential = new ClientAssertionCredential(
		process.env['AZURE_TENANT_ID']!,
		process.env['AZURE_CLIENT_ID']!,
		() => Promise.resolve(process.env['AZURE_ID_TOKEN']!)
	);

	const blobServiceClient = new BlobServiceClient(blobServiceUrl, credential);
	const containerClient = blobServiceClient.getContainerClient('$web');

	for (const file of files) {
		const filePath = path.join(sourceMapDir, file);
		const blobName = `${prefix}/${file}`;
		const blockBlobClient = containerClient.getBlockBlobClient(blobName);

		console.log(`Uploading Sourcemap ${file}`);

		try {
			await blockBlobClient.uploadFile(filePath, {
				blobHTTPHeaders: {
					blobContentType: 'application/json',
					blobCacheControl: 'max-age=31536000, public'
				}
			});
			const fileSize = fs.statSync(filePath).size;
			console.log(`✓ Uploaded: ${file} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
		} catch (error) {
			console.error(`✗ Failed to upload ${file}:`, error instanceof Error ? error.message : error);
			process.exit(1);
		}
	}

	console.log(`\nSuccessfully uploaded ${files.length} source maps`);
	console.log(`Source maps URL: ${blobServiceUrl}/$web/${prefix}/`);
}

main().catch(err => {
	console.error('Error uploading source maps:', err);
	process.exit(1);
});
