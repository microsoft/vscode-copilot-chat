/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createSdkMcpServer, McpServerConfig, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { AzureDevOpsClient, WorkItemPatchOperation } from '../azureDevOps/azureDevOpsClient';
import { IClaudeMcpServerContributor, registerClaudeMcpServerContributor } from '../claudeMcpServerRegistry';

class AzureDevOpsMcpServerContributor implements IClaudeMcpServerContributor {

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async getMcpServers(): Promise<Record<string, McpServerConfig>> {
		if (!this.client.isConfigured()) {
			this.logService.debug('[AzureDevOps] Not configured, skipping MCP server registration');
			return {};
		}

		const client = this.client;

		// ---- Read Tools ----

		const getWorkItemTool = tool(
			'ado_getWorkItem',
			'Get a single Azure DevOps work item by its ID. Returns all fields including title, state, description, assigned to, etc.',
			{
				id: z.number().describe('The work item ID'),
				project: z.string().optional().describe('The project name. Uses the default project if not provided.'),
			},
			async (args: { id: number; project?: string }) => {
				const workItem = await client.getWorkItem(args.id, args.project);
				const formatted = client.formatWorkItem(workItem);
				return {
					content: [{
						type: 'text' as const,
						text: formatted,
					}],
				};
			}
		);

		const queryWorkItemsTool = tool(
			'ado_queryWorkItems',
			'Search for Azure DevOps work items using a WIQL (Work Item Query Language) query. Returns matching work items with their details. WIQL is SQL-like: SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.State] = \'Active\'. Common fields: System.Title, System.State, System.AssignedTo, System.WorkItemType, System.Tags, System.AreaPath, System.IterationPath, Microsoft.VSTS.Common.Priority.',
			{
				wiql: z.string().describe('The WIQL query string. Example: SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.WorkItemType] = \'Bug\' AND [System.State] = \'Active\' ORDER BY [System.CreatedDate] DESC'),
				project: z.string().optional().describe('The project name. Uses the default project if not provided.'),
				top: z.number().optional().describe('Maximum number of results to return. Defaults to 20.'),
			},
			async (args: { wiql: string; project?: string; top?: number }) => {
				const top = args.top ?? 20;
				const queryResult = await client.queryWorkItems(args.wiql, args.project, top);

				if (queryResult.workItems.length === 0) {
					return {
						content: [{
							type: 'text' as const,
							text: 'No work items found matching the query.',
						}],
					};
				}

				// Fetch full details for the found work items
				const ids = queryResult.workItems.map(wi => wi.id);
				const workItems = await client.getWorkItems(ids, args.project);

				const formatted = workItems.map(wi => client.formatWorkItem(wi)).join('\n---\n\n');
				return {
					content: [{
						type: 'text' as const,
						text: `Found ${workItems.length} work item(s):\n\n${formatted}`,
					}],
				};
			}
		);

		const getCommentsTool = tool(
			'ado_getComments',
			'Get comments/discussion for an Azure DevOps work item.',
			{
				workItemId: z.number().describe('The work item ID'),
				project: z.string().optional().describe('The project name. Uses the default project if not provided.'),
			},
			async (args: { workItemId: number; project?: string }) => {
				const comments = await client.getComments(args.workItemId, args.project);

				if (comments.length === 0) {
					return {
						content: [{
							type: 'text' as const,
							text: `No comments found for work item ${args.workItemId}.`,
						}],
					};
				}

				const formatted = comments.map(c =>
					`**${c.createdBy.displayName}** (${c.createdDate}):\n${c.text}`
				).join('\n\n---\n\n');

				return {
					content: [{
						type: 'text' as const,
						text: `Comments for work item ${args.workItemId}:\n\n${formatted}`,
					}],
				};
			}
		);

		// ---- Write Tools ----

		const updateWorkItemTool = tool(
			'ado_updateWorkItem',
			'Update an Azure DevOps work item. Can modify fields like state, title, assigned to, priority, tags, description, etc. Uses JSON Patch operations. Common field paths: /fields/System.Title, /fields/System.State, /fields/System.AssignedTo, /fields/System.Tags, /fields/System.Description, /fields/Microsoft.VSTS.Common.Priority.',
			{
				id: z.number().describe('The work item ID to update'),
				operations: z.array(z.object({
					op: z.enum(['add', 'replace', 'remove']).describe('The operation type. Use "replace" to update an existing field, "add" to set a field, "remove" to clear a field.'),
					path: z.string().describe('The field path. Example: /fields/System.State'),
					value: z.unknown().optional().describe('The new value for the field'),
				})).describe('Array of JSON Patch operations to apply'),
				project: z.string().optional().describe('The project name. Uses the default project if not provided.'),
			},
			async (args: { id: number; operations: WorkItemPatchOperation[]; project?: string }) => {
				const workItem = await client.updateWorkItem(args.id, args.operations, args.project);
				const formatted = client.formatWorkItem(workItem);
				return {
					content: [{
						type: 'text' as const,
						text: `Successfully updated work item ${workItem.id}:\n\n${formatted}`,
					}],
				};
			}
		);

		const createWorkItemTool = tool(
			'ado_createWorkItem',
			'Create a new Azure DevOps work item. Specify the type (Bug, Task, User Story, Feature, Epic, etc.) and field values using JSON Patch operations.',
			{
				workItemType: z.string().describe('The work item type. Common types: Bug, Task, User Story, Feature, Epic'),
				fields: z.array(z.object({
					path: z.string().describe('The field path. Example: /fields/System.Title'),
					value: z.unknown().describe('The value for the field'),
				})).describe('Array of field values to set on the new work item'),
				project: z.string().optional().describe('The project name. Uses the default project if not provided.'),
			},
			async args => {
				const operations: WorkItemPatchOperation[] = args.fields.map(f => ({
					op: 'add' as const,
					path: f.path,
					value: f.value,
				}));
				const workItem = await client.createWorkItem(args.workItemType, operations, args.project);
				const formatted = client.formatWorkItem(workItem);
				return {
					content: [{
						type: 'text' as const,
						text: `Successfully created work item ${workItem.id}:\n\n${formatted}`,
					}],
				};
			}
		);

		const addCommentTool = tool(
			'ado_addComment',
			'Add a comment to an Azure DevOps work item discussion.',
			{
				workItemId: z.number().describe('The work item ID'),
				text: z.string().describe('The comment text (supports HTML)'),
				project: z.string().optional().describe('The project name. Uses the default project if not provided.'),
			},
			async (args: { workItemId: number; text: string; project?: string }) => {
				const comment = await client.addComment(args.workItemId, args.text, args.project);
				return {
					content: [{
						type: 'text' as const,
						text: `Comment added to work item ${args.workItemId} by ${comment.createdBy.displayName}.`,
					}],
				};
			}
		);

		const server = createSdkMcpServer({
			name: 'azure-devops',
			version: '1.0.0',
			tools: [
				getWorkItemTool,
				queryWorkItemsTool,
				getCommentsTool,
				updateWorkItemTool,
				createWorkItemTool,
				addCommentTool,
			],
		});

		return { 'azure-devops': server };
	}
}

registerClaudeMcpServerContributor(AzureDevOpsMcpServerContributor);
