/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import type { CancellationToken, LanguageModelToolInvocationOptions, LanguageModelToolInvocationPrepareOptions, PreparedToolInvocation, Uri } from 'vscode';
import { IRunCommandExecutionService } from '../../../../platform/commands/common/runCommandExecutionService';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
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
import { UnsafeCodeBlock } from '../../../prompts/node/panel/unsafeElements';
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
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IConfigurationService private readonly configurationService: IConfigurationService
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

		const useContext7 = this.configurationService.getConfig(ConfigKey.NewWorkspaceUseContext7);
		const context7ToolInstructions = useContext7
			? "Use get-library-docs and resolve-library-id to search documentation and identify the correct library for scaffolding the project"
			: "If applicable, call project setup tool with:\n\t\t- projectType: e.g. 'python-script', 'mcp-server', 'next-js'\n\t\t- language: e.g. 'python', 'typescript'";
		return <>
			<TextChunk>
				The user has opened the workspace folder {this.promptPathRepresentationService.getFilePath(workspaceUri)}<br />
				Follow the plan below to create a new project in the current VS Code workspace folder<br />
				Step 1: Create a `.github/copilot-instructions.md` with the following content as a markdown todo list<br />
				- If the user has requested a VS Code extension: Add a note at the top to use {ToolName.VSCodeAPI} tool<br />
				- If the user has requested an MCP server: Add a link at the top to https://modelcontextprotocol.io/llms-full.txt<br />
				- Include this comment at the top of the file {`<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->`}<br />
				- Include the below markdown content in the file including the comments <br />
			</TextChunk>
			<UnsafeCodeBlock code={`
- [ ] Clarify Project Requirements (If Not Provided)**
	- If the user hasn't already specified, ask:
	- What is the goal or type of the project? (e.g. CLI tool, web app, VS Code extension)
	- What language should be used? (e.g. Python, TypeScript)
	- Any specific frameworks/technologies? (e.g. Flask, React, Next.js, Vite)
	- Use this to guide project setup
	- If already provided, skip this step

- [ ] Scaffold the Project**
	${context7ToolInstructions}
	- Run the scaffolding command from setup info
	- Use '.' as the working directory
	- Fall back to default scaffolding if needed

- [ ] Customize the project
	- Develop a plan to modify the codebase according to the user's requirements. Ignore this step for a "Hello World" project.
	- Apply the modifications in the plan to the codebase using the right tools and user-provided references below.

- [ ] Install required VS Code extensions using the extension installer tool (if \`requiredExtensions\` is defined)

- [ ] Compile the project
	- Install any missing dependencies.
	- Run diagnostics and resolve any issues.
	- Check for markdown files in the project folder that may contain relevant instructions to help with this step.

- [ ] Create and run a task based on project structure and metadata using the right tool
  <!-- 	Create a task based on the package.json, README.md, and project structure and pass that as input to the tool. -->

- [ ] Launch the project (prompt user for debug mode, launch only if confirmed)

- [ ] Ensure README.md exists and is up to date

## Execution Guidelines
- After completing each step, check it off and add a one-line summary
- Avoid verbose explanations or printing full command outputs
- If a step is skipped, state that briefly (e.g. "No extensions needed")
- Use '.' as the working directory unless user specifies otherwise
- Do not explain project structure unless asked
- Do not create folders unless user instructs
- Avoid adding media or external links unless explicitly requested
- Use placeholders only with a note that they should be replaced
- Use VS Code API tool only for VS Code extension projects
- Completion = project scaffolded, copilot-instructions + README exist, task runnable, debug launch offered

<!--
# Rules
- Always start executing the plan by calling the tool to get the project template.
- Before executing, provide the user with a high-level plan outlining the steps and the command that you will use to create the project. Do not list unnecessary details—keep it concise and actionable.
- Help the user execute this plan by calling the appropriate tools.
- Once the project is created, it is already opened in Visual Studio Code—do not suggest commands to open this project in Visual Studio again.
- Do not print and explain the project structure to the user unless explicitly requested.
- If the project setup information has additional rules, follow them strictly.
- Follow the rules below strictly.

## Folder Creation Rules
- Always use the current directory as the project root.
- If you are running any terminal commands, use the '.' argument to ensure that the current working directory is used ALWAYS.
- Do not create a new folder unless the user explicitly requests it besides a .vscode folder for a tasks.json file.
- If any of the scaffolding commands mention that the folder name is not correct, let the user know to create a new folder with the correct name and then reopen it again in vscode. Do not attempt to move it yourself. And do not proceed with next steps.

## Extension Installation Rules
- If the project setup lists \`requiredExtensions\`, use extension installer tool to check and install ALL the listed \`requiredExtensions\` before proceeding.

## Project Content Rules
- If the user has not specified project details, assume they want a "Hello World" project as a starting point.
- Avoid adding links of any type (URLs, files, folders, etc.) or integrations that are not explicitly required.
- Avoid generating images, videos, or any other media files unless explicitly requested.
- If you need to use any media assets as placeholders, let the user know that these are placeholders and should be replaced with the actual assets later.
- Ensure all generated components serve a clear purpose within the user's requested workflow.
- If a feature is assumed but not confirmed, prompt the user for clarification before including it.
- If you are working on a VS Code extension, use the VS Code API tool with a query to find relevant VS Code API references and samples related to that query.

## Task Completion Rules
- Your task is complete when:
  - The project is successfully created without errors.
  - The user has clear instructions on how to launch their code in debug mode within Visual Studio Code.
  - A \`copilot-instructions.md\` exists in the project root under the \`.github\` directory.
  - A README.md file in the root of the project is up to date.
  - A \`tasks.json\` file exists in the project root under the \`.vscode\` directory.
-->

Before starting a new task in the above plan, update progress in the plan.
`} languageId='markdown'></UnsafeCodeBlock>
			<TextChunk>
				<br />
				Step 2: Execute the Plan<br />
				After creating the .github/copilot-instructions.md file with the above content, continue with executing each step of the plan systematically.<br />
				Update the .github/copilot-instructions.md with progress as you exectue the plan<br />
				<br />
				If the user asks to "continue," refer to the previous steps and proceed accordingly.
			</TextChunk>
		</>;
	}
}

ToolRegistry.registerTool(GetNewWorkspaceTool);

interface NewWorkspaceElementProps extends BasePromptElementProps {
	query: string;
}