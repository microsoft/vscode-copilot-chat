/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// Edit tool names we're tracking
const EDIT_TOOL_NAMES = ['insert_edit_into_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'apply_patch'];

// Tool names that indicate a continuation/retry attempt
const CONTINUATION_TOOL_NAMES = ['read_file'];

interface EditLogEntry {
	timestamp: string;
	requestId: string;
	success: boolean;
	input: string;
	healed?: string;
}

interface ToolCall {
	toolName: string;
	requestId: string;
	timestamp?: string;
}

interface EditOperation {
	toolName: string;
	requestId: string;
	timestamp: string;
	success: boolean;
	wasHealed: boolean;
	originalInput: string;
	healedInput?: string;
	turnIndex: number;
	isRetry: boolean;
	retrySucceeded?: boolean;
}

interface ConversationAnalysis {
	conversationPath: string;
	edits: EditOperation[];
	totalEdits: number;
	successfulEdits: number;
	failedEdits: number;
	healedEdits: number;
	successfulEditsWithRetries: number;
	totalUniqueEdits: number;
	modelName?: string;
}

interface RunAnalysis {
	runId: string;
	conversations: ConversationAnalysis[];
	totalEdits: number;
	successRate: number;
	healingRate: number;
	successRateWithRetries: number;
	totalUniqueEdits: number;
	modelName?: string;
}

async function listRuns(amlOutPath: string): Promise<string[]> {
	const entries = await fs.readdir(amlOutPath, { withFileTypes: true });
	const runs = entries
		.filter(e => e.isDirectory() && e.name.startsWith('msbench-'))
		.map(e => e.name.replace('msbench-', ''))
		.sort((a, b) => parseInt(b) - parseInt(a)); // Sort descending (newest first)
	return runs;
}

async function promptUserForRun(runs: string[]): Promise<string> {
	console.log('\nAvailable test runs (newest first):');
	runs.slice(0, 10).forEach((run, i) => {
		console.log(`  ${i + 1}. ${run}`);
	});
	if (runs.length > 10) {
		console.log(`  ... and ${runs.length - 10} more`);
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});

	return new Promise((resolve) => {
		rl.question('\nEnter run number (or press Enter for the most recent): ', (answer) => {
			rl.close();
			const choice = answer.trim();
			if (choice === '') {
				resolve(runs[0]);
			} else {
				const index = parseInt(choice) - 1;
				if (index >= 0 && index < runs.length) {
					resolve(runs[index]);
				} else {
					console.log('Invalid selection, using most recent run.');
					resolve(runs[0]);
				}
			}
		});
	});
}

async function parseEditLogs(simLogPath: string): Promise<EditLogEntry[]> {
	const editLogs: EditLogEntry[] = [];

	try {
		const content = await fs.readFile(simLogPath, 'utf-8');
		const lines = content.split('\n');

		for (const line of lines) {
			const editToolMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[edit-tool:([^\]]+)\] (.+)$/);
			if (editToolMatch) {
				const [, timestamp, _requestId, jsonData] = editToolMatch;
				try {
					const data = JSON.parse(jsonData);
					// The data can be either an object or an array with one object
					const entry = Array.isArray(data) ? data : [data];
					if (entry && entry.length && entry[0]) {
						editLogs.push({
							timestamp,
							requestId: entry[0].requestId ?? _requestId,
							success: entry.every(e => e.success),
							input: entry[0].input,
							healed: entry[0].healed
						});
					}
				} catch (e) {
					console.warn(`Failed to parse edit log JSON: ${jsonData.substring(0, 100)}...`);
				}
			}
		}
	} catch (error) {
		console.warn(`Could not read sim-log file: ${simLogPath}`);
	}

	return editLogs;
}

