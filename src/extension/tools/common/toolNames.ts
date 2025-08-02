/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cloneAndChange } from '../../../util/vs/base/common/objects';

export const enum ToolName {
	ApplyPatch = 'apply_patch',
	Codebase = 'semantic_search',
	VSCodeAPI = 'get_vscode_api',
	TestFailure = 'test_failure',
	RunTests = 'run_tests',
	FindFiles = 'file_search',
	FindTextInFiles = 'grep_search',
	ReadFile = 'read_file',
	ListDirectory = 'list_dir',
	GetErrors = 'get_errors',
	GetScmChanges = 'get_changed_files',
	UpdateUserPreferences = 'update_user_preferences',
	ReadProjectStructure = 'read_project_structure',
	TerminalSelection = 'get_terminal_selection',
	TerminalLastCommand = 'get_terminal_last_command',
	CreateNewWorkspace = 'create_new_workspace',
	CreateNewJupyterNotebook = 'create_new_jupyter_notebook',
	SearchWorkspaceSymbols = 'search_workspace_symbols',
	Usages = 'list_code_usages',
	EditFile = 'insert_edit_into_file',
	CreateFile = 'create_file',
	ReplaceString = 'replace_string_in_file',
	EditNotebook = 'edit_notebook_file',
	RunNotebookCell = 'run_notebook_cell',
	GetNotebookSummary = 'copilot_getNotebookSummary',
	ReadCellOutput = 'read_notebook_cell_output',
	InstallExtension = 'install_extension',
	Think = 'think',
	FetchWebPage = 'fetch_webpage',
	FindTestFiles = 'test_search',
	GetProjectSetupInfo = 'get_project_setup_info',
	SearchViewResults = 'get_search_view_results',
	DocInfo = 'get_doc_info',
	GithubRepo = 'github_repo',
	SimpleBrowser = 'open_simple_browser',
	CreateDirectory = 'create_directory',
	RunVscodeCmd = 'run_vscode_command',
	GetTaskOutput = 'get_task_output',

	CoreRunInTerminal = 'run_in_terminal',
	CoreGetTerminalOutput = 'get_terminal_output',
	CoreCreateAndRunTask = 'create_and_run_task',
	CoreRunTask = 'run_task',
	CoreGetTaskOutput = 'get_task_output',
	CoreRunTest = 'runTests',
	CoreTodoListTool = 'manage_todo_list',
}

// When updating this, also update contributedToolNameToToolNames
export const enum ContributedToolName {
	ApplyPatch = 'copilot_applyPatch',
	Codebase = 'copilot_searchCodebase',
	SearchWorkspaceSymbols = 'copilot_searchWorkspaceSymbols',
	Usages = 'copilot_listCodeUsages',
	UpdateUserPreferences = 'copilot_updateUserPreferences',
	VSCodeAPI = 'copilot_getVSCodeAPI',
	TestFailure = 'copilot_testFailure',
	/** @deprecated moving to core soon */
	RunTests = 'copilot_runTests1',
	FindFiles = 'copilot_findFiles',
	FindTextInFiles = 'copilot_findTextInFiles',
	ReadFile = 'copilot_readFile',
	ListDirectory = 'copilot_listDirectory',
	GetErrors = 'copilot_getErrors',
	DocInfo = 'copilot_getDocInfo',
	GetScmChanges = 'copilot_getChangedFiles',
	ReadProjectStructure = 'copilot_readProjectStructure',
	TerminalSelection = 'copilot_getTerminalSelection',
	TerminalLastCommand = 'copilot_getTerminalLastCommand',
	CreateNewWorkspace = 'copilot_createNewWorkspace',
	CreateNewJupyterNotebook = 'copilot_createNewJupyterNotebook',
	EditFile = 'copilot_insertEdit',
	CreateFile = 'copilot_createFile',
	ReplaceString = 'copilot_replaceString',
	EditNotebook = 'copilot_editNotebook',
	RunNotebookCell = 'copilot_runNotebookCell',
	GetNotebookSummary = 'copilot_getNotebookSummary',
	ReadCellOutput = 'copilot_readNotebookCellOutput',
	InstallExtension = 'copilot_installExtension',
	Think = 'copilot_think',
	FetchWebPage = 'copilot_fetchWebPage',
	FindTestFiles = 'copilot_findTestFiles',
	GetProjectSetupInfo = 'copilot_getProjectSetupInfo',
	SearchViewResults = 'copilot_getSearchResults',
	GithubRepo = 'copilot_githubRepo',
	CreateAndRunTask = 'copilot_createAndRunTask',
	SimpleBrowser = 'copilot_openSimpleBrowser',
	CreateDirectory = 'copilot_createDirectory',
	RunVscodeCmd = 'copilot_runVscodeCommand',
}

