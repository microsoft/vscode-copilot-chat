/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';

/**
 * Azure DevOps work item representation
 */
export interface AzureDevOpsWorkItem {
	readonly id: number;
	readonly rev: number;
	readonly fields: Record<string, unknown>;
	readonly url: string;
}

/**
 * Azure DevOps work item query result
 */
export interface AzureDevOpsQueryResult {
	readonly queryType: string;
	readonly queryResultType: string;
	readonly asOf: string;
	readonly workItems: readonly { readonly id: number; readonly url: string }[];
}

/**
 * Azure DevOps work item update operation
 */
export interface WorkItemPatchOperation {
	readonly op: 'add' | 'replace' | 'remove' | 'test';
	readonly path: string;
	readonly value?: unknown;
}

/**
 * Azure DevOps work item comment
 */
export interface AzureDevOpsComment {
	readonly id: number;
	readonly text: string;
	readonly createdBy: { readonly displayName: string };
	readonly createdDate: string;
}

/**
 * Configuration for Azure DevOps API client
 */
export interface AzureDevOpsConfig {
	readonly orgUrl: string;
	readonly pat: string;
	readonly defaultProject: string;
}

/**
 * Azure DevOps wiki summary
 */
export interface AzureDevOpsWiki {
	readonly id: string;
	readonly name: string;
	readonly type: 'projectWiki' | 'codeWiki';
	readonly url: string;
}

/**
 * Azure DevOps wiki page with content and ETag for concurrency
 */
export interface AzureDevOpsWikiPage {
	readonly id: number;
	readonly path: string;
	readonly content?: string;
	readonly etag: string;
	readonly subPages?: readonly { readonly id: number; readonly path: string }[];
}

/**
 * Client for Azure DevOps REST API operations.
 * Handles work item CRUD, queries (WIQL), comments, and wiki pages.
 */
