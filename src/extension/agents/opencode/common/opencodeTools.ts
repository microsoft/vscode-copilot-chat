/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode tool names that correspond to the tools available in the OpenCode server
 */
export enum OpenCodeToolNames {
	// File operations
	ReadFile = 'read_file',
	WriteFile = 'write_file',
	EditFile = 'edit_file',
	CreateFile = 'create_file',
	DeleteFile = 'delete_file',
	
	// Directory operations
	ListFiles = 'list_files',
	CreateDirectory = 'create_directory',
	DeleteDirectory = 'delete_directory',
	
	// Search operations
	FindFiles = 'find_files',
	FindText = 'find_text',
	FindSymbols = 'find_symbols',
	GrepSearch = 'grep_search',
	
	// Shell operations
	Shell = 'shell',
	RunCommand = 'run_command',
	
	// Code analysis
	AnalyzeCode = 'analyze_code',
	GetSymbols = 'get_symbols',
	GetReferences = 'get_references',
	
	// Web operations
	WebSearch = 'web_search',
	HttpRequest = 'http_request',
	
	// Git operations
	GitStatus = 'git_status',
	GitDiff = 'git_diff',
	GitLog = 'git_log',
	GitCommit = 'git_commit',
	
	// System information
	SystemInfo = 'system_info',
	Environment = 'environment'
}

/**
 * Interface for OpenCode tool invocation
 */
export interface OpenCodeToolInvocation {
	readonly id: string;
	readonly name: OpenCodeToolNames;
	readonly input: Record<string, any>;
	readonly timestamp: Date;
}

/**
 * Interface for OpenCode tool result
 */
export interface OpenCodeToolResult {
	readonly id: string;
	readonly toolInvocationId: string;
	readonly success: boolean;
	readonly result?: any;
	readonly error?: string;
	readonly timestamp: Date;
	readonly duration?: number;
}

/**
 * Tool permission levels for security and user control
 */
export enum OpenCodeToolPermission {
	// Safe operations that don't modify the system
	ReadOnly = 'readonly',
	
	// Operations that modify files but are generally safe
	FileWrite = 'filewrite',
	
	// Operations that can execute code or commands
	Execute = 'execute',
	
	// Operations that can make network requests
	Network = 'network',
	
	// Operations that require explicit user confirmation
	Dangerous = 'dangerous'
}

/**
 * Tool configuration and metadata
 */
export interface OpenCodeToolConfig {
	readonly name: OpenCodeToolNames;
	readonly permission: OpenCodeToolPermission;
	readonly description: string;
	readonly inputSchema?: Record<string, any>;
	readonly outputSchema?: Record<string, any>;
	readonly autoApprove?: boolean;
	readonly confirmationMessage?: string;
}

/**
 * Tool registry containing configurations for all OpenCode tools
 */