async function parseToolCalls(simRequestsPath: string): Promise<ToolCall[]> {
	const toolCalls: ToolCall[] = [];

	try {
		const content = await fs.readFile(simRequestsPath, 'utf-8');
		const requests = JSON.parse(content);

		// The file contains an array of request objects
		if (Array.isArray(requests)) {
			for (const request of requests) {
				const requestId = request.response?.requestId;
				const copilotFunctionCalls = request.response?.copilotFunctionCalls || [];

				for (const call of copilotFunctionCalls) {
					// Track ALL tool calls (edit tools + read_file for retry detection)
					if (call.name) {
						toolCalls.push({
							toolName: call.name,
							requestId: requestId || 'unknown'
						});
					}
				}
			}
		}
	} catch (error) {
		console.warn(`Could not read sim-requests file: ${simRequestsPath}`);
	}

	return toolCalls;
}

async function analyzeConversation(conversationPath: string): Promise<ConversationAnalysis> {
	const simLogPath = path.join(conversationPath, 'sim-log-0.txt');
	const simRequestsPath = path.join(conversationPath, 'sim-requests-0.txt');

	const editLogs = await parseEditLogs(simLogPath);
	const toolCalls = await parseToolCalls(simRequestsPath);

	// Extract model name from first request
	let modelName: string | undefined;
	try {
		const content = await fs.readFile(simRequestsPath, 'utf-8');
		const requests = JSON.parse(content);
		if (Array.isArray(requests) && requests.length > 0) {
			modelName = requests[0]?.model || requests[0]?.response?.model;
		}
	} catch (e) {
		// Model name is optional
	}

	const edits: EditOperation[] = [];
	let turnIndex = 0;

	// Match edit tool calls to edit logs sequentially
	let editLogIndex = 0;
	for (let i = 0; i < toolCalls.length; i++) {
		const toolCall = toolCalls[i];
		if (!EDIT_TOOL_NAMES.includes(toolCall.toolName)) {
			continue;
		}

		const logEntry = editLogs[editLogIndex++];
		if (!logEntry) {
			break;
		}

		// Detect retry pattern: failed edit -> continuation tool -> another edit
		let isRetry = false;
		let retrySucceeded: boolean | undefined;

		if (!logEntry.success) {
			// Look ahead to see if there's a continuation tool followed by another edit
			let j = i + 1;
			let foundContinuationTool = false;
			while (j < toolCalls.length && j < i + 10) { // Look ahead max 10 calls
				if (CONTINUATION_TOOL_NAMES.includes(toolCalls[j].toolName)) {
					foundContinuationTool = true;
				} else if (foundContinuationTool && EDIT_TOOL_NAMES.includes(toolCalls[j].toolName)) {
					// Found a retry!
					isRetry = true;
					const retryLogEntry = editLogs[editLogIndex];
					if (retryLogEntry) {
						retrySucceeded = retryLogEntry.success;
					}
					break;
				} else if (EDIT_TOOL_NAMES.includes(toolCalls[j].toolName)) {
					// Another edit without continuation tool in between, not a retry
					break;
				}
				j++;
			}
		}

		edits.push({
			toolName: toolCall.toolName,
			requestId: toolCall.requestId,
			timestamp: logEntry.timestamp,
			success: logEntry.success,
			wasHealed: !!logEntry.healed && logEntry.healed !== logEntry.input,
			originalInput: logEntry.input,
			healedInput: logEntry.healed,
			turnIndex: turnIndex++,
			isRetry,
			retrySucceeded
		});
	}

	const successfulEdits = edits.filter(e => e.success).length;
	const healedEdits = edits.filter(e => e.wasHealed).length;

	// Calculate success rate accounting for retries (final outcome only)
	const editsWithRetries = edits.filter(e => !e.success && e.isRetry);
	const retriedSuccesses = editsWithRetries.filter(e => e.retrySucceeded).length;
	const successfulEditsWithRetries = successfulEdits + retriedSuccesses;
	const totalUniqueEdits = edits.length - editsWithRetries.length + editsWithRetries.filter(e => e.retrySucceeded !== undefined).length;

	return {
		conversationPath,
		edits,
		totalEdits: edits.length,
		successfulEdits,
		failedEdits: edits.length - successfulEdits,
		healedEdits,
		successfulEditsWithRetries,
		totalUniqueEdits,
		modelName
	};
}

