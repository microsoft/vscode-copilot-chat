/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PromptsType } from '../../../../platform/customInstructions/common/promptTypes';
import { Disposable, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IGitHubOrgChatResourcesService } from '../githubOrgChatResourcesService';

/**
 * Mock implementation of IGitHubOrgChatResourcesService for testing.
 * Uses in-memory storage instead of the file system.
 */
export class MockGithubOrgChatResourcesService extends Disposable implements IGitHubOrgChatResourcesService {
	private readonly storage = new Map<string, Map<string, Map<string, string>>>();
	private readonly baseUri: URI;
	private preferredOrg: string | undefined;

	constructor(baseUri: URI) {
		super();
		this.baseUri = baseUri;
	}

	setPreferredOrganization(orgName: string | undefined): void {
		this.preferredOrg = orgName;
	}

	async getPreferredOrganizationName(): Promise<string | undefined> {
		return this.preferredOrg;
	}

	startPolling(intervalMs: number, callback: (orgName: string) => Promise<void>): IDisposable {
		return toDisposable(() => { });
	}

	setStorage(orgName: string, type: PromptsType, files: Map<string, string>): void {
		if (!this.storage.has(orgName)) {
			this.storage.set(orgName, new Map());
		}
		const orgStorage = this.storage.get(orgName)!;
		orgStorage.set(type, files);
	}

	async readCacheFile(type: PromptsType, orgName: string, filename: string): Promise<string | undefined> {
		const orgStorage = this.storage.get(orgName);
		if (!orgStorage) {
			return undefined;
		}
		const typeStorage = orgStorage.get(type);
		if (!typeStorage) {
			return undefined;
		}
		return typeStorage.get(filename);
	}

	async writeCacheFile(type: PromptsType, orgName: string, filename: string, content: string, options?: { checkForChanges?: boolean }): Promise<boolean> {
		if (!this.storage.has(orgName)) {
			this.storage.set(orgName, new Map());
		}
		const orgStorage = this.storage.get(orgName)!;

		if (!orgStorage.has(type)) {
			orgStorage.set(type, new Map());
		}
		const typeStorage = orgStorage.get(type)!;

		if (options?.checkForChanges) {
			const existing = typeStorage.get(filename);
			if (existing === content) {
				return false;
			}
		}

		typeStorage.set(filename, content);
		return true;
	}

	async clearCache(type: PromptsType, orgName: string, exclude?: Set<string>): Promise<void> {
		const orgStorage = this.storage.get(orgName);
		if (!orgStorage) {
			return;
		}
		const typeStorage = orgStorage.get(type);
		if (!typeStorage) {
			return;
		}

		if (exclude) {
			for (const filename of typeStorage.keys()) {
				if (!exclude.has(filename)) {
					typeStorage.delete(filename);
				}
			}
		} else {
			typeStorage.clear();
		}
	}

	async listCachedFiles(type: PromptsType, orgName: string): Promise<vscode.ChatResource[]> {
		const orgStorage = this.storage.get(orgName);
		if (!orgStorage) {
			return [];
		}
		const typeStorage = orgStorage.get(type);
		if (!typeStorage) {
			return [];
		}

		const subdirectory = type === PromptsType.instructions ? 'instructions' : 'agents';
		const resources: vscode.ChatResource[] = [];
		for (const filename of typeStorage.keys()) {
			const uri = URI.joinPath(this.baseUri, 'github', orgName, subdirectory, filename);
			resources.push({ uri });
		}
		return resources;
	}

	clearAllStorage(): void {
		this.storage.clear();
		this.preferredOrg = undefined;
	}
}