const contributedToolNameToToolNames = new Map<ContributedToolName, ToolName>([
	[ContributedToolName.ApplyPatch, ToolName.ApplyPatch],
	[ContributedToolName.Codebase, ToolName.Codebase],
	[ContributedToolName.SearchWorkspaceSymbols, ToolName.SearchWorkspaceSymbols],
	[ContributedToolName.Usages, ToolName.Usages],
	[ContributedToolName.VSCodeAPI, ToolName.VSCodeAPI],
	[ContributedToolName.TestFailure, ToolName.TestFailure],
	[ContributedToolName.FindFiles, ToolName.FindFiles],
	[ContributedToolName.FindTextInFiles, ToolName.FindTextInFiles],
	[ContributedToolName.ReadFile, ToolName.ReadFile],
	[ContributedToolName.ListDirectory, ToolName.ListDirectory],
	[ContributedToolName.GetErrors, ToolName.GetErrors],
	[ContributedToolName.DocInfo, ToolName.DocInfo],
	[ContributedToolName.GetScmChanges, ToolName.GetScmChanges],
	[ContributedToolName.ReadProjectStructure, ToolName.ReadProjectStructure],
	[ContributedToolName.EditFile, ToolName.EditFile],
	[ContributedToolName.UpdateUserPreferences, ToolName.UpdateUserPreferences],
	[ContributedToolName.TerminalSelection, ToolName.TerminalSelection],
	[ContributedToolName.TerminalLastCommand, ToolName.TerminalLastCommand],
	[ContributedToolName.CreateNewWorkspace, ToolName.CreateNewWorkspace],
	[ContributedToolName.CreateNewJupyterNotebook, ToolName.CreateNewJupyterNotebook],
	[ContributedToolName.InstallExtension, ToolName.InstallExtension],
	[ContributedToolName.Think, ToolName.Think],
	[ContributedToolName.FetchWebPage, ToolName.FetchWebPage],
	[ContributedToolName.FindTestFiles, ToolName.FindTestFiles],
	[ContributedToolName.CreateFile, ToolName.CreateFile],
	[ContributedToolName.ReplaceString, ToolName.ReplaceString],
	[ContributedToolName.EditNotebook, ToolName.EditNotebook],
	[ContributedToolName.RunNotebookCell, ToolName.RunNotebookCell],
	[ContributedToolName.GetNotebookSummary, ToolName.GetNotebookSummary],
	[ContributedToolName.ReadCellOutput, ToolName.ReadCellOutput],
	[ContributedToolName.GetProjectSetupInfo, ToolName.GetProjectSetupInfo],
	[ContributedToolName.SearchViewResults, ToolName.SearchViewResults],
	[ContributedToolName.GithubRepo, ToolName.GithubRepo],
	[ContributedToolName.SimpleBrowser, ToolName.SimpleBrowser],
	[ContributedToolName.CreateDirectory, ToolName.CreateDirectory],
	[ContributedToolName.RunVscodeCmd, ToolName.RunVscodeCmd],
]);

const toolNameToContributedToolNames = new Map<ToolName, ContributedToolName>();
for (const [contributedName, name] of contributedToolNameToToolNames) {
	toolNameToContributedToolNames.set(name, contributedName);
}

export function getContributedToolName(name: string | ToolName): string | ContributedToolName {
	return toolNameToContributedToolNames.get(name as ToolName) ?? name;
}

export function getToolName(name: string | ContributedToolName): string | ToolName {
	return contributedToolNameToToolNames.get(name as ContributedToolName) ?? name;
}

export function mapContributedToolNamesInString(str: string): string {
	contributedToolNameToToolNames.forEach((value, key) => {
		const re = new RegExp(`\\b${key}\\b`, 'g');
		str = str.replace(re, value);
	});
	return str;
}

export function mapContributedToolNamesInSchema(inputSchema: object): object {
	return cloneAndChange(inputSchema, value => typeof value === 'string' ? mapContributedToolNamesInString(value) : undefined);
}

/**
 * Tools that can mutate code in the working set and that should be run prior
 * to forming an additional request with the model, to avoid that request
 * having outdated contents.
 */
export const prerunTools: ReadonlySet<ToolName> = new Set([
	ToolName.EditFile
]);