async function analyzeRun(runId: string, basePath: string): Promise<RunAnalysis> {
	const runPath = path.join(basePath, `msbench-${runId}`, 'simulate', 'simulator_output_dir', 'simulator_output');

	const conversations: ConversationAnalysis[] = [];

	try {
		const entries = await fs.readdir(runPath, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory()) {
				const conversationPath = path.join(runPath, entry.name);
				const analysis = await analyzeConversation(conversationPath);
				if (analysis.totalEdits > 0) {
					conversations.push(analysis);
				}
			}
		}
	} catch (error) {
		console.error(`Error reading run directory: ${error}`);
	}

	const totalEdits = conversations.reduce((sum, c) => sum + c.totalEdits, 0);
	const totalSuccessful = conversations.reduce((sum, c) => sum + c.successfulEdits, 0);
	const totalHealed = conversations.reduce((sum, c) => sum + c.healedEdits, 0);
	const totalSuccessfulWithRetries = conversations.reduce((sum, c) => sum + c.successfulEditsWithRetries, 0);
	const totalUniqueEdits = conversations.reduce((sum, c) => sum + c.totalUniqueEdits, 0);

	// Get model name from first conversation that has one
	const modelName = conversations.find(c => c.modelName)?.modelName;

	return {
		runId,
		conversations,
		totalEdits,
		successRate: totalEdits > 0 ? totalSuccessful / totalEdits : 0,
		healingRate: totalEdits > 0 ? totalHealed / totalEdits : 0,
		successRateWithRetries: totalUniqueEdits > 0 ? totalSuccessfulWithRetries / totalUniqueEdits : 0,
		totalUniqueEdits,
		modelName
	};
}

