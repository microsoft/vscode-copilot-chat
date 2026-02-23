# GitHub Copilot - Your autonomous AI peer programmer

**[GitHub Copilot](https://code.visualstudio.com/docs/copilot/overview)** is an AI peer programming tool that transforms how you write code in Visual Studio Code.

GitHub Copilot agents handle complete coding tasks end-to-end, autonomously planning work, editing files, running commands, and self-correcting when they hit errors. You can also leverage inline suggestions for quick coding assistance and inline chat for precise, focused edits directly in the editor.

**Sign up for [GitHub Copilot Free](https://github.com/settings/copilot?utm_source=vscode-chat-readme&utm_medium=first&utm_campaign=2025mar-em-MSFT-signup)!**

![Working with GitHub Copilot agent mode to make edits to code in your workspace](https://github.com/microsoft/vscode-copilot-release/blob/main/images/hero-dark.png?raw=true)


## Getting access to GitHub Copilot

Sign up for [GitHub Copilot Free](https://github.com/settings/copilot?utm_source=vscode-chat-readme&utm_medium=second&utm_campaign=2025mar-em-MSFT-signup), or request access from your enterprise admin.

To access GitHub Copilot, an active GitHub Copilot subscription is required. You can read more about our business and individual offerings at [github.com/features/copilot](https://github.com/features/copilot?utm_source=vscode-chat&utm_medium=readme&utm_campaign=2025mar-em-MSFT-signup).

## Build with autonomous agents

**Let AI agents implement complex features end-to-end**. Give an agent a high-level task and it breaks the work into steps, edits multiple files, runs terminal commands, and self-corrects when it hits errors or failing tests. Agents excel at [building new features](https://code.visualstudio.com/docs/copilot/agents/overview), [debugging and fixing failing tests](https://code.visualstudio.com/docs/copilot/guides/debug-with-copilot), refactoring codebases, and [collaborating via pull requests](https://code.visualstudio.com/docs/copilot/agents/cloud-agents). Run multiple [agent sessions](https://code.visualstudio.com/docs/copilot/chat/chat-sessions) in parallel and manage them all from a central view.

![Video showing an agent session building a complete feature in VS Code.](https://github.com/microsoft/vscode-docs/blob/main/docs/copilot/images/overview/agents-intro.mp4)


Use agents to [plan before you build](https://code.visualstudio.com/docs/copilot/agents/planning) with the Plan agent, which breaks tasks into structured implementation plans and asks clarifying questions. When your plan is ready, hand it off to an implementation agent to execute it. You can also [delegate tasks to cloud agents](https://code.visualstudio.com/docs/copilot/agents/cloud-agents) that create branches, implement changes, and open pull requests for your team to review.

## More ways to code with AI

**Receive intelligent inline suggestions** as you type with [ghost text suggestions](https://aka.ms/vscode-completions) and [next edit suggestions](https://aka.ms/vscode-nes), helping you write code faster. Copilot predicts your next logical change, and you can accept suggestions with the Tab key.

![Copilot next edit suggestions](https://github.com/microsoft/vscode-docs/blob/main/docs/copilot/images/inline-suggestions/nes-video.mp4)

**Use inline chat for targeted edits** by pressing `Ctrl+I` to open a chat prompt directly in the editor. Describe a change and Copilot suggests edits in place for refactoring methods, adding error handling, or explaining complex algorithms without leaving your editor.

![Inline chat in VS Code](https://code.visualstudio.com/assets/docs/copilot/copilot-chat/inline-chat-question-example.png)

**Ask Copilot for help in the Chat view** by pressing `Ctrl+Alt+I`. Bring in code from your files and get answers relevant to your codebase using [chat participants](https://aka.ms/vscode-chat-participants), [variables](https://aka.ms/vscode-chat-variables), and [slash commands](https://aka.ms/vscode-chat-commands).

## Customize AI for your workflow

**Agents work best when they understand your project's conventions and have the right tools**. Tailor Copilot so it generates code that fits your codebase from the start. Use [custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) to define project-wide coding conventions, [custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents) to create specialized AI personas for specific tasks, and [agent skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills) to teach Copilot specialized capabilities. Extend agents further with [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) that integrate tools from external APIs and VS Code extensions.

### Supported languages and frameworks

GitHub Copilot works on any language, including Java, PHP, Python, JavaScript, Ruby, Go, C#, or C++. Because it’s been trained on languages in public repositories, it works for most popular languages, libraries and frameworks.

### Version compatibility

As Copilot Chat releases in lockstep with VS Code due to its deep UI integration, every new version of Copilot Chat is only compatible with the latest and newest release of VS Code. This means that if you are using an older version of VS Code, you will not be able to use the latest Copilot Chat.

Only the latest Copilot Chat versions will use the latest models provided by the Copilot service, as even minor model upgrades require prompt changes and fixes in the extension.

### Privacy and preview terms

By using Copilot Chat you agree to [GitHub Copilot chat preview terms](https://docs.github.com/en/early-access/copilot/github-copilot-chat-technical-preview-license-terms). Review the [transparency note](https://aka.ms/CopilotChatTransparencyNote) to understand about usage, limitations and ways to improve Copilot Chat during the technical preview.

Your code is yours. We follow responsible practices in accordance with our [Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement) to ensure that your code snippets will not be used as suggested code for other users of GitHub Copilot.

To get the latest security fixes, please use the latest version of the Copilot extension and VS Code.

### Resources & next steps
* **Sign up for [GitHub Copilot Free](https://github.com/settings/copilot?utm_source=vscode-chat-readme&utm_medium=third&utm_campaign=2025mar-em-MSFT-signup)**
    * If you're using Copilot for your business, check out [Copilot Business](https://docs.github.com/en/copilot/copilot-business/about-github-copilot-business) and [Copilot Enterprise](https://docs.github.com/en/copilot/github-copilot-enterprise/overview/about-github-copilot-enterprise)
* **[Get started with Copilot in VS Code tutorial](https://code.visualstudio.com/docs/copilot/getting-started)**
* **[Agents tutorial](https://code.visualstudio.com/docs/copilot/agents/agents-tutorial)** - Hands-on guide for working with different agent types
* **[VS Code Copilot Series on YouTube](https://www.youtube.com/playlist?list=PLj6YeMhvp2S5_hvBl2SE-7YCHYlLQ0bPt)**
* **[FAQ](https://code.visualstudio.com/docs/copilot/faq)**
* **[Feedback](https://github.com/microsoft/vscode-copilot-release/issues)**: We'd love to get your help in making GitHub Copilot better!

## Data and telemetry

The GitHub Copilot Extension for Visual Studio Code collects usage data and sends it to Microsoft to help improve our products and services. Read our [privacy statement](https://privacy.microsoft.com/privacystatement) to learn more. This extension respects the `telemetry.telemetryLevel` setting which you can learn more about at https://code.visualstudio.com/docs/supporting/faq#_how-to-disable-telemetry-reporting.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow Microsoft's Trademark & Brand Guidelines. Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos are subject to those third-party's policies.

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the [MIT](LICENSE.txt) license.
