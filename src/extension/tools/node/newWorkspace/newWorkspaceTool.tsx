/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import type { CancellationToken, LanguageModelToolInvocationOptions, LanguageModelToolInvocationPrepareOptions, PreparedToolInvocation, Uri } from 'vscode';
import { IRunCommandExecutionService } from '../../../../platform/commands/common/runCommandExecutionService';
import { IDialogService } from '../../../../platform/dialog/common/dialogService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IInteractiveSessionService } from '../../../../platform/interactive/common/interactiveSessionService';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { extUri } from '../../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult } from '../../../../vscodeTypes';
import { saveNewWorkspaceContext } from '../../../getting-started/common/newWorkspaceContext';
import { renderPromptElementJSON } from '../../../prompts/node/base/promptRenderer';
import { ToolName } from '../../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';

export interface INewWorkspaceToolParams {
	query: string;
}

export class GetNewWorkspaceTool implements ICopilotTool<INewWorkspaceToolParams> {
	public static readonly toolName = ToolName.CreateNewWorkspace;

	private _shouldPromptWorkspaceOpen: boolean = false;
	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IInteractiveSessionService private readonly interactiveSession: IInteractiveSessionService,
		@IRunCommandExecutionService private readonly commandService: IRunCommandExecutionService,
	) { }

	async prepareInvocation?(options: LanguageModelToolInvocationPrepareOptions<INewWorkspaceToolParams>, token: CancellationToken): Promise<PreparedToolInvocation> {

		this._shouldPromptWorkspaceOpen = false;
		const workspace = this.workspaceService.getWorkspaceFolders();
		if (!workspace || workspace.length === 0) {
			this._shouldPromptWorkspaceOpen = true;
		}
		else if (workspace && workspace.length > 0) {
			this._shouldPromptWorkspaceOpen = (await this.fileSystemService.readDirectory(workspace[0])).length > 0;
		}
		if (this._shouldPromptWorkspaceOpen) {
			const confirmationMessages = {
				title: l10n.t`Open an empty folder to continue`,
				message: l10n.t`Copilot requires an empty folder as a workspace to continue workspace creation.`
			};

			return {
				confirmationMessages,
			};
		}

		return {
			invocationMessage: l10n.t`Generating plan to create a new workspace`,
		};
	}

	async invoke(options: LanguageModelToolInvocationOptions<INewWorkspaceToolParams>, token: CancellationToken): Promise<LanguageModelToolResult> {

		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		const workspace = this.workspaceService.getWorkspaceFolders();
		let workspaceUri: Uri | undefined = workspace.length > 0 ? workspace[0] : undefined;

		if (this._shouldPromptWorkspaceOpen) {
			const newWorkspaceUri = (await this.dialogService.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Select an Empty Workspace Folder' }))?.[0];
			if (newWorkspaceUri && !extUri.isEqual(newWorkspaceUri, workspaceUri)) {

				if ((await this.fileSystemService.readDirectory(newWorkspaceUri)).length > 0) {
					return new LanguageModelToolResult([
						new LanguageModelTextPart('The user has not opened a valid workspace folder in VS Code. Ask them to open an empty folder before continuing.')
					]);
				}

				saveNewWorkspaceContext({
					workspaceURI: newWorkspaceUri.toString(),
					userPrompt: options.input.query,
					initialized: false, /*not already opened */
				}, this._extensionContext);

				workspaceUri = newWorkspaceUri;

				this.interactiveSession.transferActiveChat(newWorkspaceUri);
				this.commandService.executeCommand('vscode.openFolder', newWorkspaceUri, { forceReuseWindow: true });

				return new LanguageModelToolResult([
					new LanguageModelTextPart(`The user is opening the folder ${newWorkspaceUri.toString()}. Do not proceed with project generation till the user has confirmed opening the folder.`)
				]);
			}

			return new LanguageModelToolResult([
				new LanguageModelTextPart('The user has not opened a valid workspace folder in VS Code. Ask them to open an empty folder before continuing.')
			]);
		}

		if (!workspaceUri) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('The user has not opened a valid workspace folder in VS Code. Ask them to open an empty folder before continuing.')
			]);
		}

		const json = await renderPromptElementJSON(this.instantiationService, NewWorkspaceCreationResult, { query: options.input.query },);
		return new LanguageModelToolResult([
			new LanguageModelPromptTsxPart(json),
		]);
	}
}

