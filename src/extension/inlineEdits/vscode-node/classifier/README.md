# Inline Completion Classifier

This module provides a classifier that determines whether the inline completion provider should proceed with generating suggestions based on the document content and cursor position.

## Features

- **ONNX Runtime Integration**: Uses ONNX models for sophisticated classification decisions
- **Tokenizer Support**: Integrates with Hugging Face transformers for text preprocessing
- **Mock Classifier Fallback**: Falls back to a rule-based mock classifier when ONNX model is not available
- **Comprehensive Logging**: Provides detailed logging of classification decisions and performance metrics

## Usage

The classifier is automatically initialized when the `InlineCompletionProviderImpl` is instantiated. It runs before any inline completion processing begins.

## Configuration

### Using Your Own ONNX Model

1. Place your `.onnx` model file in the desired location
2. Update the `modelPath` parameter in the `InlineCompletionClassifier` constructor
3. Ensure your model expects the same input format (tokenized text with input_ids and attention_mask)
4. Adjust the output processing logic if your model has different output structure

### Example Model Path Configuration

```typescript
// In inlineCompletionProvider.ts constructor
this._classifier = new InlineCompletionClassifier(
    this._logService,
    '/path/to/your/model.onnx'  // Custom model path
);
```

## Model Requirements

Your ONNX model should:
- Accept tokenized text inputs (`input_ids` and `attention_mask`)
- Output logits for binary classification (proceed/don't proceed)
- Be compatible with the tokenizer you specify (default: `distilbert-base-uncased`)

## Mock Classifier

When no ONNX model is available, the system falls back to a rule-based mock classifier that:
- Skips completion for empty lines
- Skips completion for comment lines
- Skips completion for import/export statements
- Provides lower confidence for very short lines

## Logging

The classifier logs:
- Initialization status
- Classification decisions with confidence scores
- Processing time for each classification
- Errors and fallback behaviors

Check the VS Code developer console for detailed logs.

## Performance

- Mock classifier: ~1-5ms per classification
- ONNX classifier: ~10-100ms per classification (depending on model complexity)
- Classification results are logged to help you tune performance vs accuracy