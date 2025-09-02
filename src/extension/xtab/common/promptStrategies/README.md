# Modular Prompt Construction System

This directory contains a modular, flexible, and extensible prompt construction system that replaces the previous cumbersome string concatenation approach in `promptCrafting.ts` and the hardcoded switch statements in `xtabProvider.ts`.

## Overview

The new system uses the Strategy Pattern combined with TSX components to create modular prompt strategies. Each prompt strategy encapsulates:

- System prompt content
- Post-script generation
- Backticks handling preferences  
- User prompt construction logic

## Architecture

### Base Components

- **`PromptStrategyBase`**: Abstract base class that all prompt strategies extend
- **`PromptStrategyProps`**: Interface defining the props passed to all strategies
- **`promptStrategyRegistry`**: Registry that manages strategy registration and creation

### Existing Strategies

The system includes implementations for all existing prompt strategies:

- **`DefaultPromptStrategy`**: The original system prompt template
- **`SimplifiedPromptStrategy`**: Simple "predict next code edit" prompt
- **`UnifiedModelPromptStrategy`**: Unified model with EDIT/INSERT/NO_CHANGE tags
- **`Xtab275PromptStrategy`**: Xtab275 variant with specific instructions
- **`Nes41Miniv3PromptStrategy`**: Nes41Miniv3 variant with EDIT/NO_CHANGE tags
- **`Codexv21NesUnifiedPromptStrategy`**: Codexv21NesUnified variant

## Usage

### Using Existing Strategies

The system is integrated into `XtabProvider` with a feature flag:

```typescript
// Enable modular prompts via configuration
const useModularPrompts = this.configService.getExperimentBasedConfig('inlineEdits.xtab.useModularPrompts', this.expService) ?? false;

const messages = useModularPrompts 
    ? this.createModularPrompt(request, taggedCurrentFileContent, areaAroundCodeToEdit, langCtx, computeTokens, promptOptions)
    : [/* legacy implementation */];
```

### Adding New Strategies

Creating a new prompt strategy is straightforward:

1. **Create a new strategy class**:

```typescript
import { PromptStrategyBase } from './promptStrategyBase';

export class MyCustomPromptStrategy extends PromptStrategyBase {
    protected getSystemPrompt(): string {
        return 'Your custom system prompt here';
    }

    protected shouldIncludeBackticks(): boolean {
        return true; // or false
    }

    protected getPostScript(currentFilePath: string): string {
        return `Custom post-script for ${currentFilePath}`;
    }

    protected buildUserPrompt(): string {
        // Use existing getUserPrompt or create custom logic
        return getUserPrompt(
            this.props.request,
            this.props.currentFileContent,
            this.props.areaAroundCodeToEdit,
            this.props.langCtx,
            this.props.computeTokens,
            this.props.opts
        );
    }
}
```

2. **Register the strategy**:

```typescript
import { registerPromptStrategy } from './promptStrategyRegistry';
import { PromptingStrategy } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';

// Add new enum value to PromptingStrategy
// Then register:
registerPromptStrategy(PromptingStrategy.MyCustomStrategy, MyCustomPromptStrategy);
```

3. **Update the strategy selection logic** in `XtabProvider.determinePromptingStrategy()` if needed.

## Benefits

### Modularity
- Each strategy is self-contained
- Easy to understand and modify individual strategies
- Clear separation of concerns

### Flexibility  
- Easy to experiment with different prompt variations
- A/B testing different strategies becomes trivial
- Can mix and match different aspects of strategies

### Extensibility
- Adding new strategies requires minimal code changes
- No need to modify existing switch statements
- Strategy registry automatically handles new strategies

### Maintainability
- No more large string concatenations
- No more complex switch statements
- Each strategy documents its own behavior
- Easy to test individual strategies

## Examples

See `examples/exampleCustomPromptStrategy.tsx` for a demonstration of how to create custom strategies.

## Migration

The system maintains backward compatibility:

- Existing `PromptingStrategy` enum values continue to work
- Legacy prompt construction remains available as fallback
- Gradual migration is possible via feature flags

## Future Enhancements

The TSX-based approach opens possibilities for:

- Token budget-aware prompt construction using `PromptSizing`
- Priority-based prompt component composition
- Dynamic prompt adaptation based on context
- Enhanced prompt debugging and introspection