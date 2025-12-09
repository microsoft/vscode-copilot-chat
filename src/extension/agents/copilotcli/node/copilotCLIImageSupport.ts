/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { createDirectoryIfNotExists, IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { URI } from '../../../../util/vs/base/common/uri';
import { FileType } from '../../../../vscodeTypes';

export class CopilotCLIImageSupport {
	private readonly storageDir: URI;
	private readonly initialized: Lazy<Promise<void>>;
	constructor(
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) {
		this.storageDir = URI.joinPath(this.context.globalStorageUri, 'copilot-cli-images');
		this.initialized = new Lazy<Promise<void>>(() => this.initialize());
		void this.initialized.value;
	}

	private async initialize(): Promise<void> {
		try {
			await createDirectoryIfNotExists(this.fileSystemService, this.storageDir);
			void this.cleanupOldImages();
		} catch (error) {
			this.logService.error(`[CopilotCLISession] ImageStorage: Failed to initialize`, error);
		}
	}

	async storeImage(imageData: Uint8Array, mimeType: string): Promise<URI> {
		await this.initialized.value;
		const timestamp = Date.now();
		const randomId = Math.random().toString(36).substring(2, 10);
		const extension = this.getExtension(mimeType);
		const filename = `${timestamp}-${randomId}${extension}`;
		const imageUri = URI.joinPath(this.storageDir, filename);

		await this.workspaceService.fs.writeFile(imageUri, imageData);
		return imageUri;
	}

	async cleanupOldImages(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
		try {
			const entries = await this.workspaceService.fs.readDirectory(this.storageDir);
			const now = Date.now();
			const cutoff = now - maxAgeMs;

			for (const [filename, fileType] of entries) {
				if (fileType === FileType.File) {
					const fileUri = URI.joinPath(this.storageDir, filename);
					try {
						const stat = await this.workspaceService.fs.stat(fileUri);
						if (stat.mtime < cutoff) {
							await this.workspaceService.fs.delete(fileUri);
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