export class AzureDevOpsClient {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) { }

	/**
	 * Read Azure DevOps configuration from VS Code settings.
	 */
	getConfig(): AzureDevOpsConfig {
		const orgUrl = this.configurationService.getNonExtensionConfig<string>('yourcompany.ado.orgUrl') ?? '';
		const pat = this.configurationService.getNonExtensionConfig<string>('yourcompany.ado.pat') ?? '';
		const defaultProject = this.configurationService.getNonExtensionConfig<string>('yourcompany.ado.defaultProject') ?? '';
		const redactedPat = pat.length > 4 ? pat.substring(0, 4) + '****' : '(empty)';
		this.logService.debug(`[AzureDevOps] Config — orgUrl: "${orgUrl}", project: "${defaultProject}", pat: ${redactedPat}`);
		return { orgUrl, pat, defaultProject };
	}

	/**
	 * Check if the Azure DevOps integration is configured.
	 */
	isConfigured(): boolean {
		const config = this.getConfig();
		return config.orgUrl.length > 0 && config.pat.length > 0;
	}

	/**
	 * Build authorization header from PAT.
	 */
	private _getAuthHeaders(pat: string): Record<string, string> {
		const encoded = Buffer.from(`:${pat}`).toString('base64');
		return {
			'Authorization': `Basic ${encoded}`,
			'Content-Type': 'application/json',
		};
	}

	/**
	 * Make an authenticated request to the Azure DevOps REST API.
	 */
	private async _fetch(url: string, options: RequestInit = {}): Promise<Response> {
		const config = this.getConfig();
		if (!config.orgUrl || !config.pat) {
			throw new Error('Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.');
		}

		const headers = {
			...this._getAuthHeaders(config.pat),
			...options.headers as Record<string, string>,
		};

		const method = (options.method ?? 'GET').toUpperCase();
		this.logService.info(`[AzureDevOps] ${method} ${url}`);
		const response = await fetch(url, { ...options, headers });

		if (!response.ok) {
			const body = await response.text();
			this.logService.error(`[AzureDevOps] ${method} ${url} → ${response.status}: ${body}`);
			throw new Error(`Azure DevOps API error (${response.status}) on ${method} ${url}: ${body}`);
		}

		return response;
	}

	/**
	 * Get a single work item by ID.
	 */
	async getWorkItem(id: number, project?: string): Promise<AzureDevOpsWorkItem> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		const url = `${baseUrl}${projectSegment}/_apis/wit/workitems/${id}?api-version=7.1&$expand=all`;

		const response = await this._fetch(url);
		return await response.json() as AzureDevOpsWorkItem;
	}

	/**
	 * Get multiple work items by IDs.
	 */
	async getWorkItems(ids: readonly number[], project?: string): Promise<readonly AzureDevOpsWorkItem[]> {
		if (ids.length === 0) {
			return [];
		}

		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');
		const idList = ids.join(',');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		const url = `${baseUrl}${projectSegment}/_apis/wit/workitems?ids=${idList}&api-version=7.1&$expand=all`;

		const response = await this._fetch(url);
		const result = await response.json() as { value: AzureDevOpsWorkItem[] };
		return result.value;
	}

	/**
	 * Run a WIQL (Work Item Query Language) query.
	 */
	async queryWorkItems(wiql: string, project?: string, top?: number): Promise<AzureDevOpsQueryResult> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		let url = `${baseUrl}${projectSegment}/_apis/wit/wiql?api-version=7.1`;

		if (top !== undefined) {
			url += `&$top=${top}`;
		}

		const response = await this._fetch(url, {
			method: 'POST',
			body: JSON.stringify({ query: wiql }),
		});

		return await response.json() as AzureDevOpsQueryResult;
	}

	/**
	 * Update a work item using JSON Patch operations.
	 */
	async updateWorkItem(id: number, operations: readonly WorkItemPatchOperation[], project?: string): Promise<AzureDevOpsWorkItem> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		const url = `${baseUrl}${projectSegment}/_apis/wit/workitems/${id}?api-version=7.1`;

		const response = await this._fetch(url, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json-patch+json' },
			body: JSON.stringify(operations),
		});

		return await response.json() as AzureDevOpsWorkItem;
	}

	/**
	 * Create a new work item.
	 */
	async createWorkItem(workItemType: string, operations: readonly WorkItemPatchOperation[], project?: string): Promise<AzureDevOpsWorkItem> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		if (!proj) {
			throw new Error('Project is required for creating work items. Set yourcompany.ado.defaultProject or pass a project name.');
		}

		const baseUrl = config.orgUrl.replace(/\/$/, '');
		const url = `${baseUrl}/${encodeURIComponent(proj)}/_apis/wit/workitems/$${encodeURIComponent(workItemType)}?api-version=7.1`;

		const response = await this._fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json-patch+json' },
			body: JSON.stringify(operations),
		});

		return await response.json() as AzureDevOpsWorkItem;
	}

	/**
	 * Add a comment to a work item.
	 */
	async addComment(workItemId: number, text: string, project?: string): Promise<AzureDevOpsComment> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		const url = `${baseUrl}${projectSegment}/_apis/wit/workitems/${workItemId}/comments?api-version=7.1-preview.4`;

		const response = await this._fetch(url, {
			method: 'POST',
			body: JSON.stringify({ text }),
		});

		return await response.json() as AzureDevOpsComment;
	}

	/**
	 * Get comments for a work item.
	 */
	async getComments(workItemId: number, project?: string): Promise<readonly AzureDevOpsComment[]> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		const url = `${baseUrl}${projectSegment}/_apis/wit/workitems/${workItemId}/comments?api-version=7.1-preview.4`;

		const response = await this._fetch(url);
		const result = await response.json() as { comments: AzureDevOpsComment[] };
		return result.comments;
	}

	/**
	 * Format a work item into a human-readable summary.
	 */
	formatWorkItem(workItem: AzureDevOpsWorkItem): string {
		const fields = workItem.fields;
		const lines: string[] = [];

		lines.push(`# Work Item ${workItem.id}`);
		lines.push('');

		if (fields['System.Title']) {
			lines.push(`**Title:** ${fields['System.Title']}`);
		}
		if (fields['System.WorkItemType']) {
			lines.push(`**Type:** ${fields['System.WorkItemType']}`);
		}
		if (fields['System.State']) {
			lines.push(`**State:** ${fields['System.State']}`);
		}
		if (fields['System.AssignedTo']) {
			const assignedTo = fields['System.AssignedTo'] as { displayName?: string } | string;
			const name = typeof assignedTo === 'string' ? assignedTo : assignedTo?.displayName ?? 'Unknown';
			lines.push(`**Assigned To:** ${name}`);
		}
		if (fields['System.IterationPath']) {
			lines.push(`**Iteration:** ${fields['System.IterationPath']}`);
		}
		if (fields['System.AreaPath']) {
			lines.push(`**Area:** ${fields['System.AreaPath']}`);
		}
		if (fields['Microsoft.VSTS.Common.Priority']) {
			lines.push(`**Priority:** ${fields['Microsoft.VSTS.Common.Priority']}`);
		}
		if (fields['System.Tags']) {
			lines.push(`**Tags:** ${fields['System.Tags']}`);
		}

		lines.push('');

		if (fields['System.Description']) {
			lines.push('## Description');
			lines.push(String(fields['System.Description']));
			lines.push('');
		}

		if (fields['Microsoft.VSTS.TCM.ReproSteps']) {
			lines.push('## Repro Steps');
			lines.push(String(fields['Microsoft.VSTS.TCM.ReproSteps']));
			lines.push('');
		}

		if (fields['System.History']) {
			lines.push('## Latest History');
			lines.push(String(fields['System.History']));
			lines.push('');
		}

		if (fields['Microsoft.VSTS.Common.AcceptanceCriteria']) {
			lines.push('## Acceptance Criteria');
			lines.push(String(fields['Microsoft.VSTS.Common.AcceptanceCriteria']));
			lines.push('');
		}

		return lines.join('\n');
	}

	/**
	 * List all wikis in a project.
	 */
	async listWikis(project?: string): Promise<readonly AzureDevOpsWiki[]> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		const url = `${baseUrl}${projectSegment}/_apis/wiki/wikis?api-version=7.1`;

		const response = await this._fetch(url);
		const result = await response.json() as { value: AzureDevOpsWiki[] };
		return result.value;
	}

	/**
	 * Get a wiki page with its content and ETag.
	 */
	async getWikiPage(wikiIdentifier: string, path: string, project?: string): Promise<AzureDevOpsWikiPage> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		const url = `${baseUrl}${projectSegment}/_apis/wiki/wikis/${encodeURIComponent(wikiIdentifier)}/pages?path=${encodeURIComponent(path)}&includeContent=true&api-version=7.1`;

		const response = await this._fetch(url);
		const etag = response.headers.get('etag') ?? '';
		const page = await response.json() as { id: number; path: string; content?: string; subPages?: { id: number; path: string }[] };
		return { ...page, etag };
	}

	/**
	 * Create or update a wiki page.
	 * For updates, pass the ETag from a previous getWikiPage call.
	 */
	async createOrUpdateWikiPage(wikiIdentifier: string, path: string, content: string, etag?: string, project?: string): Promise<AzureDevOpsWikiPage> {
		const config = this.getConfig();
		const proj = project || config.defaultProject;
		const baseUrl = config.orgUrl.replace(/\/$/, '');

		const projectSegment = proj ? `/${encodeURIComponent(proj)}` : '';
		const url = `${baseUrl}${projectSegment}/_apis/wiki/wikis/${encodeURIComponent(wikiIdentifier)}/pages?path=${encodeURIComponent(path)}&api-version=7.1`;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (etag) {
			headers['If-Match'] = etag;
		}

		const response = await this._fetch(url, {
			method: 'PUT',
			headers,
			body: JSON.stringify({ content }),
		});

		const newEtag = response.headers.get('etag') ?? '';
		const page = await response.json() as { id: number; path: string; content?: string };
		return { ...page, etag: newEtag };
	}
}
