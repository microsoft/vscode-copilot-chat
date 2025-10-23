/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { URI } from '../../../util/vs/base/common/uri';

export class ImageStorage {
	private readonly storageDir: URI;

	constructor(private readonly context: IVSCodeExtensionContext) {
		this.storageDir = URI.joinPath(this.context.globalStorageUri, 'copilot-cli-images');
		this.initialize();
	}

	private async initialize(): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(this.storageDir);
			await this.cleanupOldImages();
		} catch (error) {
			console.error('ImageStorage: Failed to initialize', error);
		}
	}

	async storeImage(imageData: Uint8Array, mimeType: string): Promise<URI> {
		const timestamp = Date.now();
		const randomId = Math.random().toString(36).substring(2, 10);
		const extension = this.getExtension(mimeType);
		const filename = `${timestamp}-${randomId}${extension}`;
		const imageUri = URI.joinPath(this.storageDir, filename);

		await vscode.workspace.fs.writeFile(imageUri, imageData);
		return imageUri;
	}

	async getImage(uri: URI): Promise<Uint8Array | undefined> {
		try {
			const data = await vscode.workspace.fs.readFile(uri);
			return data;
		} catch {
			return undefined;
		}
	}

	async deleteImage(uri: URI): Promise<void> {
		try {
			await vscode.workspace.fs.delete(uri);
		} catch {
			// Already deleted
		}
	}

	async cleanupOldImages(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
		try {
			const entries = await vscode.workspace.fs.readDirectory(this.storageDir);
			const now = Date.now();
			const cutoff = now - maxAgeMs;

			for (const [filename, fileType] of entries) {
				if (fileType === vscode.FileType.File) {
					const fileUri = URI.joinPath(this.storageDir, filename);
					try {
						const stat = await vscode.workspace.fs.stat(fileUri);
						if (stat.mtime < cutoff) {
							await vscode.workspace.fs.delete(fileUri);
						}
					} catch {
						// Skip files we can't access
					}
				}
			}
		} catch (error) {
			console.error('ImageStorage: Failed to cleanup old images', error);
		}
	}

	private getExtension(mimeType: string): string {
		const map: Record<string, string> = {
			'image/png': '.png',
			'image/jpeg': '.jpg',
			'image/jpg': '.jpg',
			'image/gif': '.gif',
			'image/webp': '.webp',
			'image/bmp': '.bmp',
		};
		return map[mimeType.toLowerCase()] || '.bin';
	}
}