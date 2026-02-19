---
name: doc-comment-info
description: 'Create doc comment info for a code elements. Useful for generating documentation comments for code symbols. You should use this skill when you think the user is looking for information about how to document a specific code symbol.'
---

# How to get doc comment info

1. Find the code symbol the user wants to document. This could be a function, class, variable, etc. Use the context of the conversation and the user's current cursor position or selection in the code editor to identify the relevant code symbol.
2. Extract the necessary information about the code symbol, such as its name, type, parameters, return type, and any relevant annotations or attributes. This information will be used to generate the doc comment.
3. Create the content of the doc comment based on the extracted information and what the symbol represents. For example, if it's a function, include a description of what the function does, its parameters, and its return value. If it's a class, include a description of the class and its properties and methods.
4. When providing the doc comment, respond with ONLY a markdown code block containing the generated doc comment using the appropriate programming language.