export class NewWorkspaceCreationResult extends PromptElement<NewWorkspaceElementProps> {
	constructor(
		props: PromptElementProps<NewWorkspaceElementProps>,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService
	) {
		super(props);
	}

	override async render(state: void, sizing: PromptSizing) {
		const workspace = this.workspaceService.getWorkspaceFolders();
		const workspaceUri: Uri | undefined = workspace.length > 0 ? workspace[0] : undefined;

		if (!workspaceUri) {
			return <TextChunk>
				The user has not opened an empty workspace folder in VS Code. Ask them to open an empty folder before continuing.<br />
			</TextChunk>;
		}

		return <>
			<TextChunk>
				The user has opened the workspace folder {this.promptPathRepresentationService.getFilePath(workspaceUri)}<br />
				Create a new project in this workspace folder.<br />
				To create a new project for the user, follow the steps below to create files, set up necessary extensions, and configure the project environment in Visual Studio Code.<br />
				# Overview<br />
				- Call the tool {ToolName.GetProjectSetupInfo} to get a VS Code workspace-supported project template based on the user's request.<br />
				- Run a command-line tool to scaffold the project files from a template.<br />
				- Create and update a `copilot-instructions.md` file in the project root under the `.github` directory.<br />
				- Customize the project files based on the user's requirements, if specified.<br />
				- Ensure that all required extensions are installed, if specified.<br />
				- Compile the project and install any missing dependencies.<br />
				- Create a task based on the package.json, README.md, and project structure and pass that as input to the tool {ToolName.CoreCreateAndRunTask}.<br />
				<br />
				Here is the plan you need to execute:<br />
				## 1. Get Project Template <br />
				- Based on the user's request, call the {ToolName.GetProjectSetupInfo} with inputs and supported values being:
				- -projectType: 'python-script', 'python-package', 'mcp-server', 'model-context-protocol-server', 'vscode-extension', 'next-js', 'vite'<br />
				- -language: 'python', 'typescript', 'javascript'<br />
				- Use keywords from the user's request to determine the project type and language.<br />
				- If a user asks for an MCP server project or model context protocol server, use the `mcp-server` project type.<br />
				- If the tool does not return a project type, scaffold the project using the default commands and arguments that you know.<br />
				## 2. Scaffold the Project<br />
				- If the user provided a terminal command, use it to scaffold the project.<br />
				- Otherwise, from the result of calling the tool {ToolName.GetProjectSetupInfo}, use the execution commands and arguments listed for that project type to construct a command based on the user's requirements. Make sure to use the EXACT command.<br />
				- If no template was found, use an alternative that includes the necessary arguments for a default setup.<br />
				## 3. Create `copilot-instructions.md`<br />
				- For all projects, always create a markdown file named `copilot-instructions.md` in the project root under the `.github` directory.<br />
				- This file is used to provide custom instructions to help Copilot generate higher-quality code.<br />
				- Include the following content at the beginning of the `copilot-instructions.md` file:
				- - {`<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->`}<br />
				- If you are creating a VS Code Extension, update the `copilot-instructions.md` to include the following instruction:<br />
				- - `This is a VS Code extension project. Please use the {ToolName.VSCodeAPI} with a query as input to fetch the latest VS Code API references.`<br />
				- If you are creating an MCP Server project, update the `copilot-instructions.md` to include the following instructions:<br />
				- - `You can find more info and examples at https://modelcontextprotocol.io/llms-full.txt`<br />
				## 4. Customize the Project Code<br />
				- If {ToolName.GetProjectSetupInfo} lists tools, call them first before proceeding.<br />
				- Develop a plan to modify the codebase according to the user's requirements. Ignore this step for a "Hello World" project.<br />
				- Apply the modifications in the plan to the codebase using the right tools and user-provided references below.<br />
				## 5. Install Required Visual Studio Code Extensions (if applicable)<br />
				- Ensure all required extensions are installed. Skip this step if `requiredExtensions` are not provided for the selected `projectType`.<br />
				## 6. Compile the Project<br />
				- Install any missing dependencies.<br />
				- Run diagnostics and resolve any issues.<br />
				- Check for markdown files in the project folder that may contain relevant instructions to help with this step.<br />
				## 7. Provide Instructions to the User and Ask if They Would Like to Launch Their Project<br />
				- Launch the project in debug mode within Visual Studio Code.<br />
				## 8. Create and Update README.md<br />
				- Verify that a README.md file exists at the root of the project. If it doesn’t, create one.<br />
				- Update the README.md file to accurately reflect current state of the project.<br />
				## 9. Create and run the task to build the project<br />
				- Create a task based on the package.json, README.md, and project structure and pass that as input to the tool {ToolName.CoreCreateAndRunTask}.<br />
				<br />
				# Rules<br />
				- Always start executing the plan by calling the tool {ToolName.GetProjectSetupInfo} to get the project template.<br />
				- Before executing, provide the user with a high-level plan outlining the steps and the command that you will use to create the project. Do not list unnecessary details—keep it concise and actionable.<br />
				- Help the user execute this plan by calling the appropriate tools.<br />
				- Once the project is created, it is already opened in Visual Studio Code—do not suggest commands to open this project in Visual Studio again.<br />
				- Do not print and explain the project structure to the user unless explicitly requested.<br />
				- If the project setup information has additional rules, follow them strictly.<br />
				- Follow the rules below strictly.<br />
				## Folder Creation Rules<br />
				- Always use the current directory as the project root.<br />
				- If you are running any terminal commands, use the '.' argument to ensure that the current working directory is used ALWAYS.<br />
				- Do not create a new folder unless the user explicitly requests it besides a .vscode folder for a tasks.json file.<br />
				- If any of the scaffolding commands mention that the folder name is not correct, let the user know to create a new folder with the correct name and then reopen it again in vscode. Do not attempt to move it yourself. And do not proceed with next steps.<br />
				## Extension Installation Rules<br />
				- If the project setup lists `requiredExtensions`, use `{ToolName.InstallExtension}` to check and install ALL the listed `requiredExtensions` before proceeding.<br />
				## Project Content Rules<br />
				- If the user has not specified project details, assume they want a "Hello World" project as a starting point.<br />
				- Avoid adding links of any type (URLs, files, folders, etc.) or integrations that are not explicitly required.<br />
				- Avoid generating images, videos, or any other media files unless explicitly requested.<br />
				- If you need to use any media assets as placeholders, let the user know that these are placeholders and should be replaced with the actual assets later.<br />
				- Ensure all generated components serve a clear purpose within the user's requested workflow.<br />
				- If a feature is assumed but not confirmed, prompt the user for clarification before including it.<br />
				- If you are working on a VS Code extension, use the {ToolName.VSCodeAPI} tool API with a query to find relevant VS Code API references and samples related to that query.<br />
				## Task Completion Rules<br />
				- Your task is complete when:<br />
				- - The project is successfully created without errors.<br />
				- - The user has clear instructions on how to launch their code in debug mode within Visual Studio Code.<br />
				- - A `copilot-instructions.md` exists in the project root under the `.github` directory.<br />
				- - A README.md file in the root of the project is up to date.<br />
				- - A `tasks.json` file exists in the project root under the `.vscode` directory. <br />
				<br />
				- If the user asks to "continue," refer to the previous steps and proceed accordingly.<br />
			</TextChunk>
		</>;
	}
}

ToolRegistry.registerTool(GetNewWorkspaceTool);

interface NewWorkspaceElementProps extends BasePromptElementProps {
	query: string;
}