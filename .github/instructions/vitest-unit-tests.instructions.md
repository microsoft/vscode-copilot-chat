---
applyTo: '**/*.spec.ts'
description: Vitest unit testing guidelines
---

Guidelines for writing unit tests using Vitest. These tests are `*.spec.ts`

## Best Practices

- Use proper mocks when possible rather than ad-hoc objects injected as dependencies. For example, call `createExtensionUnitTestingServices` to get some mock services, and `IInstantiationService` to create instances with those mocks.
- If there is no preexisting implementation of a service that is appropriate to reuse in the test, then you can create a simple mock or stub implementation.
- Avoid casting to `any` whenever possible.
- When asked to write new tests, add tests for things that are interesting and nontrivial. Don't add a test that just verifies that a setter/getter work.
- Prefer the runTests tool to run tests over a terminal command.