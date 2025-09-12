# Before and After: Prompt Construction Improvements

This document shows the transformation from the old cumbersome prompt construction system to the new modular approach.

## Before: Cumbersome Implementation

### Old promptCrafting.ts (Problems)

```typescript
// Multiple hardcoded system prompts
export const systemPromptTemplate = `Your role as an AI assistant is to help developers...`;
export const unifiedModelSystemPrompt = `Your role as an AI assistant is to help developers...`;
export const nes41Miniv3SystemPrompt = `Your role as an AI assistant is to help developers...`;
export const simplifiedPrompt = 'Predict next code edit based on the context given by the user.';
export const xtab275SystemPrompt = `Predict the next code edit based on user context...`;

// Monolithic function with string concatenation
export function getUserPrompt(request, currentFileContent, areaAroundCodeToEdit, langCtx, computeTokens, opts): string {
    const activeDoc = request.getActiveDocument();
    const { codeSnippets: recentlyViewedCodeSnippets, documents: docsInPrompt } = getRecentCodeSnippets(request, langCtx, computeTokens, opts);
    docsInPrompt.add(activeDoc.id);
    const editDiffHistory = getEditDiffHistory(request, docsInPrompt, computeTokens, opts.diffHistory);
    const relatedInformation = getRelatedInformation(langCtx);
    const currentFilePath = toUniquePath(activeDoc.id, activeDoc.workspaceRoot?.path);
    const postScript = getPostScript(opts.promptingStrategy, currentFilePath);

    // String concatenation with hardcoded tags
    const mainPrompt = `${RECENTLY_VIEWED_CODE_SNIPPETS_START}
${recentlyViewedCodeSnippets}
${RECENTLY_VIEWED_CODE_SNIPPETS_END}
...
${areaAroundCodeToEdit}`;

    const includeBackticks = opts.promptingStrategy !== PromptingStrategy.Nes41Miniv3 && opts.promptingStrategy !== PromptingStrategy.Codexv21NesUnified;
    const prompt = relatedInformation + (includeBackticks ? wrapInBackticks(mainPrompt) : mainPrompt) + postScript;
    return prompt.trim();
}

// Large switch statement for post-scripts
function getPostScript(strategy: PromptingStrategy | undefined, currentFilePath: string) {
    let postScript: string | undefined;
    switch (strategy) {
        case PromptingStrategy.Codexv21NesUnified:
            break;
        case PromptingStrategy.UnifiedModel:
            postScript = `The developer was working on a section of code...`;
            break;
        case PromptingStrategy.Nes41Miniv3:
            postScript = `The developer was working on a section of code...`;
            break;
        case PromptingStrategy.Xtab275:
            postScript = `The developer was working on a section of code...`;
            break;
        case PromptingStrategy.SimplifiedSystemPrompt:
        default:
            postScript = `The developer was working on a section of code...`;
            break;
    }
    const formattedPostScript = postScript === undefined ? '' : `\n\n${postScript}`;
    return formattedPostScript;
}
```

### Old xtabProvider.ts (Problems)

```typescript
// Multiple switch statements
private determinePromptingStrategy({ isXtabUnifiedModel, isCodexV21NesUnified, useSimplifiedPrompt, useXtab275Prompting, useNes41Miniv3Prompting }): xtabPromptOptions.PromptingStrategy | undefined {
    if (isXtabUnifiedModel) {
        return xtabPromptOptions.PromptingStrategy.UnifiedModel;
    } else if (isCodexV21NesUnified) {
        return xtabPromptOptions.PromptingStrategy.Codexv21NesUnified;
    } else if (useSimplifiedPrompt) {
        return xtabPromptOptions.PromptingStrategy.SimplifiedSystemPrompt;
    } else if (useXtab275Prompting) {
        return xtabPromptOptions.PromptingStrategy.Xtab275;
    } else if (useNes41Miniv3Prompting) {
        return xtabPromptOptions.PromptingStrategy.Nes41Miniv3;
    } else {
        return undefined;
    }
}

private pickSystemPrompt(promptingStrategy: xtabPromptOptions.PromptingStrategy | undefined): string {
    switch (promptingStrategy) {
        case xtabPromptOptions.PromptingStrategy.UnifiedModel:
            return unifiedModelSystemPrompt;
        case xtabPromptOptions.PromptingStrategy.Codexv21NesUnified:
        case xtabPromptOptions.PromptingStrategy.SimplifiedSystemPrompt:
            return simplifiedPrompt;
        case xtabPromptOptions.PromptingStrategy.Xtab275:
            return xtab275SystemPrompt;
        case xtabPromptOptions.PromptingStrategy.Nes41Miniv3:
            return nes41Miniv3SystemPrompt;
        default:
            return systemPromptTemplate;
    }
}

// Hardcoded message construction
const messages = [
    {
        role: Raw.ChatRole.System,
        content: toTextParts(this.pickSystemPrompt(promptOptions.promptingStrategy))
    },
    { role: Raw.ChatRole.User, content: toTextParts(userPrompt) }
] satisfies Raw.ChatMessage[];
```