function generateHTML(analysis: RunAnalysis, outputPath: string, showHealing: boolean = true, includeRetries: boolean = false): string {
	// Build Sankey data
	const sankeyNodes: string[] = [];
	const sankeyLinks: Array<{ source: number; target: number; value: number }> = [];

	const nodeMap = new Map<string, number>();

	const getNodeIndex = (name: string): number => {
		if (!nodeMap.has(name)) {
			nodeMap.set(name, sankeyNodes.length);
			sankeyNodes.push(name);
		}
		return nodeMap.get(name)!;
	};

	// Track flows
	const flows = new Map<string, number>();

	for (const conv of analysis.conversations) {
		for (const edit of conv.edits) {
			const toolNode = edit.toolName;

			// Check if this is a failed edit with a retry
			if (includeRetries && !edit.success && edit.isRetry && edit.retrySucceeded !== undefined) {
				// Show full retry flow: Tool -> Failed -> read_file -> Retry Edit -> Final Result
				if (showHealing && edit.wasHealed) {
					const healedNode = 'Healed';
					const failedNode = 'Failed (will retry)';
					const readFileNode = 'read_file';
					const retryEditNode = `${toolNode} (retry)`;
					const finalResult = edit.retrySucceeded ? 'Success' : 'Failed';

					flows.set(`${toolNode}->${healedNode}`, (flows.get(`${toolNode}->${healedNode}`) || 0) + 1);
					flows.set(`${healedNode}->${failedNode}`, (flows.get(`${healedNode}->${failedNode}`) || 0) + 1);
					flows.set(`${failedNode}->${readFileNode}`, (flows.get(`${failedNode}->${readFileNode}`) || 0) + 1);
					flows.set(`${readFileNode}->${retryEditNode}`, (flows.get(`${readFileNode}->${retryEditNode}`) || 0) + 1);
					flows.set(`${retryEditNode}->${finalResult}`, (flows.get(`${retryEditNode}->${finalResult}`) || 0) + 1);
				} else {
					const failedNode = 'Failed (will retry)';
					const readFileNode = 'read_file';
					const retryEditNode = `${toolNode} (retry)`;
					const finalResult = edit.retrySucceeded ? 'Success' : 'Failed';

					flows.set(`${toolNode}->${failedNode}`, (flows.get(`${toolNode}->${failedNode}`) || 0) + 1);
					flows.set(`${failedNode}->${readFileNode}`, (flows.get(`${failedNode}->${readFileNode}`) || 0) + 1);
					flows.set(`${readFileNode}->${retryEditNode}`, (flows.get(`${readFileNode}->${retryEditNode}`) || 0) + 1);
					flows.set(`${retryEditNode}->${finalResult}`, (flows.get(`${retryEditNode}->${finalResult}`) || 0) + 1);
				}
				continue;
			}

			if (showHealing && edit.wasHealed) {
				// Tool -> Healed -> Success/Fail
				const healedNode = 'Healed';
				const resultNode = edit.success ? 'Success (healed)' : 'Failed (healed)';

				const flow1Key = `${toolNode}->${healedNode}`;
				const flow2Key = `${healedNode}->${resultNode}`;

				flows.set(flow1Key, (flows.get(flow1Key) || 0) + 1);
				flows.set(flow2Key, (flows.get(flow2Key) || 0) + 1);
			} else {
				// Tool -> Success/Fail
				const resultNode = edit.success ? 'Success' : 'Failed';
				const flowKey = `${toolNode}->${resultNode}`;
				flows.set(flowKey, (flows.get(flowKey) || 0) + 1);
			}
		}
	}

	// Convert flows to Sankey links
	for (const [flowKey, count] of flows.entries()) {
		const [source, target] = flowKey.split('->');
		sankeyLinks.push({
			source: getNodeIndex(source),
			target: getNodeIndex(target),
			value: count
		});
	}

	// Build table rows
	const tableRows = analysis.conversations.flatMap(conv =>
		conv.edits.map(edit => ({
			conversation: path.basename(conv.conversationPath),
			toolName: edit.toolName,
			timestamp: edit.timestamp,
			success: edit.success,
			wasHealed: edit.wasHealed,
			turnIndex: edit.turnIndex,
			isRetry: edit.isRetry,
			retrySucceeded: edit.retrySucceeded
		}))
	);

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Run ${analysis.runId}${analysis.modelName ? ' - ' + analysis.modelName : ''}</title>
	<script src="https://unpkg.com/d3@7/dist/d3.min.js"></script>
	<script src="https://unpkg.com/d3-sankey@0.12.3/dist/d3-sankey.min.js"></script>
	<style>
		* {
			box-sizing: border-box;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
			margin: 0;
			padding: 20px;
			background: #f5f5f5;
			color: #333;
		}

		.container {
			max-width: 1400px;
			margin: 0 auto;
			background: white;
			padding: 30px;
			border-radius: 8px;
			box-shadow: 0 2px 8px rgba(0,0,0,0.1);
		}

		h1 {
			margin: 0 0 10px 0;
			color: #1a1a1a;
		}

		.stats {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
			gap: 15px;
			margin: 20px 0;
		}

		.stat-card {
			background: #f8f9fa;
			padding: 15px;
			border-radius: 6px;
			border-left: 4px solid #0969da;
		}

		.stat-label {
			font-size: 12px;
			text-transform: uppercase;
			color: #666;
			margin-bottom: 5px;
		}

		.stat-value {
			font-size: 24px;
			font-weight: 600;
			color: #1a1a1a;
		}

		.controls {
			margin: 20px 0;
			padding: 15px;
			background: #f8f9fa;
			border-radius: 6px;
		}

		.controls label {
			display: inline-flex;
			align-items: center;
			cursor: pointer;
			font-size: 14px;
		}

		.controls input[type="checkbox"] {
			margin-right: 8px;
			width: 18px;
			height: 18px;
			cursor: pointer;
		}

		#sankey-diagram {
			margin: 30px 0;
			overflow-x: auto;
		}

		.table-container {
			margin-top: 30px;
			overflow-x: auto;
		}

		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 14px;
		}

		thead {
			background: #f8f9fa;
		}

		th {
			text-align: left;
			padding: 12px;
			font-weight: 600;
			color: #1a1a1a;
			border-bottom: 2px solid #dee2e6;
		}

		td {
			padding: 10px 12px;
			border-bottom: 1px solid #dee2e6;
		}

		tbody tr:hover {
			background: #f8f9fa;
		}

		.badge {
			display: inline-block;
			padding: 3px 8px;
			border-radius: 12px;
			font-size: 12px;
			font-weight: 500;
		}

		.badge-success {
			background: #d1f4e0;
			color: #0f6d31;
		}

		.badge-failed {
			background: #ffd8d8;
			color: #d1242f;
		}

		.badge-healed {
			background: #fff3cd;
			color: #856404;
		}

		.sankey-node rect {
			cursor: pointer;
			fill-opacity: 0.9;
		}

		.sankey-node rect:hover {
			fill-opacity: 1;
		}

		.sankey-link {
			fill: none;
			stroke-opacity: 0.3;
		}

		.sankey-link:hover {
			stroke-opacity: 0.5;
		}

		.sankey-node text {
			pointer-events: none;
			font-size: 12px;
			fill: #1a1a1a;
		}
	</style>
