## 0.30 (2025-08-07)

GitHub Copilot updates from [July 2025](https://code.visualstudio.com/updates/v1_103):

### Chat

#### Chat checkpoints

**Setting**: `chat.checkpoints.enabled`

We've introduced checkpoints that enable you to restore different states of your chat conversations. You can easily revert edits and go back to certain points in your chat conversation. This can be particularly useful if multiple files were changed in a chat session.

When you select a checkpoint, VS Code reverts workspace changes and the chat history to that point. After restoring a checkpoint, you can redo that action as well!

<video src="https://code.visualstudio.com/assets/updates/1_103/chat-checkpoints.mp4" title="Video that shows creating and managing chat checkpoints." autoplay loop controls muted></video>

Checkpoints will be enabled by default and can be controlled with `chat.checkpoints.enabled`.

#### Tool picker improvements

We've totally revamped the tool picker this iteration and adopted a new component called Quick Tree to display all the tools.

![Screenshot showing the new tool picker using a quick tree, enabling collapsing and expanding nodes.](https://code.visualstudio.com/assets/updates/1_103/tool-picker-quick-tree.png)

Notable features:

* Expand or collapse tool sets, MCP servers, extension contributed tools, and more
* Configuration options moved to the title bar
* Sticky scrolling
* Icon rendering

Let us know what you think!

#### Tool grouping (Experimental)

**Setting**: `github.copilot.chat.virtualTools.threshold`

The maximum number of tools that you can use for a single chat request is currently 128. Previously, you could quickly reach this limit by installing MCP servers with many tools, requiring you to deselect some tools in order to proceed.

In this release of VS Code, we have enabled an experimental tool-calling mode for when the number of tools exceeds the maximum limit. Tools are automatically grouped and the model is given the ability to activate and call groups of tools.

This behavior, including the threshold, is configurable via the setting `github.copilot.chat.virtualTools.threshold`.

#### Terminal auto-approve improvements

**Setting**: `chat.tools.terminal.autoApprove`

Early terminal auto-approve settings were introduced last month. This release, the feature got many improvements. Learn more about [terminal auto-approval](https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode#_autoapprove-terminal-commands-experimental) in our documentation.

- We merged the `allowList` and `denyList` settings into the `chat.tools.terminal.autoApprove` setting. If you were using the old settings, you should see a warning asking you to migrate to the new setting.
- Regular expression matchers now support flags. This allows case insensitivity, for example in PowerShell, where case often doesn't matter:

    ```jsonc
    "chat.tools.terminal.autoApprove": {
      // Deny any `Remove-Item` command, regardless of case
      "/^Remove-Item\\b/i": false
    }
    ```

- There was some confusion around how the sub-command matching works, this is now explained in detail in the setting's description, but we also support matching against the complete command line.

    ```jsonc
    "chat.tools.terminal.autoApprove": {
      // Deny any _command line_ containing a reference to what is likely a PowerShell script
      "/\\.ps1\\b/i": { approve: false, matchCommandLine: true }
    }
    ```

- The auto approve reasoning is now logged to the Terminal Output channel. We plan to [surface this in the UI soon](https://github.com/microsoft/vscode/issues/256780).

#### Improved model management experience

This iteration, we've revamped the chat provider API, which is responsible for language model access. Users are now able to select which models appear in their model picker, creating a more personalized and focused experience.

![Screenshot of the model picker showing various models from providers such as Copilot and OpenRouter](https://code.visualstudio.com/assets/updates/1_103/modelpicker.png)

We plan to finalize this new API in the coming months and would appreciate any feedback. Finalization of this API will open up the extension ecosystem to implement their own model providers and further expand the bring your own key offering.

#### Azure DevOps repos remote index support

The [`#codebase` tool](https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context#_perform-a-codebase-search) now supports remote indexes for workspaces that are linked to Azure DevOps repos. This enables `#codebase` to search for relevant snippets almost instantly without any initialization. This even works for larger repos with tens of thousands of indexable files. Previously, this feature only worked with GitHub linked repos.

Remote indexes are used automatically when working in a workspace that is linked to Azure DevOps through git. Make sure you are also logged into VS Code with the Microsoft account you use to access the Azure DevOps repos.

We're gradually rolling out support for this feature on the services side, so not every organization might be able to use it initially. Based on the success of the rollout, we hope to turn on remote indexing for Azure DevOps for as many organizations as possible.

#### Improved reliability and performance of the run in terminal and task tools

We have migrated the tools for running tasks and commands within the terminal from the Copilot extension into the core [microsoft/vscode repository](https://github.com/microsoft/vscode). This gives the tools access to lower-level and richer APIs, allowing us to fix many of the terminal hanging issues. This update also comes with the benefit of more easily implementing features going forward, as we're no longer restricted to the capabilities of the extension API, especially any changes that need custom UI within the Chat view.

#### Warning about no shell integration when using chat

While we strive to allow agent mode to run commands in terminals without shell integration, the experience will always be inferior as the terminal is essentially a black box at that point. Examples of issues that can occur without shell integration are: no exit code reporting and the inability to differentiate between a command idling and a prompt idling, resulting in output possibly not being reported to the agent.

When the `run in terminal` tool is used but [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration) is not detected, a message is displayed calling this out and pointing at the documentation.

![Screenshot of a message in the Chat view saying "Enable shell integration to improve command detection".](https://code.visualstudio.com/assets/updates/1_103/terminal-chat-si-none.png)

#### Output polling for tasks and terminals

The agent now waits for tasks and background terminals to complete before proceeding by using output polling. If a process takes longer than 20 seconds, you are prompted to continue waiting or move on. The agent will monitor the process for up to two minutes, summarizing the current state or reporting if the process is still running. This improves reliability when running long or error-prone commands in chat.

#### Task awareness improvement

Previously, the agent could only monitor active tasks. Now, it can track and analyze the output of both active and completed tasks, including those that have failed or finished running. This enhancement enables better troubleshooting and more comprehensive insights into task execution history.

#### Agent awareness of user created terminals

The agent now maintains awareness of all user-created terminals in the workspace. This enables it to track recent commands and access terminal output, providing better context for assisting with terminals and troubleshooting.

#### Terminal inline chat improvements

Terminal inline chat now better detects your active shell, even when working within subshells (for example, launching Python or Node from PowerShell or zsh). This dynamic shell detection improves the accuracy of inline chat responses by providing more relevant command suggestions for your current shell type.

![Screenshot of terminal inline chat showing node specific suggestions.](https://code.visualstudio.com/assets/updates/1_103/hello_node.png)

#### Improved test runner tool

The test runner tool has been reworked. It now shows progress inline within chat, and numerous bugs in the tool have been fixed.

#### Edit previous requests

**Setting**: `chat.editRequests`

Last iteration, we enabled users to edit previous requests and rolled out a few different access points. This iteration, we've made inline edits the default behavior. Click on the request bubble to begin editing that request. You can modify attachments, change the mode and model, and resend your request with modified text.

<video src="https://code.visualstudio.com/assets/updates/1_103/chat-previous-edits.mp4" title="Video that shows editing a previous chat request inline in the Chat view." autoplay loop controls muted></video>

You can control the chat editing behavior with the `chat.editRequests` setting if you prefer editing via the toolbar hovers above each request.

#### Open chat as maximized

**Setting**: `workbench.secondarySideBar.defaultVisibility`

We added two extra options for configuring the default visibility of the Secondary Side Bar to open it as maximized:

* `maximizedInWorkspace`: open the Chat view as maximized when opening a new workspace
* `maximized`: open the Chat view always as maximized, including in empty windows

![Screenshot that shows the Chat view maximized.](https://code.visualstudio.com/assets/updates/1_103/max-chat.png)

#### Pending chat confirmation

To help prevent accidentally closing a workspace where an agent session is actively changing files or responding to your request, we now show a dialog when you try to quit VS Code or close its window when a chat response is in progress:

![Screenshot of confirmation to exit with running chat.](https://code.visualstudio.com/assets/updates/1_103/confirm-chat-exit.png)

#### OS notification on user action

**Setting**: `chat.notifyWindowOnConfirmation`

We now leverage the OS native notification system to show a toast when user confirmation is needed within a chat session. Enable this behavior with the `chat.notifyWindowOnConfirmation`.

![Screenshot of toast for confirmation of a chat agent.](https://code.visualstudio.com/assets/updates/1_103/chat-toast.png)

We plan to improve this experience in the future to allow for displaying more information and for allowing you to approve directly from the toast. For now, selecting the toast focuses the window where the confirmation originated from.

#### Math support in chat (Preview)

**Setting**: `chat.math.enabled`

Chats now have initial support for rendering mathematical equations in responses:

![Screenshot of the Chat view, showing inline and block equations in a chat response.](https://code.visualstudio.com/assets/updates/1_103/chat-math.png)

This feature is powered by [KaTeX](https://katex.org) and supports both inline and block math equations. Inline math equations can be written by wrapping the markup in single dollar signs (`$...$`), while block math equations use two dollar signs (`$$...$$`).

Math rendering can be enabled using `chat.math.enabled`. Currently, it is off by default but we plan to enable it in a future release, after further testing.

#### Context7 integration for project scaffolding (Experimental)

**Setting**: `github.copilot.chat.newWorkspace.useContext7`

When you scaffold a new project with `#new` in chat, you can now make sure that it uses the latest documentation and APIs from **Context7**, if you have already installed the Context7 MCP server.

### MCP

#### Server autostart and trust

**Setting**: `chat.mcp.autostart:newAndOutdated`

Previously, when you added or updated an MCP server configuration, VS Code would show a blue "refresh" icon in the Chat view, enabling you to manually refresh the list of tools. In the milestone, you can now configure the auto-start behavior for MCP servers, so you no longer have to manually restart the MCP server.

Use the `chat.mcp.autostart:newAndOutdated` setting to control this behavior. You can also change this setting within the icon's tooltip and see which servers will be started:

![Screenshot showing the hover of the refresh MCP server icon, enabling you to configure the auto-start behavior.](https://code.visualstudio.com/assets/updates/1_103/mcp-refresh-tip.png)

The first time an MCP server is started after being updated or changed, we now show a dialog asking you to trust the server. Giving trust to these servers is particularly important with autostart turned on to running undesirable commands unknowingly.

Learn more about [using MCP servers in VS Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) in our documentation.

#### Client credentials flow for remote MCP servers

The ideal flow for a remote MCP server that wants to support authentication is to use an auth provider that supports Dynamic Client Registration (DCR). This enables the client (VS Code) to register itself with that auth provider, so the auth flow is seamless.

However, not every auth provider supports DCR, so we introduced a client-credentials flow that enables you to supply your own client ID and (optionally) client secret that will be used when taking you through the auth provider's auth flow. Here's what that looks like:

* Step 1: VS Code detects that DCR can't be used, and asks if you want to do the client credentials flow:

    ![Screenshot of a modal dialog saying that DCR is not supported but you can provide client credentials manually.](https://code.visualstudio.com/assets/updates/1_103/mcp-auth-no-dcr1.png)

    > **IMPORTANT**: At this point, you would go to the auth provider's website and manually create an application registration. There you will put in the redirect URIs mentioned in the modal dialog.

* Step 2: From the auth provider's portal, you will get a client ID and maybe a client secret. You'll put the client ID in the input box that appears and hit <kbd>Enter</kbd>:

    ![Screenshot of an input box to provide the client ID for the MCP server.](https://code.visualstudio.com/assets/updates/1_103/mcp-auth-no-dcr2.png)

* Step 3: Then you'll put in the client secret if you have one, and hit <kbd>Enter</kbd> (leave blank if you don't have one)

    ![Screenshot of an input box to provide the optional client secret for the MCP server.](https://code.visualstudio.com/assets/updates/1_103/mcp-auth-no-dcr3.png)

    At that point, you'll be taken through the typical auth flow to authenticate the MCP server you're working with.

#### Remove dynamic auth provider from Account menu

Since the addition of remote MCP authentication, there has been a command available in the Command Palette called **Authentication: Remove Dynamic Authentication Providers**, which enables you to remove client credentials (client ID and, if available, a client secret) and all account information associated with that provider.

We've now exposed this command in the Account menu. You can find it inside of an MCP server account:

![Screenshot of the Account menu showing the manage dynamic auth option in an account's submenu.](https://code.visualstudio.com/assets/updates/1_103/mcp-remove-dynamic-auth1.png)

or at the root of the menu if you don't have any MCP server accounts yet:

![Screenshot of the Account menu showing the manage dynamic auth option in the root of account menu.](https://code.visualstudio.com/assets/updates/1_103/mcp-remove-dynamic-auth2.png)

#### Support for `resource_link` and structured output

VS Code now fully supports the latest MCP specification, version `2025-06-18`, with support for `resource_link`s and structured output in tool results.

### Editor Experience

#### AI statistics (Preview)

**Setting**: `editor.aiStats.enabled:true`

We added an experimental feature for displaying basic AI statistics. Use the `editor.aiStats.enabled:true` to enable this feature, which is disabled by default.

This feature shows you, per project, the percentage of characters that was inserted by AI versus inserted by typing. It also keeps track of how many inline and next edit suggestions you accepted during the current day.

![Screenshot showing the AI statistic hover information in the Status Bar.](https://code.visualstudio.com/assets/updates/1_103/ai-stats.png)

### Notebooks

#### Notebook inline chat with agent tools

**Setting**: `inlineChat.notebookAgent:true`

The notebook inline chat control can now use the full suite of notebook agent tools to enable additional capabilities like running cells and installing packages into the kernel.

<video src="https://code.visualstudio.com/assets/updates/1_103/notebook-inline-agent.mp4" title="Video showing a coding agent session opening in a chat session editor." autoplay loop controls muted></video>

To enable agent tools in notebooks, enable the new experimental setting `inlineChat.notebookAgent:true`. This also currently requires enabling the setting for inline chat v2 `inlineChat.enableV2:true`.


## 0.29 (2025-07-09)

GitHub Copilot updates from [June 2025](https://code.visualstudio.com/updates/v1_102):

### Chat

#### Copilot Chat is open source

We're excited to announce that we've open sourced the GitHub Copilot Chat extension! The source code is now available at [`microsoft/vscode-copilot-chat`](https://github.com/microsoft/vscode-copilot-chat) under the MIT license.

This marks a significant milestone in our commitment to transparency and community collaboration. By open sourcing the extension, we're enabling the community to:

* **Contribute directly** to the development of AI-powered chat experiences in VS Code
* **Understand the implementation** of chat modes, custom instructions, and AI integrations
* **Build upon our work** to create even better AI developer tools
* **Participate in shaping the future** of AI-assisted coding

You can explore the repository to see how features like [agent mode](https://github.com/microsoft/vscode-copilot-chat/blob/e1222084830244174e6aa64683286561fa7e7607/src/extension/prompts/node/agent/agentPrompt.tsx), [inline chat](https://github.com/microsoft/vscode-copilot-chat/blob/e1222084830244174e6aa64683286561fa7e7607/src/extension/prompts/node/inline/inlineChatEditCodePrompt.tsx), and [MCP integration](https://github.com/microsoft/vscode-copilot-chat/blob/e1222084830244174e6aa64683286561fa7e7607/src/extension/mcp/vscode-node/mcpToolCallingLoop.tsx) are implemented. We welcome contributions, feedback, and collaboration from the community.

To learn more about this milestone and our broader vision for open source AI editor tooling, read our detailed blog post: [Open Source AI Editor - First Milestone](https://code.visualstudio.com/blogs/2025/06/30/openSourceAIEditorFirstMilestone).

#### Chat mode improvements

Last milestone, we previewed [custom chat modes](https://code.visualstudio.com/docs/copilot/chat/chat-modes#_custom-chat-modes). In addition to the built-in chat modes 'Ask', 'Edit' and 'Agent', you can define your own chat modes with specific instructions and a set of allowed tools that you want the LLM to follow when replying to a request.

This milestone, we have made several improvements and bug fixes in this area.

##### Configure language model

Upon popular request, you can now also specify which language model should be used for a chat mode. Add the `model` metadata property to your `chatmode.md` file and provide the model identifier (we provide IntelliSense for the model info).

![Screenshot that shows the IntelliSense for the model metadata property in chat mode file.](https://code.visualstudio.com/assets/updates/1_102/prompt-file-model-code-completion.png)

##### Improved editing support

The editor for [chat modes](https://code.visualstudio.com/docs/copilot/chat/chat-modes), [prompts](https://code.visualstudio.com/docs/copilot/copilot-customization#_prompt-files-experimental), and [instruction files](https://code.visualstudio.com/docs/copilot/copilot-customization#_custom-instructions) now supports completions, validation, and hovers for all supported metadata properties.

![Screenshot that shows the hover information for tools.](https://code.visualstudio.com/assets/updates/1_102/tools-hover.png)

![Screenshot that shows the model diagnostics when a model is not available for a specific chat mode.](https://code.visualstudio.com/assets/updates/1_102/prompt-file-diagnostics.png)

##### Gear menu in the chat view

The **Configure Chat** action in the Chat view toolbar lets you manage custom modes as well as reusable instructions, prompts, and tool sets:

![Screenshot that shows the Configure Chat menu in the Chat view.](https://code.visualstudio.com/assets/updates/1_102/chat-gear.png)

Selecting **Modes** shows all currently installed custom modes and enables you to open, create new, or delete modes.

##### Import modes via a `vscode` link

You can now import a chat mode file from an external link, such as a gist. For example, the following link will import the chat mode file for Burke's GPT 4.1 Beast Mode:

[Burke's GPT 4.1 Beast Mode (VS Code)](vscode:chat-mode/install?url=https://gist.githubusercontent.com/burkeholland/a232b706994aa2f4b2ddd3d97b11f9a7/raw/6e497f4b4ef5e7ea36787ef38fdf4385433591c1/4.1.chatmode.md)

This will prompt for a destination folder and a name for the mode and then import the mode file from the URL in the link. The same mechanism is also available for prompt and instruction files.

#### Generate custom instructions

Setting up [custom instructions](https://code.visualstudio.com/docs/copilot/copilot-customization) for your project can significantly improve AI suggestions by providing context about your coding standards and project conventions. However, creating effective instructions from scratch might be challenging.

This milestone, we're introducing the **Chat: Generate Instructions** command to help you bootstrap custom instructions for your workspace. Run this command from the Command Palette or the Configure menu in the Chat view, and agent mode will analyze your codebase to generate tailored instructions that reflect your project's structure, technologies, and patterns.

The command creates a `copilot-instructions.md` file in your `.github` folder or suggests improvements to existing instruction files. You can then review and customize the generated instructions to match your team's specific needs.

Learn more about [customizing AI responses with instructions](https://code.visualstudio.com/docs/copilot/copilot-customization).


#### Load instruction files on demand

Instruction files can be used to describe coding practices and project requirements. Instructions can be manually or automatically included as context to chat requests.

There are various mechanisms supported, see the [Custom Instructions](https://code.visualstudio.com/docs/copilot/copilot-customization#_custom-instructions) section in our documentation.

For larger instructions that you want to include conditionally, you can use `.instructions.md` files in combination with glob patterns defined in the `applyTo` header. The file is automatically added when the glob pattern matches one or more of the files in the context of the chat.

New in this release, the large language model can load instructions on demand. Each request gets a list of all instruction files, along with glob pattern and description. In this example, the LLM has no instructions for TypeScript files explicitly added in the context. So, it looks for code style rules before creating a TypeScript file:

![Screenshot showing loading instruction files on demand.](https://code.visualstudio.com/assets/updates/1_102/instructions-loading-on-demand.png)

#### Edit previous requests (Experimental)

You can now click on previous requests to modify the text content, attached context, mode, and model. Upon submitting this change, this will remove all subsequent requests, undo any edits made, and send the new request in chat.

There will be a controlled rollout of different entry points to editing requests, which will help us gather feedback on preferential edit and undo flows. However, users can set their preferred mode with the experimental `chat.editRequests` setting:

* `chat.editRequests.inline`: Hover a request and select the text to begin an edit inline with the request.
* `chat.editRequests.hover`: Hover a request to reveal a toolbar with a button to begin an edit inline with the request.
* `chat.editRequests.input`: Hover a request to reveal a toolbar, which will start edits in the input box at the bottom of chat.

<video src="https://code.visualstudio.com/assets/updates/1_102/edit-previous-requests.mp4" title="Video showing the process of editing a previous request in the Chat view." autoplay loop controls muted></video>

#### Terminal auto-approval (Experimental)

Agent mode now has a mechanism for auto approving commands in the terminal. Here's a demo of it using the defaults:

<video src="https://code.visualstudio.com/assets/updates/1_102/terminal-auto-approve.mp4" title="Video showing terminal commands like 'echo' and 'ls' being auto-approved in the Chat view." autoplay loop controls muted></video>

There are currently two settings: the allow list and the deny list. The allow list is a list of command _prefixes_ or regular expressions that when matched allows the command to be run without explicit approval. For example, the following will allow any command starting with `npm run test` to be run, as well as _exactly_ `git status` or `git log`:

```json
"github.copilot.chat.agent.terminal.allow list": {
  "npm run test": true,
  "/^git (status|log)$/": true
}
```

These settings are merged across setting scopes, such that you can have a set of user-approved commands, as well as workspace-specific approved commands.

As for chained commands, we try to detect these cases based on the shell and require all sub-commands to be approved. So `foo && bar` we check that both `foo` and `bar` are allowed, only at that point will it run without approval. We also try to detect inline commands such as `echo $(pwd)`, which would check both `echo $(pwd)` and `pwd`.

The deny list has the same format as the allow list but will override it and force approval. For now this is mostly of use if you have a broad entry in the allow list and want to block certain commands that it may include. For example the following will allow all commands starting with `npm run` except if it starts with `npm run danger`:

```json
"github.copilot.chat.agent.terminal.allow list": {
  "npm run": true
},
"github.copilot.chat.agent.terminal.denyList": {
  "npm run danger": true
}
```

Thanks to the protections that we gain against prompt injection from [workspace trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust), the philosophy we've approached when implementing this feature with regards to security is to include a small set of innocuous commands in the allow list, and a set of particularly dangerous ones in the deny list just in case they manage to slip through. We're still considering what should be the defaults but here is the current lists:

* Allow list: `echo`, `cd`, `ls`, `cat`, `pwd`, `Write-Host`, `Set-Location`, `Get-ChildItem`, `Get-Content`, `Get-Location`
* Deny list: `rm`, `rmdir`, `del`, `kill`, `curl`, `wget`, `eval`, `chmod`, `chown`, `Remove-Item`

The two major parts we want to add to this feature are a UI entry point to more easily add new commands to the list ([#253268](https://github.com/microsoft/vscode/issues/253268)) and an opt-in option to allow an LLM to evaluate the command(s) safety ([#253267](https://github.com/microsoft/vscode/issues/253267)). We are also planning on both removing the `github.copilot.` prefix of these settings ([#253314](https://github.com/microsoft/vscode/issues/253314)) as well as merging them together ([#253472](https://github.com/microsoft/vscode/issues/253472)) in the next release before it becomes a preview setting.

#### Terminal command simplification

Agent mode sometimes wants to run commands with a `cd` statement, just in case. We now detect this case when it matches the current working directory and simplify the command that is run.

![Screenshot of the terminal, asking to run `cd C:\Github\Tyriar\xterm.js && echo hello` only runs `echo hello` when the current working directory already matches.](https://code.visualstudio.com/assets/updates/1_102/terminal-working-dir.png)

#### Agent awareness of tasks and terminals

Agent mode now understands which background terminals it has created and which tasks are actively running. The agent can read task output by using the new `GetTaskOutput` tool, which helps prevent running duplicate tasks and improves workspace context.

![Screenshot of VS Code window showing two build tasks running in the terminal panel. The left terminal displays several errors. The chat agent replies to describe status of my build tasks with a summary of each task's output.](https://code.visualstudio.com/assets/updates/1_102/task-status.png)

#### Maximized chat view

You can now maximize the Secondary Side Bar to span the editor area and hide the Primary Side Bar and panel area. VS Code will remember this state between restarts and will restore the Chat view when you open an editor or view.

<video src="https://code.visualstudio.com/assets/updates/1_102/auxmax.mp4" title="Video showing maximizing the Secondary Side Bar." autoplay loop controls muted></video>

You can toggle in and out of the maximized state by using the new icon next to the close button, or use the new command `workbench.action.toggleMaximizedAuxiliaryBar` from the Command Palette.

#### Agent mode badge indicator

We now show a badge over the application icon in the dock when the window is not focused and the agent needs user confirmation to continue. The badge will disappear as soon as the related window that triggered it receives focus.

![Screenshot of the VS Code dock icon showing an agent confirmation as a badge.](https://code.visualstudio.com/assets/updates/1_102/badge.png)

You can enable or disable this badge via the `chat.notifyWindowOnConfirmation` setting.

#### Start chat from the command line

A new subcommand `chat` is added to the VS Code CLI that enables you to start a chat session in the current working directory with the prompt provided.

<video src="https://code.visualstudio.com/assets/updates/1_102/chatcli.mp4" title="Video showing the Chat CLI in action to open the Chat view from the command line and run a prompt." autoplay loop controls muted></video>

The basic syntax is `code chat [options] [prompt]` and options can be any of:

* `-m --mode <mode>`: The mode to use for the chat session. Available options: 'ask', 'edit', 'agent', or the identifier of a custom mode. Defaults to 'agent'
* `-a --add-file <path>`: Add files as context to the chat session
* `--maximize`: Maximize the chat session view
* `-r --reuse-window`: Force to use the last active window for the chat session
* `-n --new-window`: Force to open an empty window for the chat session

Reading from stdin is supported, provided you pass in `-` at the end, for example `ps aux | grep code | code chat <prompt> -`

#### Fetch tool supports non-HTTP URLs

We've seen that, on occasion, models want to call the Fetch tool with non-HTTP URLs, such as `file://` URLs. Rather than disallowing this, the Fetch tool now supports these URLs and returns the content of the file or resource at the URL. Images are also supported.

#### Clearer language model access management

We've reworked the UX around managing extension access to language models provided by extensions. Previously, you saw an item in the Account menu that said **AccountName (GitHub Copilot Chat)**, which had nothing to do with what account GitHub Copilot Chat was using. Rather, it allowed you to manage which extensions had access to the language models provided by Copilot Chat.

To make this clearer, we've removed the **AccountName (GitHub Copilot Chat)** item and replaced it with a new item called **Manage Language Model Access...**. This item opens a Quick Pick that enables you to manage which extensions have access to the language models provided by GitHub Copilot Chat.

![Screenshot that shows the language model access Quick Pick.](https://code.visualstudio.com/assets/updates/1_102/lm-access-qp.png)

We think this is clearer... That said, in a future release we will explore more granular access control for language models (for example, only allowing specific models rather than _all_ models provided by an extension), so stay tuned for that.

### MCP

#### MCP support in VS Code is generally available

We've have been working on expanding MCP support in VS Code for the past few months, and [support the full range of MCP features in the specification](https://code.visualstudio.com/blogs/2025/06/12/full-mcp-spec-support). As of this release, MCP support is now generally available in VS Code!

You can get started by installing some of the [popular MCP servers from our curated list](https://code.visualstudio.com/mcp). Learn more about [using MCP servers in VS Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) and how you can use them to extend agent mode.

![Screenshot that shows the MCP Servers page.](https://code.visualstudio.com/assets/updates/1_102/mcp-servers-page.png)

If you want to build your own MCP server, check our [MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp) for more details about how to take advantage of the MCP capabilities in VS Code.

#### Support for elicitations

The latest MCP specification added support for [Elicitations](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) as a way for MCP servers to request input from MCP clients. The latest version of VS Code adopts this specification and includes support for elicitations.

<video src="https://code.visualstudio.com/assets/updates/1_102/mcp-server-elicit.mp4" autoplay loop controls muted></video>

#### MCP server discovery and installation

The new **MCP Servers** section in the Extensions view includes welcome content that links directly to the [popular MCP servers from our curated list](https://code.visualstudio.com/mcp). Visit the website to explore available MCP servers and select **Install** on any MCP server. This automatically launches VS Code and opens the MCP server editor that displays the server's readme and manifest information. You can review the server details and select **Install** to add the server to your VS Code instance.

Once installed, MCP servers automatically appear in your Extensions view under the **MCP SERVERS - INSTALLED** section, and their tools become available in the Chat view's tools Quick Pick. This makes it easy to verify that your MCP server is working correctly and access its capabilities immediately.

<video src="https://code.visualstudio.com/assets/updates/1_102/mcp-servers-discovery-install.mp4" title="Video showing installing an MCP server from the MCP page on the VS Code website." autoplay loop controls muted></video>

#### MCP server management view

The new **MCP SERVERS - INSTALLED** view in the Extensions view makes it easy to monitor, configure, and control your installed MCP servers.

![Screenshot showing the MCP Servers management view with installed servers.](https://code.visualstudio.com/assets/updates/1_102/mcp-servers-installed-view.png)

The view lists the installed MCP servers and provides several management actions through the context menu:

![Screenshot showing the context menu actions for an MCP server.](https://code.visualstudio.com/assets/updates/1_102/mcp-server-context-menu.png)

* **Start Server** / **Stop Server** / **Restart Server**: Control the server's running state
* **Disconnect Account**: Remove account access from the server
* **Show Output**: View the server's output logs for troubleshooting
* **Show Configuration**: Open the server's runtime configuration
* **Configure Model Access**: Manage which language models the server can access
* **Show Sampling Requests**: View sampling requests for debugging
* **Browse Resources**: Explore resources provided by the server
* **Uninstall**: Remove the server from your VS Code instance

When you select an installed MCP server, VS Code opens the MCP server editor displaying the server's readme details, manifest, and its runtime configuration. This provides an overview of the server's capabilities and current settings, making it easy to understand what the server does and how it's configured.

![Screenshot showing the MCP server editor with runtime configuration.](https://code.visualstudio.com/assets/updates/1_102/mcp-server-editor-configuration.png)

The **MCP SERVERS - INSTALLED** view also provides a **Browse MCP Servers...** action that takes you directly to the community website, making server discovery always accessible from within VS Code.

![Screenshot that shows the Browse MCP Servers action in the MCP Servers view.](https://code.visualstudio.com/assets/updates/1_102/mcp-servers-browse-action.png)

#### MCP servers as first-class resources

MCP servers are now treated as first-class resources in VS Code, similar to user tasks and other profile-specific configurations. This represents a significant architectural improvement from the previous approach where MCP servers were stored in user settings. This change makes MCP server management more robust and provides better separation of concerns between your general VS Code settings and your MCP server configurations. When you install or configure MCP servers, they're automatically stored in the appropriate [profile](https://code.visualstudio.com/docs/configure/profiles)-specific location to ensure that your main settings file stays clean and focused.

* **Dedicated storage**: MCP servers are now stored in a dedicated `mcp.json` file within each profile, rather than cluttering your user settings file
* **Profile-specific**: Each VS Code profile maintains its own set of MCP servers, enabling you to have different server configurations for different workflows or projects
* **Settings Sync integration**: MCP servers sync seamlessly across your devices through [Settings Sync](https://code.visualstudio.com/docs/configure/settings-sync), with granular control over what gets synchronized

##### MCP migration support

With MCP servers being first-class resources and the associated change to their configuration, VS Code provides comprehensive migration support for users upgrading from the previous MCP server configuration format:

* **Automatic detection**: Existing MCP servers in `settings.json` are automatically detected and migrated to the new profile-specific `mcp.json` format
* **Real-time migration**: When you add MCP servers to user settings, VS Code immediately migrates them with a helpful notification explaining the change
* **Cross-platform support**: Migration works seamlessly across all development scenarios including local, remote, WSL, and Codespaces environments

This migration ensures that your existing MCP server configurations continue to work without any manual intervention while providing the enhanced management capabilities of the new architecture.

##### Dev Container support for MCP configuration

The Dev Container configuration `devcontainer.json` and the Dev Container Feature configuration `devcontainer-feature.json` support MCP server configurations at the path `customizations.vscode.mcp`. When a Dev Container is created the collected MCP server configurations are written to the remote MCP configuration file `mcp.json`.

##### Commands to access MCP resources

To make working with MCP servers more accessible, we've added commands to help you manage and access your MCP configuration files:

* **MCP: Open User Configuration** - Direct access to your user-level `mcp.json` file
* **MCP: Open Remote User Configuration** - Direct access to your remote user-level `mcp.json` file

These commands provide quick access to your MCP configuration files, making it easy to view and manage your server configurations directly.

#### Quick management of MCP authentication

You are now able to sign out or disconnect accounts from the MCP gear menu and quick picks.

* MCP view gear menu:
    ![Screenshot showing the Disconnect Account action shown in MCP view gear menu.](https://code.visualstudio.com/assets/updates/1_102/mcp-view-signout.png)

* MCP editor gear menu:
    ![Screenshot showing the Disconnect Account action shown in MCP editor gear menu.](https://code.visualstudio.com/assets/updates/1_102/mcp-editor-signout.png)

* MCP quick pick:
    ![Screenshot showing the Disconnect Account action shown in MCP quick pick menu.](https://code.visualstudio.com/assets/updates/1_102/mcp-qp-signout.png)

The **Disconnect** action is shown when the account is used by either other MCP servers or extensions, while **Sign Out** is shown when the account is only used by the MCP server. The sign out action completely removes the account from VS Code, while disconnect only removes access to the account from the MCP server.

### Code Editing

#### Snooze code completions

You can now temporarily pause inline suggestions and next edit suggestions (NES) by using the new **Snooze** feature. This is helpful when you want to focus without distraction from suggestions.

To snooze suggestions, select the Copilot dashboard in the Status Bar, or run the **Snooze Inline Suggestions** command from the Command Palette and select a duration from the dropdown menu. During the snooze period, no inline suggestions or NES will appear.

![Screenshot showing the Copilot dashboard with the snooze button at the bottom.](https://code.visualstudio.com/assets/updates/1_102/nes-snooze.png)

You can also assign a custom keybinding to quickly snooze suggestions for a specific duration by passing the desired duration as an argument to the command. For example:

```json
{
  "key": "...",
  "command": "editor.action.inlineSuggest.snooze",
  "args": 10
}
```

### Editor Experience

#### Settings search suggestions (Preview)

**Setting**: `workbench.settings.showAISearchToggle`

This milestone, we modified the sparkle toggle in the Settings editor, so that it acts as a toggle between the AI and non-AI search results. The AI settings search results are semantically similar results instead of results that are based on string matching. For example, `editor.fontSize` appears as an AI settings search result when you search for "increase text size".

The toggle is enabled only when there are AI results available. We welcome feedback on when the AI settings search did not find an expected setting, and we plan to enable the setting by default over the next iteration.

<video src="https://code.visualstudio.com/assets/updates/1_102/settings-search-toggle-stable.mp4" title="Switching between AI and non-AI results using the AI results toggle in the Settings editor" autoplay loop controls muted></video>


## 0.28 (2025-06-12)

GitHub Copilot updates from [May 2025](https://code.visualstudio.com/updates/v1_101):

### Chat

#### Chat tool sets

VS Code now enables you to define tool sets, either through a proposed API or through the UI. A tool set is a collection of different tools that can be used just like individual tools. Tool sets make it easier to group related tools together, and quickly enable or disable them in agent mode. For instance, the tool set below is for managing GitHub notifications (using the [GitHub MCP server](https://github.com/github/github-mcp-server)).

```json
{
  "gh-news": {
    "tools": [
      "list_notifications",
      "dismiss_notification",
      "get_notification_details",
    ],
    "description": "Manage GH notification",
    "icon": "github-project"
  }
}
```

To create a tool set, run the **Configure Tool Sets** > **Create new tool sets file** command from the Command Palette. You can then select the tools you want to include in the tool set, and provide a description and icon.

To use a tool set in a chat query, reference it by #-mentioning its name, like `#gh-news`. You can also choose it from the tool picker in the chat input box.

![Screenshot of the Chat view showing a query about unread notifications, using the 'gh-news' tool set highlighted in both the chat interface and a JSON configuration file which defines this tool set.](https://code.visualstudio.com/assets/updates/1_101/tool-set-gh.png)

Learn more about [tools sets](https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode#_define-tool-sets) in our documentation.

#### MCP support for prompts

VS Code's Model Context Protocol support now includes prompt support. Prompts can be defined by MCP servers to generate reusable snippets or tasks for the language model. Prompts are accessible as slash `/` commands in chat, in the format `/mcp.servername.promptname`. You can enter plain text or include command output in prompt variables, and we also support completions when servers provide it.

The following example shows how we generate a prompt using AI, save it using the [Gistpad MCP server](https://github.com/lostintangent/gistpad-mcp), and then use it to generate a changelog entry:

<video src="https://code.visualstudio.com/assets/updates/1_101/mcp-prompts.mp4" autoplay loop controls muted></video>

#### MCP support for resources

VS Code's Model Context Protocol support now includes resource support, which includes support for resource templates. It is available in several places:

1. Resources returned from MCP tool calls are available to the model and can be saved in chat, either via a **Save** button or by dragging the resource onto the Explorer view.
1. Resources can be attached as context via the **Add Context...** button in chat, then selecting **MCP Resources...**.
1. You can browse and view resources across servers using the **MCP: Browse Resources** command or for a server by its entry in the **MCP: List Servers** command.

Here's an example of attaching resources from the [Gistpad MCP server](https://github.com/lostintangent/gistpad-mcp) to chat:

<video src="https://code.visualstudio.com/assets/updates/1_101/mcp-resources.mp4" autoplay loop controls muted></video>

#### MCP support for sampling (Experimental)

VS Code's Model Context Protocol support now includes sampling, which allows MCP servers to make requests back to the model. You'll be asked to confirm the first time an MCP server makes a sampling request, and you can configure the models the MCP server has access to as well as see a request log by selecting the server in **MCP: List Servers.**

<video src="https://code.visualstudio.com/assets/updates/1_101/mcp-sampling.mp4" autoplay loop controls muted></video>

Sampling support is still preliminary and we plan to expand and improve it in future iterations.

#### MCP support for auth

VS Code now supports MCP servers that require authentication, allowing you to interact with an MCP server that operates on behalf of your user account for that service.

This feature implements the MCP authorization specification for clients, and supports both:

* [2025-3-26 spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization), where the MCP server behaves as an authorization server.
* [Draft spec](https://modelcontextprotocol.io/specification/draft/basic/authorization), where the MCP server behaves as a resource server (this is expected to be finalized any day now).

If the MCP server implements the draft spec and leverages GitHub or Entra as the auth server, you can manage which MCP servers have access to your account:

![Screenshot of the "Manage Trusted MCP Servers" option in the account menu.](https://code.visualstudio.com/assets/updates/1_101/manage-trusted-mcp.png)

![Screenshot of the "Manage Trusted MCP Servers" Quick Pick.](https://code.visualstudio.com/assets/updates/1_101/manage-trusted-mcp-quick-pick.png)

You can also manage which account that server should use (via the gear button in the previous quick pick):

![Screenshot of the "Account Preference" Quick Pick.](https://code.visualstudio.com/assets/updates/1_101/account-pref-quick-pick.png)

For other MCP servers that rely on dynamic client registration, we include the auth state in the same place as everything else, for example with Linear:

![Screenshot of Linear appearing in the account menu.](https://code.visualstudio.com/assets/updates/1_101/linear-account-menu.png)

There you can also sign out. For these we support not only the code authorization flow but also the device code flow should your authorization server support it.

We have also introduced the command `Authentication: Remove Dynamic Authentication Providers` that allows you to clean up any of these dynamic client registrations. This will throw away the client id issued to VS Code and all data associated with this authentication provider.

Remember, you can use the **MCP: Add Server...** command to add MCP servers. This is the same entry point for servers with authentication.

#### MCP development mode

You can enable _development mode_ for MCP servers by adding a `dev` key to the server config. This is an object with two properties:

* `watch`: A file glob pattern to watch for files change that will restart the MCP server.
* `debug`: Enables you to set up a debugger with the MCP server. Currently, we only support debugging Node.js and Python servers launched with `node` and `python` respectively.

**.vscode/mcp.json**

```diff
{
  "servers": {
    "gistpad": {
      "command": "node",
      "args": ["build/index.js"],
+     "dev": {
+       "watch": "build/**/*.js",
+       "debug": { "type": "node" }
+     },
```

#### Chat UX improvements

We're continuously working to improve the chat user experience in VS Code based on your feedback. One such feedback was that it can be difficult to distinguish between user messages and AI responses in the chat. To address this, we've made the appearance of user messages more distinct.

Undoing previous requests is now also more visible - just hover over a request and select the `X` button to undo that request and any following requests. Or even quicker, use the <kbd>Delete</kbd> keyboard shortcut!

Finally, attachments from the chat input box are now more navigable.

<video src="https://code.visualstudio.com/assets/updates/1_101/new-chat-ui-ux.mp4" title="A video of the new chat UI/UX where a request is removed to undo edits since that point." autoplay loop controls muted></video>

Learn more about using [chat in VS Code](https://code.visualstudio.com/docs/copilot/chat/copilot-chat) in our documentation.

#### Apply edits more efficiently

When editing files, VS Code can take two different approaches: it either rewrites the file top to bottom or it makes multiple, smaller edits. Both approaches differ, for example the former can be slower for large files and intermediate states do often not compile successfully. Because of that the UI adopts and conditionally disables auto-save and squiggles, but only when needed.

We have also aligned the keybindings for the **Keep** and **Undo** commands. Keeping and undoing individual changes is now done with <kbd>Ctrl+Y</kbd> and <kbd>Ctrl+N</kbd>. In the same spirit, we have also aligned the keybinding for keeping and undoing all changes in a file, they are now <kbd>Ctrl+Shift+Y</kbd> and <kbd>Ctrl+Shift+N</kbd>. This is not just for alignment but also removes prior conflicts with popular editing commands (like **Delete All Left**).

#### Implicit context

We've streamlined and simplified the way that adding your current file as context works in chat. Many people found the "eyeball toggle" that we previously had to be a bit clunky. Now, your current file is offered as a suggested context item. Just select the item to add or remove it from chat context. From prompt input field, press `Shift+Tab, Enter` to quickly do this with the keyboard.

Additionally, in agent mode, we include a hint about your current editor. This doesn't include the contents of the file, just the file name and cursor position. The agent can then use the tools it has to read the contents of the file on its own, if it thinks that it's relevant to your query.

<video src="https://code.visualstudio.com/assets/updates/1_101/implicit-context-flow.mp4" title="A video of the current open editor being suggest as implicit context and added as an attachment." autoplay loop controls muted></video>

Learn more about [adding context in chat](https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context) in our documentation.

#### Fix task configuration errors

Configuring tasks and problem matchers can be tricky. Use the **Fix with Github Copilot** action that is offered when there are errors in your task configuration to address them quickly and efficiently.

#### Custom chat modes (Preview)

By default, the chat view supports three built-in chat modes: Ask, Edit and Agent. Each chat mode comes with a set of base instructions that describe how the LLM should handle a request, as well as the list of tools that can be used for that.

You can now define your own custom chat modes, which can be used in the Chat view. Custom chat modes allow you to tailor the behavior of chat and specify which tools are available in that mode. This is particularly useful for specialized workflows or when you want to provide specific instructions to the LLM. For example, you can create a custom chat mode for planning new features, which only has read-only access to your codebase.

To define and use a custom chat mode, follow these steps:

1. Define a custom mode by using the **Chat: Configure Chat Modes** command from the Command Palette.
1. Provide the instructions and available tools for your custom chat mode in the `*.chatprompt.md` file that is created.
1. In the Chat view, select the chat mode from the chat mode dropdown list.
1. Submit your chat prompt and

![Screenshot of the custom chat mode selected in the Chat view.](https://code.visualstudio.com/assets/updates/1_101/custom-chat-mode-view.png)

The following example shows a custom "Planning" chat mode:

```md
---
description: Generate an implementation plan for new features or refactoring existing code.
tools: ['codebase', 'fetch', 'findTestFiles', 'githubRepo', 'search', 'usages']
---
# Planning mode instructions
You are in planning mode. Your task is to generate an implementation plan for a new feature or for refactoring existing code.
Don't make any code edits, just generate a plan.

The plan consists of a Markdown document that describes the implementation plan, including the following sections:

* Overview: A brief description of the feature or refactoring task.
* Requirements: A list of requirements for the feature or refactoring task.
* Implementation Steps: A detailed list of steps to implement the feature or refactoring task.
* Testing: A list of tests that need to be implemented to verify the feature or refactoring task.
```

> **Note**: The feature is work in progress, but please try it out! Please follow the latest progress in VS Code Insiders and let us know what's not working or is missing.

#### Task diagnostic awareness

When the chat agent runs a task, it is now aware of any errors or warnings identified by problem matchers. This diagnostic context allows the chat agent to respond more intelligently to issues as they arise.

#### Terminal cwd context

When agent mode has opened a terminal and shell integration is active, the chat agent is aware of the current working directory (cwd). This enables more accurate and context-aware command support.

#### Floating window improvements

When you move a chat session into a floating window, there are now two new actions available in the title bar:

* Dock the chat back into the VS Code window where it came from
* Start a new chat session in the floating window.

![Screenshot of the Chat view in a floating window, highlighting the Dock and New Chat buttons in the title bar.](https://code.visualstudio.com/assets/updates/1_101/chat-floating.png)

#### Fetch tool confirmation

The fetch tool enables you to pull information from a web page. We have added a warning message to the confirmation to inform you about potential prompt injection.

![Screenshot of the fetch tool with a warning about prompt injection.](https://code.visualstudio.com/assets/updates/1_101/fetch-warning.png)

#### Customize more built-in tools

It's now possible to enable or disable all built-in tools in agent mode or your custom mode. For example, disable `editFiles` to disallow agent mode to edit files directly, or `runCommands` for running terminal commands.

In agent mode, select the **Configure Tools** button to open the tool picker, and select your desired set of tools.

![Screenshot of the tool picker, showing the "editFiles" tool set item cleared.](https://code.visualstudio.com/assets/updates/1_101/built-in-toolsets.png)

Some of the entries in this menu represent tool sets that group multiple tools. For example, we give the model multiple tools to edit or create text files and notebooks, which may also differ by model family, and `editFiles` groups all of these.

#### Send elements to chat (Experimental)

Last milestone, we added a [new experimental feature](https://code.visualstudio.com/updates/v1_100#_select-and-attach-ui-elements-to-chat-experimental) where you could open the Simple Browser and select web elements to add to chat from the embedded browser.

![Screenshot showing the Live Preview extension, highlighting the overlay controls to select web elements from the web page.](https://code.visualstudio.com/assets/updates/1_101/live-preview-select-web-elements.png)

As we continue to improve this feature, we have added support for selecting web elements in the [Live Preview extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.live-server) as well. Check this out by downloading the extension and spinning up a live server from any HTML file.

### Accessibility

#### User action required sound

We’ve added an accessibility signal to indicate when chat requires user action. This is opt-in as we fine tune the sound. You can configure this behavior with `accessibility.signals.chatUserActionRequired`.

#### New code action sounds

We’ve introduced distinct sounds for when a code action is triggered (`accessibility.signals.codeActionTriggered)`) and when it is applied (`accessibility.signals.codeActionApplied`.

#### Agent mode accessibility improvements

We now include rich information about confirmation dialogs in the accessible view, covering past tool runs, the current tool run, and any pending confirmations. This includes the inputs that will be used.

When a confirmation dialog appears in a response, the action’s title is now included in the ARIA label of the corresponding code block, the response’s ARIA label, and the live alert to provide better context for screen reader users.

### Editor Experience

#### Settings search suggestions (Preview)

**Setting**: `workbench.settings.showAISearchToggle:true`

This milestone, we added a toggle to the Settings editor that starts an AI search to find semantically similar results instead of results that are based on string matching. For example, the AI search finds the `editor.fontSize` setting when you search for "increase text size".

To see the toggle, enable the setting and reload VS Code. We are also in the process of identifying and fixing some of the less accurate settings search results, and we welcome feedback on when a natural language query did not find an expected setting.

For the next milestone, we are also considering removing the toggle and changing the experimental setting to one that controls when to directly append the slower AI search results to the end of the list.

<video src="https://code.visualstudio.com/assets/updates/1_101/settings-editor-ai-search.mp4" title="Video showing AI search in the Settings editor that finds the `editor.fontSize` setting when you search 'increase text size'." autoplay loop controls muted></video>

#### Search keyword suggestions (Preview)

**Setting**: `search.searchView.keywordSuggestions`

Last milestone, we introduced [keyword suggestions](https://code.visualstudio.com/updates/v1_100#_semantic-text-search-with-keyword-suggestions-experimental) in the Search view to help you find relevant results faster. We have now significantly improved the performance of the suggestions, so you will see the results ~5x faster than before.

We have also moved the setting from the Chat extension into VS Code core, and renamed it from `github.copilot.chat.search.keywordSuggestions` to `search.searchView.keywordSuggestions`.

#### Semantic search behavior options (Preview)

**Setting**: `search.searchView.semanticSearchBehavior`

With semantic search in the Search view, you can get results based on the meaning of your query rather than just matching text. This is particularly useful if you don't know the exact terms to search for.

By default, semantic search is only run when you explicitly request it. We have now added a setting to control when you want semantic search to be triggered:

* `manual` (default): only run semantic search when triggered manually via the button or keyboard shortcut <kbd>Ctrl+I</kbd>
* `runOnEmpty`: run semantic search automatically when the text search returns no results
* `auto`: automatically run semantic search in parallel with text search for every search query

### Code Editing

#### NES import suggestions

**Setting**: `github.copilot.nextEditSuggestions.fixes`

Last month, we introduced support for next edit suggestions to automatically suggest adding missing import statements for TypeScript and JavaScript. In this release, we've improved the accuracy and reliability of these suggestions and expanded support to Python files as well. Additionally, NES is now enabled by default for all users.

![Screenshot showing NES suggesting an import statement.](https://code.visualstudio.com/assets/updates/1_100/nes-import.png)

#### NES acceptance flow

Accepting next edit suggestions is now more seamless. Once you accept a suggestion, you can continue accepting subsequent suggestions with a single <kbd>Tab</kbd> press, as long as you haven't started typing again. If you start typing, you'll need to press <kbd>Tab</kbd> to first move the cursor to the next suggestion before you can accept it.

### Notebooks

#### Follow mode for agent cell execution

**Setting**: `github.copilot.chat.notebook.followCellExecution.enabled`

With follow mode, the Notebook view will automatically scroll to the cell that is currently being executed by the agent. Use the `github.copilot.chat.notebook.followCellExecution.enabled` setting to enable or disable follow mode for agent cell execution in Jupyter Notebooks.

Once the agent has used the run cell tool, the Notebook toolbar is updated with a pin icon, indicating the state of follow mode. You can toggle the behavior mid agent response without changing the base setting value, allowing you to follow the work of the agent in real-time, and toggle it off when you want to review a specific portion of code while the agent continues to iterate. When you wish to follow again, simply toggle the mode, and join at the next execution.

<video src="https://code.visualstudio.com/assets/updates/1_101/notebook-follow-mode.mp4" title="Video that shows the AI executing cells in a notebook with follow mode enabled. When the cell is run, the notebook scrolls to reveal it." autoplay loop controls muted></video>

#### Notebook tools for agent mode

##### Configure notebook

The [Jupyter extension](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter) contributes tools for configuring the Kernel of a Jupyter Notebook. This tool ensures that a Kernel is selected and is ready for use in the Notebook.
This involves walking you through the process of creating a Virtual Environment if required (the recommended approach), or prompting you to select an existing Python environment.

This tool ensures the LLM can perform operations on the Notebook such as running cells with minimal user interaction, thereby improving the overall user experience in agent mode.

<video src="https://code.visualstudio.com/assets/updates/1_101/notebook-tools.mp4" title="Video that shows the AI configuring the Python environment, installing dependencies and finally running notebook cells." autoplay loop controls muted></video>

##### Long running agent workflows

The agent has access to an internal Notebook Summary tool to help keep it on track with an accurate context. That summary is also included when summarizing the conversation history when the context gets too large to keep the agent going through complex operations.

##### Cell preview in run confirmation

A snippet of the code is shown from a notebook cell when the agent requests confirmation to run that cell. The cell links in the Chat view now also enable you to directly navigate to cells in the notebook.

<video src="https://code.visualstudio.com/assets/updates/1_101/run-cell-confirmation.mp4" title="Video showing the AI asking to run a cell including a link to the cell and a preview of its content." autoplay loop controls muted></video>

### Source Control

#### Copilot coding agent integration

With Copilot coding agent, GitHub Copilot can work independently in the background to complete tasks, just like a human developer. We have expanded the GitHub Pull Requests extension to make it easier to assign and track tasks for the agent from within VS Code.

We have added the following features to the extension:

* **Assign to Copilot**: assign a pull request or issue to Copilot from the issue or PR view in VS Code
* **Copilot on My Behalf** PR query: quickly see all pull requests that Copilot is working on for you.
* **PR view**: see the status of the Copilot coding agent and open the session details in the browser.

#### Add history item to chat context

You can now add a source control history item as context to a chat request. This can be useful when you want to provide the contents of a specific commit or pull request as context for your chat prompt.

![Screenshot of the Chat view input box that has a history item added as context.](https://code.visualstudio.com/assets/updates/1_101/chat-context-source-control-commit.png)

To add a history item to chat, use **Add Context** > **Source Control** from the Chat view and then choose a particular history item. Alternatively, right-click the history item in the source control graph and then select **Copilot** > **Add History Item to Chat** from the context menu.

## 0.27 (2025-05-07)

GitHub Copilot updates from [April 2025](https://code.visualstudio.com/updates/v1_100):

### Chat

#### Prompt and instructions files

You can tailor your AI experience in VS Code to your specific coding practices and technology stack by using Markdown-based instructions and prompt files. We've aligned the implementation and usage of these two related concepts, however they each have distinct purposes.

##### Instructions files

**Setting**: `chat.instructionsFilesLocations`

Instructions files (also known as custom instructions or rules) provide a way to describe common guidelines and context for the AI model in a Markdown file, such as code style rules, or which frameworks to use. Instructions files are not standalone chat requests, but rather provide context that you can apply to a chat request.

Instructions files use the `.instructions.md` file suffix. They can be located in your user data folder or in the workspace. The `chat.instructionsFilesLocations` setting lists the folders that contain instruction files.

You can manually attach instructions to a specific chat request, or they can be automatically added:

* To add them manually, use the **Add Context** button in the Chat view, and then select **Instructions...**.
  Alternatively use the **Chat: Attach Instructions...** command from the Command Palette. This brings up a picker that lets you select existing instructions files or create a new one to attach.

* To automatically add instructions to a prompt, add the `applyTo` Front Matter header to the instructions file to indicate which files the instructions apply to. If a chat request contains a file that matches the given glob pattern, the instructions file is automatically attached.

  The following example provides instructions for TypeScript files (`applyTo: '**/*.ts'`):

  ````md
  ---
  applyTo: '**/*.ts'
  ---
  Place curly braces on separate lines for multi-line blocks:
  if (condition)
  {
    doSomething();
  }
  else
  {
    doSomethingElse();
  }
  ````

You can create instruction files with the **Chat: New Instructions File...** command. Moreover, the files created in the _user data_ folder can be automatically synchronized across multiple user machines through the Settings Sync service. Make sure to check the **Prompts and Instructions** option in the **Backup and Sync Settings...** dialog.

Learn more about [instruction files](https://code.visualstudio.com/docs/copilot/copilot-customization#_instruction-files) in our documentation.

##### Prompt files

**Setting**: `chat.promptFilesLocations`

Prompt files describe a standalone, complete chat request, including the prompt text, chat mode, and tools to use. Prompt files are useful for creating reusable chat requests for common tasks. For example, you can add a prompt file for creating a front-end component, or to perform a security review.

Prompt files use the `.prompt.md` file suffix. They can be located in your user data folder or in the workspace. The `chat.promptFilesLocations` setting lists the folder where prompt files are looked for.

There are several ways to run a prompt file:

* Type `/` in the chat input field, followed by the prompt file name.
  ![Screenshot that shows running a prompt in the Chat view with a slash command.](https://code.visualstudio.com/assets/updates/1_100/run-prompt-as-slash-command.png)

* Open the prompt file in an editor and press the 'Play' button in the editor tool bar. This enables you to quickly iterate on the prompt and run it without having to switch back to the Chat view.
  ![Screenshot that shows running a prompt by using the play button in the editor.](https://code.visualstudio.com/assets/updates/1_100/run-prompt-from-play-button.png)

* Use the **Chat: Run Prompt File...** command from the Command Palette.

Prompt files can have the following Front Matter metadata headers to indicate how they should be run:

* `mode`: the chat mode to use when invoking the prompt (`ask`, `edit`, or `agent` mode).
* `tools`: if the `mode` is `agent`, the list of tools that are available for the prompt.

The following example shows a prompt file for generating release notes, that runs in agent mode, and can use a set of tools:

```md
---
mode: 'agent'
tools: ['getCurrentMilestone', 'getReleaseFeatures', 'file_search', 'semantic_search', 'read_file', 'insert_edit_into_file', 'create_file', 'replace_string_in_file', 'fetch_webpage', 'vscode_search_extensions_internal']
---
Generate release notes for the features I worked in the current release and update them in the release notes file. Use [release notes writing instructions file](.github/instructions/release-notes-writing.instructions.md) as a guide.
```

To create a prompt file, use the **Chat: New Prompt File...** command from the Command Palette.

Learn more about [prompt files](https://code.visualstudio.com/docs/copilot/copilot-customization#_prompt-files-experimental) in our documentation.

##### Improvements and notes

* Instructions and prompt files now have their own language IDs, configurable in the _language mode_ dialog for any file open document ("Prompt" and "Instructions" respectively). This allows, for instance, using untitled documents as temporary prompt files before saving them as files to disk.
* We renamed the **Chat: Use Prompt** command to **Chat: Run Prompt**. Furthermore, the command now runs the selected prompt _immediately_, as opposed to attaching it as chat context as it did before.
* Both file types now also support the `description` metadata in their headers, providing a common place for short and user-friendly prompt summaries. In the future, this header is planned to be used along with the `applyTo` header as the rule that determines if the file needs to be auto-included with chat requests (for example, `description: 'Code style rules for front-end components written in TypeScript.'`)

#### Faster agent mode edits with GPT 4.1

We've implemented support for OpenAI's apply patch editing format when using GPT 4.1 and o4-mini in agent mode. This means that you benefit from significantly faster edits, especially in large files. The tool is enabled by default in VS Code Insiders and will be progressively rolled out in VS Code Stable.

#### Use GPT 4.1 as the base model

When you're using chat in VS Code, the base model is now updated to GPT-4.1. You can still use the model switcher in the Chat view to change to another model.

#### Search code of a GitHub repository with the `#githubRepo` tool

Imagine you need to ask a question about a GitHub repository, but you don't have it open in your editor. You can now use the `#githubRepo` tool to search for code snippets in any GitHub repository that you have access to. This tool takes a `USER/REPO` and is a great way to quickly ask about a project you don't currently have open in VS Code.

You can also use [custom instructions](https://code.visualstudio.com/docs/copilot/copilot-customization#_custom-instructions) to hint to Copilot when and how to use this tool:

```md
---
applyTo: '**'
---
Use the `#githubRepo` tool with `microsoft/vscode` to find relevant code snippets in the VS Code codebase.
Use the `#githubRepo` tool with `microsoft/typescript` to answer questions about how TypeScript is implemented.
```

![Screenshot showing using the #githubRepo tool in agent mode with hints from instructions files.](https://code.visualstudio.com/assets/updates/1_100/github-repo-tool-example.png)

If you want to ask about the repo you are currently working on, you can just use the [`#codebase` tool](https://code.visualstudio.com/docs/copilot/reference/workspace-context#_making-copilot-chat-an-expert-in-your-workspace).

Also, the `#githubRepo` tool is only for searching for relevant code snippets. The [GitHub MCP server](https://github.com/github/github-mcp-server?tab=readme-ov-file#github-mcp-server) provides tools for working with GitHub issues and pull requests. Learn more about [adding MCP servers in VS Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers#_add-an-mcp-server).

#### Find Marketplace extensions with the extensions tool

Use `#extensions` tool to find extensions from the Marketplace. This tool is available in both chat and agent mode and is picked up automatically but you can also reference it explicitly via `#extensions` with your query. The tool returns a list of extensions that match your query, and you can install them directly from the results.

<video src="https://code.visualstudio.com/assets/updates/1_100/extensions-agent-tool.mp4" title="Video that shows using the extensions tool to display popular Java extensions." autoplay loop controls muted></video>

#### Improvements to the web page fetch tool

Last month, we introduced the `#fetch` tool, which allows you to fetch the contents of a web page right from chat to include as context for your prompt. If you missed that release note, check out [the initial release of the fetch tool](v1_99.md#fetch-tool) release note and examples.

This iteration, we have made several big changes to the tool including:

* **Entire page as context**: We now add the entire page as context, rather than a subset. With larger context windows, we have the ability to give the model the entire page. For example, it's now possible to ask summarization questions that require as much of the page as possible. If you _do_ manage to fill up the context window, the fetch tool is smart enough to exclude the less relevant sections of the page. That way, you don't exceed the context window limit, while still keeping the important parts.
* **A standardized page format (Markdown)**: Previously, we formatted fetched webpages in a custom hierarchical format that did the job, but was sometimes hard to reason with because of its custom nature. We now convert fetched webpages into Markdown, a standardized language. This improves the reliability of the *relevancy detection* and is a format that most language models know deeply, so they can reason with it more easily.

We'd love to hear how you use the fetch tool and if there are any capabilities you'd like to see from it!

#### Chat input improvements

We have made several improvements to the chat input box:

* Attachments: when you reference context in the prompt text with `#`, they now also appear as an attachment pill. This makes it simpler to understand what's being sent to the language model.
* Context picker: we streamlined the context picker to make it simpler to pick files, folders, and other attachment types.
* Done button: we heard your feedback about the "Done"-button and we removed it! No more confusion about unexpected session endings. Now, we only start a new session when you create a new chat (<kbd>Ctrl+L</kbd>).

#### Chat mode keyboard shortcuts

The keyboard shortcut <kbd>Ctrl+Alt+I</kbd> still just opens the Chat view, but the <kbd>Ctrl+Shift+I</kbd> shortcut now opens the Chat view and switches to [agent mode](vscode://GitHub.Copilot-Chat/chat?mode=agent). If you'd like to set up keyboard shortcuts for other chat modes, there is a command for each mode:

* `workbench.action.chat.openAgent`
* `workbench.action.chat.openEdit`
* `workbench.action.chat.openAsk`

#### Autofix diagnostics from agent mode edits

**Setting**: `github.copilot.chat.agent.autoFix`

If a file edit in agent mode introduces new errors, agent mode can now detect them, and automatically propose a follow-up edit. You can disable this behavior with `github.copilot.chat.agent.autoFix`.

#### Handling of undo and manual edits in agent mode

Previously, making manual edits during an agent mode session could confuse the model. Now, the agent is prompted about your changes, and should re-read files when necessary before editing files that might have changed.

#### Conversation history summarized and optimized for prompt caching

We've made some changes to how our agent mode prompt is built to optimize for prompt caching. Prompt caching is a way to speed up model responses by maintaining a stable prefix for the prompt. The next request is able to resume from that prefix, and the result is that each request should be a bit faster. This is especially effective in a repetitive series of requests with large context, like you typically have in agent mode.

When your conversation gets long, or your context gets very large, you might see a "Summarized conversation history" message in your agent mode session:

![Screenshot showing a summarized conversation message in the Chat view.](https://code.visualstudio.com/assets/updates/1_100/summarized-conversation.png)

Instead of keeping the whole conversation as a FIFO, breaking the cache, we compress the conversation so far into a summary of the most important information and the current state of your task. This keeps the prompt prefix stable, and your responses fast.

#### MCP support for Streamable HTTP

This release adds support for the new Streamable HTTP transport for Model Context Protocol servers. Streamable HTTP servers are configured just like existing SSE servers, and our implementation is backwards-compatible with SSE servers:

```json
{
  "servers": {
    "my-mcp-server": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Learn more about [MCP support in VS Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

#### MCP support for image output

We now support MCP servers that generate images as part of their tool output.

Note that not all language models support reading images from tool output. For example, although GPT-4.1 has vision capability, it does not currently support reading images from tools.

#### Enhanced input, output, and progress from MCP servers

We have enhanced the UI that shows MCP server tool input and output, and have also added support for MCP's new progress messages.

<video src="https://code.visualstudio.com/assets/updates/1_100/mcp-confirm.mp4" autoplay loop controls muted></video>
_Theme: [Codesong](https://marketplace.visualstudio.com/items?itemName=connor4312.codesong) (preview on [vscode.dev](https://vscode.dev/editor/theme/connor4312.codesong))_

#### MCP config generation uses inputs

To help keep your secrets secure, AI-assisted configurations generated by the **MCP: Add Server** command now generate `inputs` for any secrets, rather than inlining them into the resulting configuration.

#### Inline chat V2 (Preview)

**Setting**: `chat.inlineChat.enableV2:true`

We have been working on a revamped version of inline chat <kbd>Ctrl+I</kbd>. Its theme is still "bringing chat into code", but behind the scenes it uses the same logic as chat edits. This means better use of the available context and a better code-editing strategy. You can enable inline chat v2 via `chat.inlineChat.enableV2:true`

Further, there is now a more lightweight UX that can optionally be enabled. With the `chat.inlineChat.hideOnRequest:true` setting, inline chat hides as soon as a request is made. It then minimizes into the chat-editing overlay, which enables accepting or discarding changes, or restoring the inline chat control.

<video src="https://code.visualstudio.com/assets/updates/1_100/inlinechat2.mp4" title="Video that shows inline chat v2 and hide-on-request in action." autoplay loop controls muted></video>

#### Select and attach UI elements to chat (Experimental)

**Setting**: `chat.sendElementsToChat.enabled`

While you're developing a web application, you might want to ask chat about specific UI elements of a web page. You can now use the built-in Simple Browser to attach UI elements as context to chat.

After opening any locally-hosted site via the built-in Simple Browser (launch it with the **Simple Browser: Show** command), a new toolbar is now shown where you can select **Start** to select any element in the site that you want. This attaches a screenshot of the selected element, and the HTML and CSS of the element.

<video src="https://code.visualstudio.com/assets/updates/1_100/ui-element-selection-demo.mp4" title="Video showing the full flow of the UI element selection experimental feature. In the demo, we attach a hero from a webpage and ask chat to add a background image to that hero." autoplay loop controls muted></video>

Configure what is attached to chat with:

* `chat.sendElementsToChat.attachCSS`: enable or disable attaching the associated CSS
* `chat.sendElementsToChat.attachImages`: enable or disable attaching the screenshot of the selected element

This experimental feature is enabled by default for all Simple Browsers, but can be disabled with `chat.sendElementsToChat.enabled`.

#### Create and launch tasks in agent mode (Experimental)

**Setting**: `chat.newWorkspaceCreation.enabled`

In the previous release, we introduced the `chat.newWorkspaceCreation.enabled` (Experimental) setting to enable workspace creation with agent mode.

Now, at the end of this creation flow, you are prompted to create and run a task for launching your app or project. This streamlines the project launch process and enables easy task reuse.

### Configure VS Code

#### Prevent installation of Copilot Chat pre-release versions in VS Code stable

VS Code now prevents the installation of the pre-release version of the Copilot Chat extension in VS Code Stable. This helps avoid situations where you inadvertently install the Copilot Chat pre-release version and get stuck in a broken state. This means that you can only install the Copilot Chat extension pre-release version in the Insiders build of VS Code.

#### Semantic text search with keyword suggestions (Experimental)

**Setting**: `chat.search.keywordSuggestions:true`

Semantic text search now supports AI-powered keyword suggestions. By enabling this feature, you will start seeing relevant references or definitions that might help you find the code you are looking for.

<video src="https://code.visualstudio.com/assets/updates/1_100/ai-keywords.mp4" title="Video that shows AI-powered keyword suggestions in Visual Studio Code." autoplay loop controls muted></video>


### Code Editing

#### New Next Edit Suggestions (NES) model

**Setting**: `github.copilot.nextEditSuggestions.enabled`

We're excited to introduce a new model powering NES, designed to provide faster and more contextually relevant code recommendations. This updated model offers improved performance, delivering suggestions with reduced latency, and offering suggestions that are less intrusive and align more closely with your recent edits. This update is part of our ongoing commitment to refining AI-assisted development tools within Visual Studio Code.

#### Import suggestions

**Setting**: `github.copilot.nextEditSuggestions.fixes:true`

Next Edit Suggestions (NES) can now automatically suggest adding missing import statements in JavaScript and TypeScript files. Enable this feature by setting `github.copilot.nextEditSuggestions.fixes:true`. We plan to further enhance this capability by supporting imports from additional languages in future updates.

![Screenshot showing NES suggesting an import statement.](https://code.visualstudio.com/assets/updates/1_100/nes-import.png)

#### Generate alt text in HTML or Markdown

You can now generate or update existing alt text in HTML and Markdown files. Navigate to any line containing an embedded image and trigger the quick fix via <kbd>Ctrl+.</kbd> or by selecting the lightbulb icon.

![Screenshot that shows generating alt text for an image html element.](https://code.visualstudio.com/assets/updates/1_100/generate-alt-text.png)

### Notebooks

#### Drag and drop cell outputs to chat

To enhance existing support for cell output usage within chat, outputs are now able to be dragged into the Chat view for a seamless attachment experience. Currently, only image and textual outputs are supported. Outputs with an image mime type are directly draggable, however to avoid clashing with text selection, textual outputs require holding the <kbd>Alt</kbd> modifier key to enable dragging. We are exploring UX improvements in the coming releases.

<video src="https://code.visualstudio.com/assets/updates/1_100/output-dnd.mp4" title="Video that shows multiple cell outputs being attached as chat context via drag and drop." autoplay loop controls muted></video>

#### Notebook tools for agent mode

##### Run cell

Chat now has an LLM tool to run notebook cells, which allows the agent to perform updates based on cell run results or perform its own data exploration as it builds out a notebook.

<video src="https://code.visualstudio.com/assets/updates/1_100/agent-notebook-run-edit-loop.mp4" title="Video that shows copilot running notebook cells, making updates based on an error, and retrying those cells." autoplay loop controls muted></video>

##### Get kernel state

The agent can find out which cells have been executed in the current kernel session, and read the active variables by using the Kernel State tool.

##### List/Install packages

The Jupyter extension contributes tools for listing and installing packages into the environment that's being used as the notebook's kernel. The operation is delegated to the Python Environments extension if available; otherwise, it attempts to use the pip package manager.


## 0.26 (2025-04-02)

GitHub Copilot updates from [March 2025](https://code.visualstudio.com/updates/v1_99):

### Accessibility

#### Chat agent mode improvements

You are now notified when manual action is required during a tool invocation, such as "Run command in terminal." This information is also included in the ARIA label for the relevant chat response, enhancing accessibility for screen reader users.

Additionally, a new accessibility help dialog is available in [agent mode](https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode), explaining what users can expect from the feature and how to navigate it effectively.

#### Accessibility Signals for chat edit actions

VS Code now provides auditory signals when you keep or undo AI-generated edits. These signals are configurable via `accessibility.signals.editsKept` and `accessibility.signals.editsUndone`.

### Configure the editor

#### Unified chat experience

We have streamlined the chat experience in VS Code into a single unified Chat view. Instead of having to move between separate views and lose the context of a conversation, you can now easily switch between the different chat modes.

![Screenshot that shows the chat mode picker in the Chat view.](https://code.visualstudio.com/assets/updates/1_99/chat-modes.png)

Depending on your scenario, use either of these modes, and freely move mid-conversation:

- Ask mode: optimized for asking questions about your codebase and brainstorming ideas.
- Edit mode: optimized for making edits across multiple files in your codebase.
- Agent mode: optimized for an autonomous coding flow, combining code edits and tool invocations.

Get more details about the [unified chat view](#unified-chat-view).

#### Faster workspace searches with instant indexing

[Remote workspace indexes](https://code.visualstudio.com/docs/copilot/reference/workspace-context#remote-index) accelerate searching large codebases for relevant code snippets that AI uses while answering questions and generating edits. These remote indexes are especially useful for large codebases with tens or even hundreds of thousands of files.

Previously, you'd have to press a button or run a command to build and start using a remote workspace index. With our new instant indexing support, we now automatically build the remote workspace index when you first try to ask a `#codebase`/`@workspace` question. In most cases, this remote index can be built in a few seconds. Once built, any codebase searches that you or anyone else working with that repo in VS Code makes will automatically use the remote index.

Keep in mind that remote workspaces indexes are currently only available for code stored on GitHub. To use a remote workspace index, make sure your workspace contains a git project with a GitHub remote. You can use the [Copilot status menu](#copilot-status-menu) to see the type of index currently being used:

![Screenshot that shows the workspace index status in the Copilot Status Bar menu.](https://code.visualstudio.com/assets/updates/1_99/copilot-workspace-index-remote.png)

To manage load, we are slowly rolling out instant indexing over the next few weeks, so you may not see it right away. You can still run the `GitHub Copilot: Build remote index command` command to start using a remote index when instant indexing is not yet enabled for you.

#### Copilot status menu

The Copilot status menu, accessible from the Status Bar, is now enabled for all users. This milestone we added some new features to it:

- View [workspace index](https://code.visualstudio.com/docs/copilot/reference/workspace-context) status information at any time.

    ![Screenshot that shows the workspace index status of a workspace in the Copilot menu.](https://code.visualstudio.com/assets/updates/1_99/copilot-worksspace-index-local-status.png)

- View if code completions are enabled for the active editor.

    A new icon reflects the status, so that you can quickly see if code completions are enabled or not.

    ![Screenshot that shows the Copilot status icon when completions is disabled.](https://code.visualstudio.com/assets/updates/1_99/copilot-disabled-status.png)

- Enable or disable [code completions and NES](https://code.visualstudio.com/docs/copilot/ai-powered-suggestions).

#### Out of the box Copilot setup (Experimental)

**Setting**: `chat.setupFromDialog`

We are shipping an experimental feature to show functional chat experiences out of the box. This includes the Chat view, editor/terminal inline chat, and quick chat. The first time you send a chat request, we will guide you through signing in and signing up for Copilot Free.

<video src="https://code.visualstudio.com/assets/updates/1_99/copilot-ootb.mp4" title="Video that shows Copilot out of the box." autoplay loop controls muted></video>

If you want to see this experience for yourself, enable the `chat.setupFromDialog` setting.

#### Chat prerelease channel mismatch

If you have the prerelease version of the Copilot Chat extension installed in VS Code Stable, a new welcome screen will inform you that this configuration is not supported. Due to rapid development of chat features, the extension will not activate in VS Code Stable.

The welcome screen provides options to either switch to the release version of the extension or download [VS Code Insiders](https://code.visualstudio.com/insiders/).

![Screenshot that shows the welcome view of chat, indicating that the pre-release version of the extension is not supported in VS Code stable. A button is shown to switch to the release version, and a secondary link is shown to switch to VS Code Insiders.](https://code.visualstudio.com/assets/updates/1_99/welcome-pre-release.png)

#### Semantic text search improvements (Experimental)

**Setting**: `github.copilot.chat.search.semanticTextResults:true`

AI-powered semantic text search is now enabled by default in the Search view. Use the `<kbd>Ctrl+I</kbd>` keyboard shortcut to trigger a semantic search, which shows you the most relevant results based on your query, on top of the regular search results.

<video src="https://code.visualstudio.com/assets/updates/1_99/semantic-search.mp4" title="Video that shows semantic search improvements in Visual Studio Code." autoplay loop controls muted></video>

You can also reference the semantic search results in your chat prompt by using the `#searchResults` tool. This allows you to ask the LLM to summarize or explain the results, or even generate code based on them.

<video src="https://code.visualstudio.com/assets/updates/1_99/semantic-search-results.mp4" title="Video that shows using search results in chat view." autoplay loop controls muted></video>

### Code Editing

#### Agent mode is available in VS Code Stable

**Setting**: `chat.agent.enabled:true`

We're happy to announce that agent mode is available in VS Code Stable! Enable it by setting `chat.agent.enabled:true`. Enabling the setting will no longer be needed in the following weeks, as we roll out enablement by default to all users.

Check out the [agent mode documentation](https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode) or select agent mode from the chat mode picker in the Chat view.

![Screenshot that shows the Chat view, highlighting agent mode selected in the chat mode picker.](https://code.visualstudio.com/assets/updates/1_99/copilot-edits-agent-mode.png)

#### AI edits improvements

We have done some smaller tweaks when generating edits with AI:

* Mute diagnostics events outside the editor while rewriting a file with AI edits. Previously, we already disabled squiggles in this scenario. These changes reduce flicker in the Problems panel and also ensure that we don't issue requests for the quick fix code actions.

* We now explicitly save a file when you decide to keep the AI edits.

#### Next Edit Suggestions general availability

**Setting**: `github.copilot.nextEditSuggestions.enabled:true`

We're happy to announce the general availability of Next Edit Suggestions (NES)! In addition, we've also made several improvements to the overall user experience of NES:

* Make edit suggestions more compact, less interfering with surrounding code, and easier to read at a glance.
* Updates to the gutter indicator to make sure that all suggestions are more easily noticeable.

<video src="https://code.visualstudio.com/assets/updates/1_99/next-edit-suggestion.mp4" title="Video that shows NES suggesting edits based on the recent changes due by the user." autoplay loop controls muted></video>

#### Improved edit mode

**Setting**: `chat.edits2.enabled:true`

We're making a change to the way [edit mode in chat](https://code.visualstudio.com/docs/copilot/chat/copilot-edits) operates. The new edit mode uses the same approach as agent mode, where it lets the model call a tool to make edits to files. An upside to this alignment is that it enables you to switch seamlessly between all three modes, while providing a huge simplification to how these modes work under the hood.

A downside is that this means that the new mode only works with the same reduced set of models that agent mode works with, namely models that support tool calling and have been tested to be sure that we can have a good experience when tools are involved. You may notice models like `o3-mini` and `Claude 3.7 (Thinking)` missing from the list in edit mode. If you'd like to keep using those models for editing, disable the `chat.edits2.enabled` setting to revert to the previous edit mode. You'll be asked to clear the session when switching modes.

We've learned that prompting to get consistent results across different models is harder when using tools, but we are working on getting these models lit up for edit (and agent) modes.

This setting will be enabled gradually for users in VS Code Stable.

#### Inline suggestion syntax highlighting

**Setting**: `editor.inlineSuggest.syntaxHighlightingEnabled`

With this update, syntax highlighting for inline suggestions is now enabled by default. Notice in the following screenshot that the code suggestion has syntax coloring applied to it.

![Screenshot of the editor, showing that syntax highlighting is enabled for ghost text.](https://code.visualstudio.com/assets/updates/1_99/inlineSuggestionHighlightingEnabled.png)

If you prefer inline suggestions without syntax highlighting, you can disable it with `editor.inlineSuggest.syntaxHighlightingEnabled:false`.

![Screenshot of the editor showing that highlighting for ghost text is turned off.](https://code.visualstudio.com/assets/updates/1_99/inlineSuggestionHighlightingDisabled.png)

### Chat

#### Model Context Protocol server support

This release supports [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) servers in agent mode. Once configured in VS Code, MCP servers provide tools for agent mode to interact with other systems, such as databases, cloud platforms, search engines, or any 3rd party API.

MCP servers can be configured under the `mcp` section in your user, remote, or `.code-workspace` settings, or in `.vscode/mcp.json` in your workspace. The configuration supports input variables to avoid hard-coding secrets and constants. For example, you can use `${env:API_KEY}` to reference an environment variable or `${input:ENDPOINT}` to prompt for a value when the server is started.

You can use the **MCP: Add Server** command to quickly set up an MCP server from a command line invocation, or use an AI-assisted setup from an MCP server published to Docker, npm, or PyPI.

When a new MCP server is added, a refresh action is shown in the Chat view, which can be used to start the server and discover the tools. Afterwards, servers are started on-demand to save resources.

<video src="https://code.visualstudio.com/assets/updates/1_99/mcp.mp4" title="Video that shows using a Github MCP tool in chat." autoplay loop controls muted></video>
_Theme: [Codesong](https://marketplace.visualstudio.com/items?itemName=connor4312.codesong) (preview on [vscode.dev](https://vscode.dev/editor/theme/connor4312.codesong))_

If you've already been using MCP servers in other applications such as Claude Desktop, VS Code will discover them and offer to run them for you. This behavior can be toggled with the setting `chat.mcp.discovery.enabled`.

You can see the list of MCP servers and their current status using the **MCP: List Servers** command, and pick the tools available for use in chat by using the **Select Tools** button in agent mode.

You can read more about how to install and use MCP servers in [our documentation](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

#### Making agent mode available in VS Code Stable

We're happy to announce that agent mode is available in VS Code Stable! Enable it by setting `chat.agent.enabled:true`. Enabling the setting will no longer be needed in the following weeks, as we roll out enablement by default to all users.

Check out the [agent mode documentation](https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode) or select agent mode from the chat mode picker in the Chat view.

![Screenshot that shows the Chat view, highlighting agent mode selected in the chat mode picker.](https://code.visualstudio.com/assets/updates/1_99/copilot-edits-agent-mode.png)

#### Agent mode tools

This milestone, we have added several new built-in tools to agent mode.

##### Thinking tool

**Setting**: `github.copilot.chat.agent.thinkingTool:true`.

Inspired by [Anthropic's research](https://www.anthropic.com/engineering/claude-think-tool), we've added support for a thinking tool in agent mode that can be used to give any model the opportunity to think between tool calls. This improves our agent's performance on complex tasks in-product and on the [SWE-bench](https://www.swebench.com/) eval.

##### Fetch tool

Use the `#fetch` tool for including content from a publicly accessible webpage in your prompt. For instance, if you wanted to include the latest documentation on a topic like [MCP](#model-context-protocol-server-support), you can ask to fetch [the full documentation](https://modelcontextprotocol.io/llms-full.txt) (which is conveniently ready for an LLM to consume) and use that in a prompt. Here's a video of what that might look like:

<video src="https://code.visualstudio.com/assets/updates/1_99/fetch.mp4" title="Video that shows using the fetch tool to fetch the model context protocol documentation." autoplay loop controls muted></video>

In agent mode, this tool is picked up automatically but you can also reference it explicitly in the other modes via `#fetch`, along with the URL you are looking to fetch.

This tool works by rendering the webpage in a headless browser window in which the data of that page is cached locally, so you can freely ask the model to fetch the contents over and over again without the overhead of re-rendering.

Let us know how you use the `#fetch` tool, and what features you'd like to see from it!

**Fetch tool limitations:**

* Currently, JavaScript is disabled in this browser window. The tool will not be able to acquire much context if the website depends entirely on JavaScript to render content. This is a limitation we are considering changing and likely will change to allow JavaScript.
* Due to the headless nature, we are unable to fetch pages that are behind authentication, as this headless browser exists in a different browser context than the browser you use. Instead, consider using [MCP](#model-context-protocol-server-support) to bring in an MCP server that is purpose-built for that target, or a generic browser MCP server such as the [Playwright MCP server](https://github.com/microsoft/playwright-mcp).

##### Usages tool

The `#usages` tool is a combination of "Find All References", "Find Implementation", and "Go to Definition". This tool can help chat to learn more about a function, class, or interface. For instance, chat can use this tool to look for sample implementations of an interface or to find all places that need to be changed when making a refactoring.

In agent mode this tool will be picked up automatically but you can also reference it explicitly via `#usages`

#### Create a new workspace with agent mode (Experimental)

**Setting**: `github.copilot.chat.newWorkspaceCreation.enabled`

You can now scaffold a new VS Code workspace in [agent mode](https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode). Whether you’re setting up a VS Code extension, an MCP server, or other development environments, agent mode helps you to initialize, configure, and launch these projects with the necessary dependencies and settings.

<video src="https://code.visualstudio.com/assets/updates/1_99/new-workspace-demo.mp4" title="Video showing creation of a new MCP server to fetch top N stories from hacker news using Agent mode." autoplay loop controls muted></video>

#### VS Code extension tools in agent mode

Several months ago, we finalized our extension API for [language model tools](https://code.visualstudio.com/api/extension-guides/tools#create-a-language-model-tool) contributed by VS Code extensions. Now, you can use these tools in agent mode.

Any tool contributed to this API which sets `toolReferenceName` and `canBeReferencedInPrompt` in its configuration is automatically available in agent mode.

By contributing a tool in an extension, it has access to the full VS Code extension APIs, and can be easily installed via the Extension Marketplace.

Similar to tools from MCP servers, you can enable and disable these with the **Select Tools** button in agent mode. See our [language model tools extension guide](https://code.visualstudio.com/api/extension-guides/tools#create-a-language-model-tool) to build your own!

#### Agent mode tool approvals

As part of completing the tasks for a user prompt, agent mode can run tools and terminal commands. This is powerful but potentially comes with risks. Therefore, you need to approve the use of tools and terminal commands in agent mode.

To optimize this experience, you can now remember that approval on a session, workspace, or application level. This is not currently enabled for the terminal tool, but we plan to develop an approval system for the terminal in future releases.

![Screenshot that shows the agent mode tool Continue button dropdown options for remembering approval.](https://code.visualstudio.com/assets/updates/1_99/chat-tool-approval.png)

In case you want to auto-approve _all_ tools, you can now use the experimental `chat.tools.autoApprove:true` setting. This will auto-approve all tools, and VS Code will not ask for confirmation when a language model wishes to run tools. Bear in mind that with this setting enabled, you will not have the opportunity to cancel potentially destructive actions a model wants to take.

We plan to expand this setting with more granular capabilities in the future.

#### Agent evaluation on SWE-bench

VS Code's agent achieves a pass rate of 56.0% on `swebench-verified` with Claude 3.7 Sonnet, following Anthropic's [research](https://www.anthropic.com/engineering/swe-bench-sonnet) on configuring agents to execute without user input in the SWE-bench environment. Our experiments have translated into shipping improved prompts, tool descriptions and tool design for agent mode, including new tools for file edits that are in-distribution for Claude 3.5 and 3.7 Sonnet models.

#### Unified Chat view

For the past several months, we've had a "Chat" view for asking questions to the language model, and a "Copilot Edits" view for an AI-powered code editing session. This month, we aim to streamline the chat-based experience by merging the two views into one Chat view. In the Chat view, you'll see a dropdown with three modes:

![Screenshot that shows the chat mode picker in the Chat view.](https://code.visualstudio.com/assets/updates/1_99/chat-modes.png)

- **[Ask](https://code.visualstudio.com/docs/copilot/chat/chat-ask-mode)**: This is the same as the previous Chat view. Ask questions about your workspace or coding in general, using any model. Use `@` to invoke built-in chat participants or from installed [extensions](https://marketplace.visualstudio.com/search?term=chat-participant&target=VSCode&category=All%20categories&sortBy=Relevance). Use `#` to attach any kind of context manually.
- **[Agent](https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode)**: Start an agentic coding flow with a set of tools that let it autonomously collect context, run terminal commands, or take other actions to complete a task. Agent mode is enabled for all [VS Code Insiders](https://code.visualstudio.com/insiders/) users, and we are rolling it out to more and more users in VS Code Stable.
- **[Edit](https://code.visualstudio.com/docs/copilot/chat/copilot-edits)**: In Edit mode, the model can make directed edits to multiple files. Attach `#codebase` to let it find the files to edit automatically. But it won't run terminal commands or do anything else automatically.

> **Note**: If you don't see agent mode in this list, then either it has not yet been enabled for you, or it's disabled by organization policy and needs to be enabled by the [organization owner](https://aka.ms/github-copilot-org-enable-features).

Besides making your chat experience simpler, this unification enables a few new features for AI-powered code editing:

- **Switch modes in the middle of a conversation**: For example, you might start brainstorming an app idea in ask mode, then switch to agent mode to execute the plan. Tip: press `<kbd>Ctrl+.</kbd>` to change modes quickly.
- **Edit sessions in history**: Use the **Show Chats** command (clock icon at the top of the Chat view) to restore past edit sessions and keep working on them.
- **Move chat to editor or window**: Select **Open Chat in New Editor/New Window** to pop out your chat conversation from the side bar into a new editor tab or separate VS Code window. Chat has supported this for a long time, but now you can run your edit/agent sessions from an editor pane or a separate window as well.
- **Multiple agent sessions**: Following from the above point, this means that you can even run multiple agent sessions at the same time. You might like to have one chat in agent mode working on implementing a feature, and another independent session for doing research and using other tools. Directing two agent sessions to edit files at the same time is not recommended, it can lead to confusion.

#### Bring Your Own Key (BYOK) (Preview)

Copilot Pro and Copilot Free users can now bring their own API keys for popular providers such as Azure, Anthropic, Gemini, Open AI, Ollama, and Open Router. This allows you to use new models that are not natively supported by Copilot the very first day that they're released.

To try it, select **Manage Models...** from the model picker. We’re actively exploring support for Copilot Business and Enterprise customers and will share updates in future releases. To learn more about this feature, head over to our [docs](https://code.visualstudio.com/docs/copilot/language-models).

![A screenshot of a "Manage Models - Preview" dropdown menu in a user interface. The dropdown has the label "Select a provider" at the top, with a list of options below it. The options include "Anthropic" (highlighted in blue), "Azure," "Gemini," "OpenAI," "Ollama," and "OpenRouter." A gear icon is displayed next to the "Anthropic" option.](https://code.visualstudio.com/assets/updates/1_99/byok.png)

#### Reusable prompt files

##### Improved configuration

**Setting**: `chat.promptFilesLocations`

The `chat.promptFilesLocations` setting now supports glob patterns in file paths. For example, to include all `.prompt.md` files in the currently open workspace, you can set the path to `{ "**": true }`.

Additionally, the configuration now respects case sensitivity on filesystems where it applies, aligning with the behavior of the host operating system.

##### Improved editing experience

- Your `.prompt.md` files now offer basic autocompletion for filesystem paths and highlight valid file references. Broken links on the other hand now appear as warning or error squiggles and provide detailed diagnostic information.
- You can now manage prompts using edit and delete actions in the prompt file list within the **Chat: Use Prompt** command.
- Folder references in prompt files are no longer flagged as invalid.
- Markdown comments are now properly handled, for instance, all commented-out links are ignored when generating the final prompt sent to the LLM model.

##### Alignment with custom instructions

The `.github/copilot-instructions.md` file now behaves like any other reusable `.prompt.md` file, with support for nested link resolution and enhanced language features. Furthermore, any `.prompt.md` file can now be referenced and is handled appropriately.

Learn more about [custom instructions](https://code.visualstudio.com/docs/copilot/copilot-customization).

##### User prompts

The **Create User Prompt** command now allows creating a new type of prompts called _user prompts_. These are stored in the user data folder and can be synchronized across machines, similar to code snippets or user settings. The synchronization can be configured in [Sync Settings](https://code.visualstudio.com/docs/configure/settings-sync) by using the **Prompts** item in the synchronization resources list.

#### Improved vision support (Preview)

Last iteration, Copilot Vision was enabled for `GPT-4o`. Check our [release notes](https://code.visualstudio.com/updates/v1_98#_copilot-vision-preview) to learn more about how you can attach and use images in chat.

This release, you can attach images from any browser via drag and drop. Images drag and dropped from browsers must have the correct url extension, with `.jpg`, `.png`, `.gif`, `.webp`, or `.bmp`.

<video src="https://code.visualstudio.com/assets/updates/1_99/image-url-dnd.mp4" title="Video that shows an image from Chrome being dragged into the chat panel." autoplay loop controls muted></video>

### Notebooks

#### AI notebook editing improvements

AI-powered editing support for notebooks (including agent mode) is now available in the Stable release. This was added last month as a preview feature in [VS Code Insiders](https://code.visualstudio.com/insiders).

You can now use chat to edit notebook files with the same intuitive experience as editing code files: modify content across multiple cells, insert and delete cells, and change cell types. This feature provides a seamless workflow when working with data science or documentation notebooks.

##### New notebook tool

VS Code now provides a dedicated tool for creating new Jupyter notebooks directly from chat. This tool plans and creates a new notebook based on your query.

Use the new notebook tool in agent mode or edit mode (make sure to enable the improved edit mode with `chat.edits2.enabled:true)`. If you're using ask mode, type `/newNotebook` in the chat prompt to create a new notebook.

<video src="https://code.visualstudio.com/assets/updates/1_99/new-notebook-tool-release-notes.mp4" title="Video showing creation of a new Jupyter notebook using chat in agent mode and the New Notebook tool." autoplay loop controls muted></video>

##### Navigate through AI edits

Use the diff toolbars to iterate through and review each AI edit across cells.

<video src="https://code.visualstudio.com/assets/updates/1_99/navigate-notebook-edits.mp4" title="Video showing chat implementing a TODO task and then navigating through those changes." autoplay loop controls muted></video>

##### Undo AI edits

When focused on a cell container, the **Undo** command reverts the full set of AI changes at the notebook level.

<video src="https://code.visualstudio.com/assets/updates/1_99/undo-copilot-notebook-edits.mp4" title="Video showing chat making several edits to a notebook and undoing those edits with ctrl+z." autoplay loop controls muted></video>

##### Text and image output support in chat

You can now add notebook cell outputs, such as text, errors, and images, directly to chat as context. This lets you reference the output when using ask, edit, or agent mode, making it easier for the language model to understand and assist with your notebook content.

Use the **Add cell output to chat** action, available via the triple-dot menu or by right-clicking the output.

To attach the cell error output as chat context:

<video src="https://code.visualstudio.com/assets/updates/1_99/notebook-output-attach.mp4" title="Video that shows attaching an notebook cell error output to chat." autoplay loop controls muted></video>

To attach the cell output image as chat context:

<video src="https://code.visualstudio.com/assets/updates/1_99/notebook-output-image-demo.mp4" title="Video that shows attaching an notebook cell output image to chat." autoplay loop controls muted></video>

### Terminal

#### Reliability in agent mode

The tool that allows agent mode to run commands in the terminal has a number of reliability and compatibility improvements. You should expect fewer cases where the tool gets stuck or where the command finishes without the output being present.

One of the bigger changes is the introduction of the concept of "rich" quality [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration), as opposed to "basic" and "none". The shell integration scripts shipped with VS Code should generally all enable rich shell integration which provides the best experience in the run in terminal tool (and terminal usage in general). You can view the shell integration quality by hovering over the terminal tab.


## 0.25 (2025-03-05)

GitHub Copilot updates from [February 2025](https://code.visualstudio.com/updates/v1_98):

### Copilot Edits

#### Agent mode improvements (Experimental)

Last month, we introduced _agent mode_ for Copilot Edits in [VS Code Insiders](https://code.visualstudio.com/insiders/). In agent mode, Copilot can automatically search your workspace for relevant context, edit files, check them for errors, and run terminal commands (with your permission) to complete a task end-to-end.

> **Note**: Agent mode is available today in [VS Code Insiders](https://code.visualstudio.com/insiders/), and we just started rolling it out gradually in **VS Code Stable**. Once agent mode is enabled for you, you will see a mode dropdown in the Copilot Edits view — simply select **Agent**.

We made several improvements to the UX of tool usages this month:

* Terminal commands are now shown inline, so you can keep track of which commands were run.
* You can edit the suggested terminal command in the chat response before running it.
* Confirm a terminal command with the <kbd>Ctrl+Enter</kbd> shortcut.

<video src="https://code.visualstudio.com/assets/updates/1_98/edit-terminal.mp4" title="Video that shows editing a suggested terminal command in Chat." autoplay loop controls muted></video>

Agent mode autonomously searches your codebase for relevant context. Expand the message to see the results of which searches were done.

![Screenshot that shows the expandable list of search results in Copilot Edits.](https://code.visualstudio.com/assets/updates/1_98/agent-mode-search-results.png)

We've also made various improvements to the prompt and behavior of agent mode:

* The undo and redo actions in chat now undo or redo the last file edit made in a chat response. This is useful for agent mode, as you can now undo certain steps the model took without rolling back the entire chat response.
* Agent mode can now run your build [tasks](https://code.visualstudio.com/docs/editor/tasks) automatically or when instructed to do so. Disable this functionality via the `github.copilot.chat.agent.runTasks` setting, in the event that you see the model running tasks when it should not.

Learn more about [Copilot Edits agent mode](https://code.visualstudio.com/docs/copilot/copilot-edits#_use-agent-mode-preview) or read the [agent mode announcement blog post](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode).

> **Note**: If you are a Copilot Business or Enterprise user, an administrator of your organization [must opt in](https://docs.github.com/en/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-policies-for-copilot-in-your-organization#enabling-copilot-features-in-your-organization) to the use of Copilot "Editor Preview Features" for agent mode to be available.

#### Notebook support in Copilot Edits (Preview)

We are introducing notebook support in Copilot Edits. You can now use Copilot to edit notebook files with the same intuitive experience as editing code files. Create new notebooks from scratch, modify content across multiple cells, insert and delete cells, and change cell types. This preview feature provides a seamless workflow when working with data science or documentation notebooks.

> For the best notebook editing experience with Copilot, we recommend using [VS Code Insiders](https://code.visualstudio.com/insiders/) and the pre-release version of GitHub Copilot Chat, where you'll get the latest improvements to this feature as they're developed.

<video src="https://code.visualstudio.com/assets/updates/1_98/notebook_copilot_edits.mp4" title="Video that shows using Copilot Edits to modify a notebook." autoplay loop controls muted></video>

#### Refined editor integration

We have polished the integration of Copilot Edits with code and notebook editors:

* No more scrolling while changes are being applied. The viewport remains in place, making it easier to focus on what changes.
* Renamed the edit review actions from "Accept" to "Keep" and "Discard" to "Undo" to better reflect what’s happening. Changes for Copilot Edits are live, they are applied and saved as they are made and users keep or undo them.
* After keeping or undoing a file, the next file is automatically revealed.

The video demonstrates how edits are applied and saved as they occur. The live preview updates, and the user decided to "Keep" the changes. Undoing and further tweaking is also still possible.

<video src="https://code.visualstudio.com/assets/updates/1_98/edits_editor.mp4" title="Video that shows that changes from Copilot Edits are saved automatically and the user decided to keep them." autoplay loop controls muted></video>

#### Refreshed UI

In preparation for unifying Copilot Edits with Copilot Chat, we've given Copilot Edits a facelift. Files that are attached and not yet sent, are now rendered as regular chat attachments. Only files that have been modified with AI are added to the changed files list, which is located above the chat input part.

With the `chat.renderRelatedFiles` setting, you can enable getting suggestions for related files. Related file suggestions are rendered below the chat attachments.

![Screenshot that shows the updated Copilot Edits attachments and changed files user experience.](https://code.visualstudio.com/assets/updates/1_98/copilot_edits_ui.png)

### Removed Copilot Edits limits

Previously, you were limited to attach 10 files to your prompt in Copilot Edits. With this release, we removed this limit. Additionally, we've removed the client-side rate limit of 14 interactions per 10 minutes.

> Note that service-side usage rate limits still apply.

### Smoother authentication flows in chat

If you host your source code in a GitHub repository, you're able to leverage several features, including advanced code searching, the `@github` chat participant, and more!

However, for private GitHub repositories, VS Code needs to have permission to interact with your repositories on GitHub. For a while, this was presented with our usual VS Code authentication flow, where a modal dialog showed up when you invoked certain functionality (for example, asking `@workspace` or `@github` a question, or using the `#codebase` tool).

To make this experience smoother, we've introduced this confirmation in chat:

![Screenshot that shows the authentication confirmation dialog in Chat, showing the three options to continue.](https://code.visualstudio.com/assets/updates/1_98/confirmation-auth-dialog.png)

Not only is it not as jarring as a modal dialog, but it also has new functionality:

1. **Grant:** you're taken through the regular authentication flow like before (via the modal).
1. **Not Now:** VS Code remembers your choice and won't bother you again until your next VS Code window session. The only exception to this is if the feature needs this additional permission to function, like `@github`.
1. **Never Ask Again:** VS Code remembers your choice and persists it via the `github.copilot.advanced.authPermissions` setting. Any feature that needs this additional permission will fail.

It's important to note that this confirmation does not confirm or deny Copilot (the service) access to your repositories. This is only how VS Code's Copilot experience authenticates. To configure what Copilot can access, please read the docs [on content exclusion](https://docs.github.com/en/copilot/managing-copilot/configuring-and-auditing-content-exclusion/excluding-content-from-github-copilot).

### More advanced codebase search in Copilot Chat

**Setting**: `github.copilot.chat.codesearch.enabled`

When you add `#codebase` to your Copilot Chat query, Copilot helps you find relevant code in your workspace for your chat prompt. `#codebase` can now run tools like text search and file search to pull in additional context from your workspace.

Set `github.copilot.chat.codesearch.enabled` to enable this behavior. The full list of tools is:

* Embeddings-based semantic search
* Text search
* File search
* Git modified files
* Project structure
* Read file
* Read directory
* Workspace symbol search

### Attach problems as chat context

To help with fixing code or other issues in your workspace, you can now attach problems from the Problems panel to your chat as context for your prompt.

Either drag an item from the Problems panel onto the Chat view, type `#problems` in your prompt, or select the paperclip 📎 button. You can attach specific problems, all problems in a file, or all files in your codebase.

### Attach folders as context

Previously, you could attach folders as context by using drag and drop from the Explorer view. Now, you can also attach a folder by selecting the paperclip 📎 icon or by typing `#folder:` followed by the folder name in your chat prompt.

### Collapsed mode for Next Edit Suggestions (Preview)

**Settings**:

* `github.copilot.nextEditSuggestions.enabled`
* `editor.inlineSuggest.edits.showCollapsed:true`

We've added a collapsed mode for NES. When you enable this mode, only the NES suggestion indicator is shown in the left editor margin. The code suggestion itself is revealed only when you navigate to it by pressing <kbd>Tab</kbd>. Consecutive suggestions are shown immediately until a suggestion is not accepted.

<video src="https://code.visualstudio.com/assets/updates/1_98/NEScollapsedMode.mp4" title="Video that shows Next Edit Suggestions collapsed mode." autoplay loop controls muted></video>

The collapsed mode is disabled by default and can be enabled by configuring `editor.inlineSuggest.edits.showCollapsed:true`, or you can enable or disable it in the NES gutter indicator menu.

![Screenshot that shows the Next Edit Suggestions context menu in the editor left margin, highlighting the Show Collapsed option.](https://code.visualstudio.com/assets/updates/1_98/NESgutterMenu.png)

### Change completions model

You could already change the language model for Copilot Chat and Copilot Edits, and now you can also change the model for inline suggestions.

Alternatively, you can change the model that is used for code completions via **Change Completions Model** command in the Command Palette or the **Configure Code Completions** item in the Copilot menu in the title bar.

> **Note:** the list of available models might vary and change over time. If you are a Copilot Business or Enterprise user, your Administrator needs to enable certain models for your organization by opting in to `Editor Preview Features` in the [Copilot policy settings](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-policies-for-copilot-in-your-organization#enabling-copilot-features-in-your-organization) on GitHub.com.

### Model availability

This release, we added more models to choose from when using Copilot. The following models are now available in the model picker in Visual Studio Code and github.com chat:

* **GPT 4.5 (Preview)**: OpenAI’s latest model, GPT-4.5, is now available in GitHub Copilot Chat to Copilot Enterprise users. GPT-4.5 is a large language model designed with advanced capabilities in intuition, writing style, and broad knowledge. Learn more about the GPT-4.5 model availability in the [GitHub blog post](https://github.blog/changelog/2025-02-27-openai-gpt-4-5-in-github-copilot-now-available-in-public-preview).

* **Claude 3.7 Sonnet (Preview)**: Claude 3.7 Sonnet is now available to all customers on paid Copilot plans. This new Sonnet model supports both thinking and non-thinking modes in Copilot. In initial testing, we’ve seen particularly strong improvements in agentic scenarios. Learn more about the Claude 3.7 Sonnet model availability in the [GitHub blog post](https://github.blog/changelog/2025-02-24-claude-3-7-sonnet-is-now-available-in-github-copilot-in-public-preview/).

### Copilot Vision (Preview)

We're quickly rolling out end-to-end vision support in this version of Copilot Chat. This lets you attach images and interact with images in chat prompts. For example, if you encounter an error while debugging, attach a screenshot of VS Code, and ask Copilot to help you resolve the issue. You might also use it to attach some UI mockup and let Copilot provide some HTML and CSS to implement the mockup.

![Animation that shows an attached image in a Copilot Chat prompt. Hovering over the image shows a preview of it.](https://code.visualstudio.com/assets/updates/1_97/image-attachments.gif)

You can attach images in multiple ways:

* Drag and drop images from your OS or from the Explorer view
* Paste an image from your clipboard
* Attach a screenshot of the VS Code window (select the **paperclip 📎 button** > **Screenshot Window**)

A warning is shown if the selected model currently does not have the capability to handle the file type. The only supported model at the moment will be `GPT 4o`, but support for image attachments with `Claude 3.5 Sonnet` and `Gemini 2.0 Flash` will be rolling out soon as well. Currently, the supported image types are `JPEG/JPG`, `PNG`, `GIF`, and `WEBP`.

### Copilot status overview (Experimental)

**Setting**: `chat.experimental.statusIndicator.enabled`

We are experimenting with a new central Copilot status overview, accessible via the Status Bar. This view shows:

* Quota information if you are a [Copilot Free](https://code.visualstudio.com/blogs/2024/12/18/free-github-copilot) user
* Editor related settings such as Code Completions
* Useful keyboard shortcuts to use other Copilot features

<video src="https://code.visualstudio.com/assets/updates/1_98/copilot-status.mp4" title="Video that shows opening the Copilot status overview from the Status Bar." autoplay loop controls muted></video>

You can enable this new Status Bar entry by configuring the new `chat.experimental.statusIndicator.enabled` setting.

### TypeScript context for inline completions (Experimental)

**Setting**: `chat.languageContext.typescript.enabled`

We are experimenting with enhanced context for inline completions and `/fix` commands for TypeScript files. The experiment is currently scoped to Insider releases and can be enabled with the `chat.languageContext.typescript.enabled` setting.

### Custom instructions for pull request title and description

You can provide custom instructions for generating pull request title and description with the setting `github.copilot.chat.pullRequestDescriptionGeneration.instructions`.  You can point the setting to a file in your workspace, or you can provide instructions inline in your settings:

```
{
  "github.copilot.chat.pullRequestDescriptionGeneration.instructions": [
    {
      "text": "Prefix every PR title with an emoji."
    }
  ]
}
```

Generating a title and description requires the GitHub Pull Requests extension to be installed.

## Previous release: https://code.visualstudio.com/updates