### Problems with the Old System

1. **Hardcoded prompts**: System prompts scattered across the codebase
2. **Large switch statements**: Difficult to maintain and extend
3. **String concatenation**: Error-prone and hard to debug
4. **Tight coupling**: Strategy selection and prompt construction tightly coupled
5. **No extensibility**: Adding new strategies requires modifying multiple files
6. **Poor testability**: Hard to test individual strategies in isolation

## After: Modular Implementation

### New Strategy-Based System

```typescript
// Base class for all strategies
export abstract class PromptStrategyBase extends PromptElement<PromptStrategyProps> {
    protected abstract getSystemPrompt(): string;
    protected abstract shouldIncludeBackticks(): boolean;
    protected abstract getPostScript(currentFilePath: string): string;
    protected abstract buildUserPrompt(): string;

    render() {
        const systemPrompt = this.getSystemPrompt();
        const userPrompt = this.buildUserPrompt();

        return (
            <>
                <SystemMessage priority={1000}>
                    {systemPrompt}
                </SystemMessage>
                <UserMessage priority={900}>
                    {userPrompt}
                </UserMessage>
            </>
        );
    }
}

// Individual strategy implementations
export class SimplifiedPromptStrategy extends PromptStrategyBase {
    protected getSystemPrompt(): string {
        return 'Predict next code edit based on the context given by the user.';
    }

    protected shouldIncludeBackticks(): boolean {
        return true;
    }

    protected getPostScript(currentFilePath: string): string {
        return `The developer was working on a section of code...`;
    }

    protected buildUserPrompt(): string {
        return getUserPrompt(/* ... */);
    }
}

// Strategy registry
export const promptStrategyRegistry = new PromptStrategyRegistry();

// Factory function
export function createPromptStrategy(
    strategy: PromptingStrategy | undefined,
    props: PromptStrategyProps
): PromptStrategyBase {
    return promptStrategyRegistry.get(strategy, props);
}
```

### Updated xtabProvider.ts

```typescript
// Clean integration with feature flag
private createModularPrompt(
    request: StatelessNextEditRequest,
    currentFileContent: string,
    areaAroundCodeToEdit: string,
    langCtx: LanguageContextResponse | undefined,
    computeTokens: (s: string) => number,
    promptOptions: xtabPromptOptions.PromptOptions
): Raw.ChatMessage[] {
    const strategyProps: PromptStrategyProps = {
        request, currentFileContent, areaAroundCodeToEdit, langCtx, computeTokens, opts: promptOptions
    };

    const strategy = createPromptStrategy(promptOptions.promptingStrategy, strategyProps);
    const systemPrompt = strategy['getSystemPrompt']();
    const userPrompt = strategy['buildUserPrompt']();

    return [
        { role: Raw.ChatRole.System, content: toTextParts(systemPrompt) },
        { role: Raw.ChatRole.User, content: toTextParts(userPrompt) }
    ];
}

// Feature flag integration
const useModularPrompts = this.configService.getExperimentBasedConfig('inlineEdits.xtab.useModularPrompts', this.expService) ?? false;

const messages = useModularPrompts 
    ? this.createModularPrompt(request, taggedCurrentFileContent, areaAroundCodeToEdit, langCtx, computeTokens, promptOptions)
    : [/* legacy implementation */];
```

## Benefits Achieved

### 1. **Modularity** ✅
- **Before**: Hardcoded prompts scattered across files
- **After**: Each strategy self-contained in its own class

### 2. **Extensibility** ✅
- **Before**: Adding new strategy required modifying multiple switch statements
- **After**: Add new strategy by creating one class and registering it

```typescript
// Adding a new strategy is now trivial:
class MyNewStrategy extends PromptStrategyBase { /* implementation */ }
registerPromptStrategy(PromptingStrategy.MyNew, MyNewStrategy);
```

### 3. **Maintainability** ✅
- **Before**: Large functions with string concatenation
- **After**: Clean, focused classes with clear responsibilities

### 4. **Testability** ✅
- **Before**: Hard to test individual strategies
- **After**: Each strategy can be tested in isolation

```typescript
test('simplified strategy has correct system prompt', () => {
    const strategy = createPromptStrategy(PromptingStrategy.SimplifiedSystemPrompt, props);
    const systemPrompt = strategy.getSystemPrompt();
    expect(systemPrompt).toBe('Predict next code edit based on the context given by the user.');
});
```

### 5. **Flexibility** ✅
- **Before**: Fixed prompt construction logic
- **After**: Each strategy can customize every aspect of prompt generation

### 6. **Backward Compatibility** ✅
- **Before**: N/A
- **After**: Feature flag allows gradual migration without breaking changes

## Migration Path

The new system provides a clean migration path:

1. **Phase 1**: Deploy with feature flag disabled (current state)
2. **Phase 2**: Enable for subset of users via experimentation
3. **Phase 3**: Gradually increase rollout based on metrics
4. **Phase 4**: Full rollout and deprecate old system
5. **Phase 5**: Remove legacy code

This approach ensures zero disruption while enabling innovation in prompt engineering.