</head>
<body>
	<div class="container">
		<h1>🔧 Run ${analysis.runId}${analysis.modelName ? ' - ' + analysis.modelName : ''}</h1>
		<p style="color: #666; margin: 5px 0 0 0;">Analysis of edit tool operations and success rates</p>

		<div class="stats">
			<div class="stat-card">
				<div class="stat-label">Total Edits</div>
				<div class="stat-value">${analysis.totalEdits}</div>
			</div>
			<div class="stat-card" style="border-left-color: #2da44e;">
				<div class="stat-label">Success Rate</div>
				<div class="stat-value" id="success-rate-value">${(analysis.successRate * 100).toFixed(1)}%</div>
			</div>
			<div class="stat-card" style="border-left-color: #fb8500;">
				<div class="stat-label">Healing Rate</div>
				<div class="stat-value">${(analysis.healingRate * 100).toFixed(1)}%</div>
			</div>
			<div class="stat-card" style="border-left-color: #8250df;">
				<div class="stat-label">Conversations</div>
				<div class="stat-value">${analysis.conversations.length}</div>
			</div>
		</div>

		<div class="controls">
			<label>
				<input type="checkbox" id="showHealing" ${showHealing ? 'checked' : ''}>
				Show healing as separate step in diagram
			</label>
			<label style="margin-left: 20px;">
				<input type="checkbox" id="includeRetries" ${includeRetries ? 'checked' : ''}>
				Include retries (show re-evaluate → retry flows)
			</label>
		</div>

		<div id="sankey-diagram"></div>

		<h2 style="margin-top: 40px;">Edit Operations</h2>
		<div class="table-container">
			<table>
				<thead>
					<tr>
						<th>Conversation</th>
						<th>Tool</th>
						<th>Turn</th>
						<th>Timestamp</th>
						<th>Status</th>
						<th>Healed</th>
						<th>Retry</th>
					</tr>
				</thead>
				<tbody>
					${tableRows.map(row => `
						<tr>
							<td>${row.conversation}</td>
							<td><code style="background: #f6f8fa; padding: 2px 6px; border-radius: 3px; font-size: 12px;">${row.toolName}</code></td>
							<td>${row.turnIndex}</td>
							<td style="color: #666; font-size: 12px;">${row.timestamp}</td>
							<td><span class="badge ${row.success ? 'badge-success' : 'badge-failed'}">${row.success ? '✓ Success' : '✗ Failed'}</span></td>
							<td>${row.wasHealed ? '<span class="badge badge-healed">Healed</span>' : '-'}</td>
							<td>${row.isRetry ? (row.retrySucceeded === true ? '<span class="badge badge-success">✓ Retry Success</span>' : row.retrySucceeded === false ? '<span class="badge badge-failed">✗ Retry Failed</span>' : '<span class="badge" style="background: #e3e3e3; color: #666;">Retry Pending</span>') : '-'}</td>
						</tr>
					`).join('')}
				</tbody>
			</table>
		</div>
	</div>

	<script>
		const sankeyData = {
			nodes: ${JSON.stringify(sankeyNodes.map(name => ({ name })))},
			links: ${JSON.stringify(sankeyLinks)}
		};
		const analysisData = {
			successRate: ${analysis.successRate},
			successRateWithRetries: ${analysis.successRateWithRetries},
			totalEdits: ${analysis.totalEdits},
			totalUniqueEdits: ${analysis.totalUniqueEdits}
		};

		function drawSankey(showHealing, includeRetries) {
			// Clear previous diagram
			d3.select('#sankey-diagram').html('');

			// Rebuild data based on showHealing flag
			const allEdits = ${JSON.stringify(tableRows)};
			const nodes = [];
			const links = [];
			const nodeMap = new Map();

			const getNodeIndex = (name) => {
				if (!nodeMap.has(name)) {
					nodeMap.set(name, nodes.length);
					nodes.push({ name });
				}
				return nodeMap.get(name);
			};

			const flows = new Map();

			for (const edit of allEdits) {
				const toolNode = edit.toolName;

				// Check if this is a failed edit with a retry
				if (includeRetries && !edit.success && edit.isRetry && edit.retrySucceeded !== undefined) {
					// Show full retry flow: Tool -> Failed -> read_file -> Retry Edit -> Final Result
					if (showHealing && edit.wasHealed) {
						const healedNode = 'Healed';
						const failedNode = 'Failed (will retry)';
						const readFileNode = 'read_file';
						const retryEditNode = toolNode + ' (retry)';
						const finalResult = edit.retrySucceeded ? 'Success' : 'Failed';

						flows.set(toolNode + '->' + healedNode, (flows.get(toolNode + '->' + healedNode) || 0) + 1);
						flows.set(healedNode + '->' + failedNode, (flows.get(healedNode + '->' + failedNode) || 0) + 1);
						flows.set(failedNode + '->' + readFileNode, (flows.get(failedNode + '->' + readFileNode) || 0) + 1);
						flows.set(readFileNode + '->' + retryEditNode, (flows.get(readFileNode + '->' + retryEditNode) || 0) + 1);
						flows.set(retryEditNode + '->' + finalResult, (flows.get(retryEditNode + '->' + finalResult) || 0) + 1);
					} else {
						const failedNode = 'Failed (will retry)';
						const readFileNode = 'read_file';
						const retryEditNode = toolNode + ' (retry)';
						const finalResult = edit.retrySucceeded ? 'Success' : 'Failed';

						flows.set(toolNode + '->' + failedNode, (flows.get(toolNode + '->' + failedNode) || 0) + 1);
						flows.set(failedNode + '->' + readFileNode, (flows.get(failedNode + '->' + readFileNode) || 0) + 1);
						flows.set(readFileNode + '->' + retryEditNode, (flows.get(readFileNode + '->' + retryEditNode) || 0) + 1);
						flows.set(retryEditNode + '->' + finalResult, (flows.get(retryEditNode + '->' + finalResult) || 0) + 1);
					}
					continue;
				}

				if (showHealing && edit.wasHealed) {
					const healedNode = 'Healed';
					const resultNode = edit.success ? 'Success (healed)' : 'Failed (healed)';

					const flow1Key = toolNode + '->' + healedNode;
					const flow2Key = healedNode + '->' + resultNode;

					flows.set(flow1Key, (flows.get(flow1Key) || 0) + 1);
					flows.set(flow2Key, (flows.get(flow2Key) || 0) + 1);
				} else {
					const resultNode = edit.success ? 'Success' : 'Failed';
					const flowKey = toolNode + '->' + resultNode;
					flows.set(flowKey, (flows.get(flowKey) || 0) + 1);
				}
			}

			for (const [flowKey, count] of flows.entries()) {
				const [source, target] = flowKey.split('->');
				links.push({
					source: getNodeIndex(source),
					target: getNodeIndex(target),
					value: count
				});
			}

			const width = Math.max(800, document.getElementById('sankey-diagram').offsetWidth);
			const height = 500;

			const svg = d3.select('#sankey-diagram')
				.append('svg')
				.attr('width', width)
				.attr('height', height);

			const sankey = d3.sankey()
				.nodeWidth(15)
				.nodePadding(10)
				.extent([[1, 1], [width - 1, height - 5]]);

			const graph = sankey({
				nodes: nodes.map(d => Object.assign({}, d)),
				links: links.map(d => Object.assign({}, d))
			});

			const colorScale = d3.scaleOrdinal()
				.domain(['insert_edit_into_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'apply_patch', 'Healed', 'read_file', 'Failed (will retry)', 'Success', 'Failed', 'Success (healed)', 'Failed (healed)'])
				.range(['#0969da', '#1f883d', '#8250df', '#fb8500', '#fbbf24', '#a855f7', '#ff9800', '#2da44e', '#d1242f', '#22c55e', '#ef4444']);

			// Links
			svg.append('g')
				.attr('class', 'links')
				.selectAll('path')
				.data(graph.links)
				.enter()
				.append('path')
				.attr('class', 'sankey-link')
				.attr('d', d3.sankeyLinkHorizontal())
				.attr('stroke', d => colorScale(d.source.name))
				.attr('stroke-width', d => Math.max(1, d.width));

			// Nodes
			const node = svg.append('g')
				.attr('class', 'nodes')
				.selectAll('g')
				.data(graph.nodes)
				.enter()
				.append('g')
				.attr('class', 'sankey-node');

			node.append('rect')
				.attr('x', d => d.x0)
				.attr('y', d => d.y0)
				.attr('height', d => d.y1 - d.y0)
				.attr('width', d => d.x1 - d.x0)
				.attr('fill', d => colorScale(d.name))
				.append('title')
				.text(d => d.name + '\\n' + d.value + ' edits');

			node.append('text')
				.attr('x', d => d.x0 < width / 2 ? d.x1 + 6 : d.x0 - 6)
				.attr('y', d => (d.y1 + d.y0) / 2)
				.attr('dy', '0.35em')
				.attr('text-anchor', d => d.x0 < width / 2 ? 'start' : 'end')
				.text(d => d.name + ' (' + d.value + ')');
		}

		// Initial draw
		drawSankey(${showHealing}, ${includeRetries});

		// Update success rate display
		function updateSuccessRate(includeRetries) {
			const rate = includeRetries ? analysisData.successRateWithRetries : analysisData.successRate;
			document.getElementById('success-rate-value').textContent = (rate * 100).toFixed(1) + '%';
		}

		// Handle checkbox change
		document.getElementById('showHealing').addEventListener('change', (e) => {
			const includeRetries = document.getElementById('includeRetries').checked;
			drawSankey(e.target.checked, includeRetries);
		});

		document.getElementById('includeRetries').addEventListener('change', (e) => {
			const showHealing = document.getElementById('showHealing').checked;
			drawSankey(showHealing, e.target.checked);
			updateSuccessRate(e.target.checked);
		});

		// Redraw on window resize
		let resizeTimer;
		window.addEventListener('resize', () => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				const showHealing = document.getElementById('showHealing').checked;
				const includeRetries = document.getElementById('includeRetries').checked;
				drawSankey(showHealing, includeRetries);
			}, 250);
		});
	</script>
