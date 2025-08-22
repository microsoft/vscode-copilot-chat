# @vscode/chat-lib

Chat and inline editing SDK extracted from VS Code Copilot Chat.

## Installation

```bash
npm install @vscode/chat-lib
```

## Usage

```typescript
import { LineRange, Position, Observable } from '@vscode/chat-lib';

// Use the SDK with custom service implementations
const range = new LineRange(1, 10);
const position = new Position(5, 0);
```

## License

MIT