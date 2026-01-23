# GitHub Copilot - Your AI pair programmer

**[GitHub Copilot](https://code.visualstudio.com/docs/copilot/overview)** is an AI peer programming tool that helps you write code faster and smarter.

GitHub Copilot adapts to your unique needs, allowing you to select the best model for your project, customize chat responses with custom instructions, and utilize agent mode for AI-powered, seamlessly integrated peer programming sessions.

**Sign up for [GitHub Copilot Free](https://github.com/settings/copilot?utm_source=vscode-chat-readme&utm_medium=first&utm_campaign=2025mar-em-MSFT-signup)!**

![Working with GitHub Copilot agent mode to make edits to code in your workspace](https://github.com/microsoft/vscode-copilot-release/blob/main/images/hero-dark.png?raw=true)

When you install Copilot in Visual Studio Code, you get two extensions:
* **[GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)** - Provides inline coding suggestions as you type.
* **[GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat)** (this extension) - A companion extension that provides conversational AI assistance.

## Getting access to GitHub Copilot

Sign up for [GitHub Copilot Free](https://github.com/settings/copilot?utm_source=vscode-chat-readme&utm_medium=second&utm_campaign=2025mar-em-MSFT-signup), or request access from your enterprise admin.

To access GitHub Copilot, an active GitHub Copilot subscription is required. You can read more about our business and individual offerings at [github.com/features/copilot](https://github.com/features/copilot?utm_source=vscode-chat&utm_medium=readme&utm_campaign=2025mar-em-MSFT-signup).

## AI-powered coding sessions

**Start an AI-powered coding session tailored to your workflow**. Copilot Edits allows you to quickly iterate on code changes directly in the editor, across multiple files, using natural language. For a more autonomous peer programmer experience,
[agent mode](https://aka.ms/vscode-copilot-agent) performs multi-step coding tasks at your command. It automatically handles compile and lint errors, monitors terminal and test output, and iterates until the task is complete. [Edit mode](https://aka.ms/vscode-copilot-edit) offers a conversational, step-by-step coding experience. Engage in multi-turn chat conversations while Copilot applies edits directly to your codebase, allowing you to review changes in context and maintain full control.

![Agent mode in Copilot Chat creating a new Vue application](https://github.com/microsoft/vscode-copilot-release/blob/main/images/agent-mode-readme.gif?raw=true)

## Inline suggestions in the editor

**Automatically receive inline suggestions in the editor** from [ghost text suggestions](https://aka.ms/vscode-completions) and [next edit suggestions](https://aka.ms/vscode-nes) to help you write code faster. Ghost text suggestions provide suggestions at the current location, tailored to your coding style and your existing code. Copilot next edit suggestions (Copilot NES) takes it a step further and predicts what and where your next logical code change will be. Use the Tab key to navigate and accept changes in quick succession.

![Copilot next edit suggestions](https://code.visualstudio.com/assets/docs/copilot/inline-suggestions/nes-point.gif)

## Ask and learn about your code with chat

**Ask Copilot for help with any task or question** in the [Chat view](https://aka.ms/vscode-chat), bringing in code from your current files. Rather than giving you a generic answer, it can give answers that are relevant for your codebase using information provided by [participants](https://aka.ms/vscode-chat-participants), [variables](https://aka.ms/vscode-chat-variables), and [slash commands](https://aka.ms/vscode-chat-commands).

![Using the workspace chat participant](https://github.com/microsoft/vscode-copilot-release/blob/main/images/participants-workspace.gif?raw=true)

**Apply Copilot's AI suggestions directly to your code** using [Inline chat](https://aka.ms/vscode-inline-chat), staying in the flow. Need help with refactoring a method, adding error handling, or explaining a complex algorithm - just launch Copilot in the editor!

![Inline chat in VS Code](https://code.visualstudio.com/assets/docs/copilot/copilot-chat/inline-chat-question-example.png)

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
* **[Copilot Chat quickstart video](https://www.youtube.com/watch?v=3surPGP7_4o)** to learn Copilot Chat in less than 4 minutes
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