</body>
</html>`;

	return html;
}

async function main() {
	const args = process.argv.slice(2);
	const runIdArg = args.find(arg => arg.startsWith('--runId='));

	const basePath = path.join(__dirname, '..', 'test', 'aml', 'out');

	let runId: string;

	if (runIdArg) {
		runId = runIdArg.split('=')[1];
		console.log(`Using run ID: ${runId}`);
	} else {
		const runs = await listRuns(basePath);
		if (runs.length === 0) {
			console.error('No test runs found in', basePath);
			process.exit(1);
		}
		runId = await promptUserForRun(runs);
		console.log(`Selected run: ${runId}`);
	}

	console.log('\nAnalyzing run...');
	const analysis = await analyzeRun(runId, basePath);

	console.log(`\nFound ${analysis.conversations.length} conversations with edits`);
	console.log(`Total edits: ${analysis.totalEdits}`);
	console.log(`Success rate: ${(analysis.successRate * 100).toFixed(1)}%`);
	console.log(`Healing rate: ${(analysis.healingRate * 100).toFixed(1)}%`);

	const outputPath = path.join(basePath, `msbench-${runId}`, 'simulate', 'edit-analysis.html');
	const html = generateHTML(analysis, outputPath, true);

	await fs.writeFile(outputPath, html, 'utf-8');
	console.log(`\n✓ Analysis complete! Generated: ${outputPath}`);
}

main().catch(console.error);