export const OpenCodeToolRegistry: Record<OpenCodeToolNames, OpenCodeToolConfig> = {
	[OpenCodeToolNames.ReadFile]: {
		name: OpenCodeToolNames.ReadFile,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Read the contents of a file',
		autoApprove: true
	},
	
	[OpenCodeToolNames.WriteFile]: {
		name: OpenCodeToolNames.WriteFile,
		permission: OpenCodeToolPermission.FileWrite,
		description: 'Write content to a file',
		confirmationMessage: 'Allow writing to file?'
	},
	
	[OpenCodeToolNames.EditFile]: {
		name: OpenCodeToolNames.EditFile,
		permission: OpenCodeToolPermission.FileWrite,
		description: 'Edit specific parts of a file',
		confirmationMessage: 'Allow editing file?'
	},
	
	[OpenCodeToolNames.CreateFile]: {
		name: OpenCodeToolNames.CreateFile,
		permission: OpenCodeToolPermission.FileWrite,
		description: 'Create a new file',
		confirmationMessage: 'Allow creating new file?'
	},
	
	[OpenCodeToolNames.DeleteFile]: {
		name: OpenCodeToolNames.DeleteFile,
		permission: OpenCodeToolPermission.Dangerous,
		description: 'Delete a file',
		confirmationMessage: 'Allow deleting file? This action cannot be undone.'
	},
	
	[OpenCodeToolNames.ListFiles]: {
		name: OpenCodeToolNames.ListFiles,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'List files in a directory',
		autoApprove: true
	},
	
	[OpenCodeToolNames.CreateDirectory]: {
		name: OpenCodeToolNames.CreateDirectory,
		permission: OpenCodeToolPermission.FileWrite,
		description: 'Create a new directory',
		confirmationMessage: 'Allow creating directory?'
	},
	
	[OpenCodeToolNames.DeleteDirectory]: {
		name: OpenCodeToolNames.DeleteDirectory,
		permission: OpenCodeToolPermission.Dangerous,
		description: 'Delete a directory and its contents',
		confirmationMessage: 'Allow deleting directory? This will remove all contents and cannot be undone.'
	},
	
	[OpenCodeToolNames.FindFiles]: {
		name: OpenCodeToolNames.FindFiles,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Find files by name or pattern',
		autoApprove: true
	},
	
	[OpenCodeToolNames.FindText]: {
		name: OpenCodeToolNames.FindText,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Search for text within files',
		autoApprove: true
	},
	
	[OpenCodeToolNames.FindSymbols]: {
		name: OpenCodeToolNames.FindSymbols,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Find code symbols (functions, classes, etc.)',
		autoApprove: true
	},
	
	[OpenCodeToolNames.GrepSearch]: {
		name: OpenCodeToolNames.GrepSearch,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Search for patterns using grep',
		autoApprove: true
	},
	
	[OpenCodeToolNames.Shell]: {
		name: OpenCodeToolNames.Shell,
		permission: OpenCodeToolPermission.Execute,
		description: 'Execute shell commands',
		confirmationMessage: 'Allow executing shell command?'
	},
	
	[OpenCodeToolNames.RunCommand]: {
		name: OpenCodeToolNames.RunCommand,
		permission: OpenCodeToolPermission.Execute,
		description: 'Run a specific command',
		confirmationMessage: 'Allow running command?'
	},
	
	[OpenCodeToolNames.AnalyzeCode]: {
		name: OpenCodeToolNames.AnalyzeCode,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Analyze code structure and patterns',
		autoApprove: true
	},
	
	[OpenCodeToolNames.GetSymbols]: {
		name: OpenCodeToolNames.GetSymbols,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Get symbols from code files',
		autoApprove: true
	},
	
	[OpenCodeToolNames.GetReferences]: {
		name: OpenCodeToolNames.GetReferences,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Find references to code symbols',
		autoApprove: true
	},
	
	[OpenCodeToolNames.WebSearch]: {
		name: OpenCodeToolNames.WebSearch,
		permission: OpenCodeToolPermission.Network,
		description: 'Search the web for information',
		confirmationMessage: 'Allow web search?'
	},
	
	[OpenCodeToolNames.HttpRequest]: {
		name: OpenCodeToolNames.HttpRequest,
		permission: OpenCodeToolPermission.Network,
		description: 'Make HTTP requests',
		confirmationMessage: 'Allow making HTTP request?'
	},
	
	[OpenCodeToolNames.GitStatus]: {
		name: OpenCodeToolNames.GitStatus,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Get Git repository status',
		autoApprove: true
	},
	
	[OpenCodeToolNames.GitDiff]: {
		name: OpenCodeToolNames.GitDiff,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Show Git differences',
		autoApprove: true
	},
	
	[OpenCodeToolNames.GitLog]: {
		name: OpenCodeToolNames.GitLog,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Show Git commit history',
		autoApprove: true
	},
	
	[OpenCodeToolNames.GitCommit]: {
		name: OpenCodeToolNames.GitCommit,
		permission: OpenCodeToolPermission.Execute,
		description: 'Commit changes to Git',
		confirmationMessage: 'Allow committing changes to Git?'
	},
	
	[OpenCodeToolNames.SystemInfo]: {
		name: OpenCodeToolNames.SystemInfo,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Get system information',
		autoApprove: true
	},
	
	[OpenCodeToolNames.Environment]: {
		name: OpenCodeToolNames.Environment,
		permission: OpenCodeToolPermission.ReadOnly,
		description: 'Get environment variables',
		autoApprove: true
	}
};

/**
 * Helper function to get tool configuration
 */
export function getToolConfig(toolName: OpenCodeToolNames): OpenCodeToolConfig {
	return OpenCodeToolRegistry[toolName];
}

/**
 * Helper function to check if a tool requires user permission
 */
export function requiresPermission(toolName: OpenCodeToolNames): boolean {
	const config = getToolConfig(toolName);
	return !config.autoApprove;
}

/**
 * Helper function to check if a tool is dangerous
 */
export function isDangerousTool(toolName: OpenCodeToolNames): boolean {
	const config = getToolConfig(toolName);
	return config.permission === OpenCodeToolPermission.Dangerous;
}