---
name: savePrompt
description: Generalize the current discussion into a reusable prompt and save it as a file
tools: [ 'edit', 'search' ]
---
Generalize the current discussion into a reusable prompt that can be applied in similar contexts.

Think step by step:
1. Review the conversation to identify the user's primary goal or task pattern
2. If there is no conversation present, reply to the user that the `/savePrompt` prompt expects an active discussion to generalize. Keep the reply concise.
3. Generalize the task into a reusable prompt that could apply to similar scenarios
4. Extract the core intent, removing conversation-specific details (e.g., specific file names, variable names, or project-specific context)
5. Craft the generalized multi-line markdown text prompt, using placeholders where appropriate (e.g., "the selected code", "the current file", "the specified functionality")
6. Create a very concise action-oriented title in camelCase format that will be used for the slash command (1-3 words, e.g., "generateUnitTests", "refactorForPerformance", "explainApiDesign", etc)
7. Write a brief description (1 sentence, max 15 words) explaining the goal of the prompt
8. If applicable, define an argument-hint that describes the expected inputs for the prompt
9. Save the resulting prompt in an untitled file with URI `untitled:${promptFileName}.prompt.md`, where `${promptFileName}` is the concise action-oriented title from step 6

Here's an example of the expected output format:
```
---
name: ${The concise title in camelCase format. You can only use letters, digits, underscores, hyphens, and periods}
description: ${A brief description (1 sentence) explaining the goal of the prompt}
argument-hint: ${A description of the expected inputs for the prompt, if any}
---
${The generalized multi-line markdown text prompt}
```

