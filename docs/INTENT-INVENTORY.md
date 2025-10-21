# Intent Inventory

## Registered Descriptors
File: [../src/extension/intents/node/allIntents.ts#L34-L58](../src/extension/intents/node/allIntents.ts#L34-L58)

```typescript
IntentRegistry.setIntents([
	new SyncDescriptor(InlineDocIntent),
	new SyncDescriptor(EditCodeIntent),
	new SyncDescriptor(EditCode2Intent),
	new SyncDescriptor(AgentIntent),
	new SyncDescriptor(SearchIntent),
```

```typescript
	new SyncDescriptor(WorkspaceIntent),
	new SyncDescriptor(TestsIntent),
	new SyncDescriptor(FixIntent),
	new SyncDescriptor(ExplainIntent),
	new SyncDescriptor(ReviewIntent),
	new SyncDescriptor(TerminalIntent),
```

```typescript
	new SyncDescriptor(TerminalExplainIntent),
	new SyncDescriptor(UnknownIntent),
	new SyncDescriptor(GenerateCodeIntent),
	new SyncDescriptor(NewNotebookIntent),
	new SyncDescriptor(NewWorkspaceIntent),
	new SyncDescriptor(VscodeIntent),
```

```typescript
	new SyncDescriptor(StartDebuggingIntent),
	new SyncDescriptor(SetupTestsIntent),
	new SyncDescriptor(SearchPanelIntent),
	new SyncDescriptor(SearchKeywordsIntent),
	new SyncDescriptor(AskAgentIntent),
	new SyncDescriptor(NotebookEditorIntent),
	new SyncDescriptor(ChatReplayIntent),
```

These descriptors cover inline documentation, editing, workspace operations, testing, debugging, search, terminal usage, agent hand-offs, and replay scenarios that ship with the extension today.

## Runtime Lookup
File: [../src/extension/intents/node/intentService.ts#L33-L55](../src/extension/intents/node/intentService.ts#L33-L55)

```typescript
private _getOrCreateIntents(): IIntent[] {
	if (!this._intents) {
		this._intents = IntentRegistry.getIntents().map(d => this._instantiationService.createInstance(d));
	}
	return this._intents;
}
```

```typescript
public getIntents(location: ChatLocation): IIntent[] {
	const intents = this._getOrCreateIntents();
	return intents.filter(i => i.locations.includes(location));
}

public getIntent(id: string, location: ChatLocation): IIntent | undefined {
	return this.getIntents(location).find(i => i.id === id);
}
```

The service instantiates descriptors lazily, filters by chat location (panel, editor, terminal), and resolves specific intents by identifier.

## Extensibility Steps

### Implement the Contract
File: [../src/extension/prompt/node/intents.ts#L54-L88](../src/extension/prompt/node/intents.ts#L54-L88)

```typescript
export interface IIntent {
	readonly id: string;
	readonly description: string;
	readonly locations: ChatLocation[];
	readonly commandInfo?: IIntentSlashCommandInfo;
	readonly isListedCapability?: boolean;
```

```typescript
	invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation>;
	// Optionally implement handleRequest when invoke is not used.
}
```

Define a class that fulfills this interface (deriving from an existing intent like `EditCodeIntent` when appropriate) and provide any custom invocation or request handling.

### Register the Descriptor
File: [../src/extension/prompt/node/intentRegistry.ts#L19-L27](../src/extension/prompt/node/intentRegistry.ts#L19-L27)

```typescript
export const IntentRegistry = new class {
	private _descriptors: SyncDescriptor<IIntent>[] = [];

	public setIntents(intentDescriptors: SyncDescriptor<IIntent>[]) {
		this._descriptors = this._descriptors.concat(intentDescriptors);
	}
```

Add a `new SyncDescriptor(MyIntent)` entry in `allIntents.ts` so the registry can supply your implementation to the service.

```typescript
	public getIntents(): readonly SyncDescriptor<IIntent>[] {
		return this._descriptors;
	}
}();
```

### Assign an Identifier
File: [../src/extension/common/constants.ts#L8-L35](../src/extension/common/constants.ts#L8-L35)

```typescript
export const enum Intent {
	Explain = 'explain',
	Review = 'review',
	Tests = 'tests',
	Fix = 'fix',
	New = 'new',
	NewNotebook = 'newNotebook',
```

```typescript
	SearchPanel = 'searchPanel',
	SearchKeywords = 'searchKeywords',
	AskAgent = 'askAgent',
	ChatReplay = 'chatReplay'
}
```

Choose or extend an identifier here, and update `agentsToCommands` if the slash-command routing or agent mapping needs to recognize the new value.

With these steps—implementing the interface, registering a descriptor, and adding an identifier—the new intent participates in the same runtime plumbing as the built-in catalog.
