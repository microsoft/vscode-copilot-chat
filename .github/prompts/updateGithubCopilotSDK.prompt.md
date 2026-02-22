---
name: updateGithubCopilotSDK
description: Use this to update the Github Copilot CLI/SDK
model: Claude Opus 4.6
---

<!-- Tip: Use /create-prompt in chat to generate content with agent assistance -->

Define the prompt content here. You can include instructions, examples, and any other relevant information to guide the AI's responses.

You are an expert at upgrading the @github/copilot npm package in the vscode-copilot-chat project.

## Upgrade Process

Follow these steps exactly:

### 1. Snapshot of old type definitions

Before upgrading, take a snapshot of node_modules/@github/copilot/sdk/index.d.ts to compare against after the upgrade.

### 2. Update the package

Update the @github/copilot package to the latest version:

```bash
npm install @github/copilot@latest
```

### 3. Compare differences in type definitions
* Analyze the differences between the old and new index.d.ts files to identify any API changes, new features, or breaking changes.
* Document the changes in a clear and organized manner, create the documentation in in .build/upgrade-notes.md


### 3. Compile, fix and test

You must follow these steps in order:

#### a. Compile
- Run the following two compilation commands to identify any type errors caused by the upgrade:
```bash
node .esbuild.ts --dev
npx tsc --noEmit --project tsconfig.json
```

#### b. Fix Compilation Errors
- If you run into any compilation errors, you must perform a deep analysis of the issues before attempting to resolve them.
- Fix each compilation error one by one, ensuring that you understand the root cause of each error and how it relates to the changes in the new version of the @github/copilot package.
- When fixing the errors, ensure you understand the impact of your changes on the overall codebase and that you are not introducing new issues while resolving existing ones.
- After fixing each error, re-run the compilation commands to check if the errors have been resolved and to identify any new errors that may have arisen from your fixes. Repeat this process until all compilation errors are resolved.

#### c. Run Tests
- Use the following command to run test
```bash
npm run test:unit
```
- After successfully compiling the code without any errors, you must run all relevant tests to ensure that the upgrade has not introduced any regressions or new issues.
- Pay special attention to any tests that are related to the areas of the codebase that were affected by the upgrade, as these are more likely to be impacted by the changes in the @github
- Do NOT change the behavour of the code just to make the tests pass. If the upgrade causes a test to fail, you must analyze the failure and determine if it is due to a legitimate issue caused by the upgrade or if it is a problem with the test itself. Only make changes to the code if there is a clear and justified reason to do so based on your analysis of the test failure.

Repeate this process until you have successfully compiled the code and all tests are passing without any issues. This rigorous approach ensures that the upgrade is successful and does not introduce any new problems into the codebase.

### 4. Running integration tests

- There are a special set of integration tests for the Github Copilot SDK that you must run to ensure that the upgrade is successful.
- The tests are located in test/e2e/cli.stest.ts.
- The tests in this file are all skipped by default using `suite.skip`, so you must remove the `.skip` to enable them before running the tests.
- Re-compile the code after enabling the tests to ensure that there are no compilation errors.
- If you run into any compilation errors go back to the `3. Compile, fix and test` to resolve them before proceeding with running the integration tests.
- After successfully compiling the code with the integration tests enabled, run the tests using the following command
```bash
npm run simulate -- --grep=@cli --verbose -n=1 -p=1@cli
```

These tests are very slow, you might have to wait for around 5 minutes for them to complete.
- If any of the tests fail, you must analyze the failure and determine if it is due to a legitimate issue caused by the upgrade or if it is a problem with the test itself. Only make changes to the code if there is a clear and justified reason to do so based on your analysis of the test failure.
- Repeate a similar process process as identified in `3. Compile, fix and test`.
- Once you are able to successfully run the integration tests without any issues, you can be confident that the upgrade of the @github/copilot package was successful and did not introduce any new problems into the codebase.

NOTE:
Tests are considered passing only if you get a score of 100%
Here's a sample output. As you can see below the score needs to be 100/100 for the tests to be considered passing.
```
Suite Summary by Language:
┌─────────┬───────────────────┬──────────┬───────┬────────────┬──────────┐
│ (index) │ Suite             │ Language │ Model │ # of tests │ Score(%) │
├─────────┼───────────────────┼──────────┼───────┼────────────┼──────────┤
│ 0       │ '@cli [external]' │ '-'      │ '-'   │ 16         │ 100      │
└─────────┴───────────────────┴──────────┴───────┴────────────┴──────────┘

Approximate Summary (due to using --n=1 instead of --n=10):
Overall Approximate Score: 100.00 / 100

```

#### 6. Re-introduce `stest.skip` changes in cli.stest.ts
- After successfully running the integration tests, you must re-introduce the `stest.skip` to disable the tests in cli.stest.ts.

#### 5. Summarize the changes

- After successfully upgrading the @github/copilot package and ensuring that all tests are passing, you must create a summary of the changes that were made during the upgrade process.
- Give a summary of the changes in the code base
- Give a summary of the changes in the tests
- Give a summary of the differenes in the type definitions between the old and new versions of the @github/copilot package.
  - Focus on the new API or features that were added, any breaking changes that were introduced, and any deprecated features that were removed.
- Document the summary in a clear and organized manner, create the documentation in in .build/upgrade-notes.md
