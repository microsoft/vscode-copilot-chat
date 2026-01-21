/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PromptsType } from '../../../platform/customInstructions/common/promptTypes';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { createDecorator } from '../../../util/vs/platform/instantiation/common/instantiation';

export interface IGitHubOrgChatResourcesService extends IDisposable {
	/**
	 * Returns the organization that should be used for the current session.
	 */
	getPreferredOrganizationName(): Promise<string | undefined>;

	/**
	 * Creates a polling subscription with a custom interval.
	 * The callback will be invoked at the specified interval.
	 * @param intervalMs The polling interval in milliseconds
	 * @param callback The callback to invoke on each poll cycle
	 * @returns A disposable that stops the polling when disposed
	 */
	createPollingSubscription(intervalMs: number, callback: (orgName: string) => void): IDisposable;

	/**
	 * Reads a specific cached resource.
	 * @returns The content of the resource, or undefined if not found
	 */
	readCacheFile(type: PromptsType, orgName: string, filename: string): Promise<string | undefined>;

	/**
	 * Writes a resource to the cache.
	 * @returns True if the content was changed, false if unchanged
	 */
	writeCacheFile(type: PromptsType, orgName: string, filename: string, content: string, options?: { checkForChanges?: boolean }): Promise<boolean>;

	/**
	 * Deletes all cached resources of specified type for an organization.
	 * Optionally provide set of filenames to exclude from deletion.
	 */
	clearCache(type: PromptsType, orgName: string, exclude?: Set<string>): Promise<void>;

	/**
	 * Lists all cached resources for a specific organization and type.
	 * @returns The list of cached resources.
	 */
	listCachedFiles(type: PromptsType, orgName: string): Promise<vscode.ChatResource[]>;
}

export const IGitHubOrgChatResourcesService = createDecorator<IGitHubOrgChatResourcesService>('IGitHubPromptFileService');

export class GitHubOrgChatResourcesService extends Disposable implements IGitHubOrgChatResourcesService {
	getPreferredOrganizationName(): Promise<string | undefined> {
		throw new Error('Method not implemented.');
	}
	createPollingSubscription(intervalMs: number, callback: (orgName: string, token: vscode.CancellationToken) => void): IDisposable {
		throw new Error('Method not implemented.');
	}
	readCacheFile(type: PromptsType, orgName: string, filename: string): Promise<string | undefined> {
		throw new Error('Method not implemented.');
	}
	writeCacheFile(type: PromptsType, orgName: string, filename: string, content: string, options?: { checkForChanges?: boolean }): Promise<boolean> {
		throw new Error('Method not implemented.');
	}
	clearCache(type: PromptsType, orgName: string): Promise<void> {
		throw new Error('Method not implemented.');
	}
	listCachedFiles(type: PromptsType, orgName: string): Promise<vscode.ChatResource[]> {
		throw new Error('Method not implemented.');
	}
}
