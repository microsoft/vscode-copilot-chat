Execute tool span
Status:Development

Describes tool execution span.

gen_ai.operation.name SHOULD be execute_tool.

Span name SHOULD be execute_tool {gen_ai.tool.name}.

GenAI instrumentations that can instrument tool execution calls SHOULD do so, unless another instrumentation can reliably cover all supported tool types. MCP tool executions may also be traced by the corresponding MCP instrumentation.

Tools are often executed directly by application code. Application developers are encouraged to follow this semantic convention for tools invoked by their own code and to manually instrument any tool calls that automatic instrumentations do not cover.

Span kind SHOULD be INTERNAL.

Span status SHOULD follow the Recording Errors document.

Attributes:

Key	Stability	Requirement Level	Value Type	Description	Example Values
gen_ai.operation.name	Development	Required	string	The name of the operation being performed. [1]	chat; generate_content; text_completion
error.type	Stable	Conditionally Required if the operation ended in an error	string	Describes a class of error the operation ended with. [2]	timeout; java.net.UnknownHostException; server_certificate_invalid; 500
gen_ai.tool.call.id	Development	Recommended if available	string	The tool call identifier.	call_mszuSIzqtI65i1wAUOE8w5H4
gen_ai.tool.description	Development	Recommended if available	string	The tool description.	Multiply two numbers
gen_ai.tool.name	Development	Recommended	string	Name of the tool utilized by the agent.	Flights
gen_ai.tool.type	Development	Recommended if available	string	Type of the tool utilized by the agent [3]	function; extension; datastore
gen_ai.tool.call.arguments	Development	Opt-In	any	Parameters passed to the tool call. [4]	{
    “location”: “San Francisco?”,
    “date”: “2025-10-01”
}
gen_ai.tool.call.result	Development	Opt-In	any	The result returned by the tool call (if any and if execution was successful). [5]	{
  “temperature_range”: {
    “high”: 75,
    “low”: 60
  },
  “conditions”: “sunny”
}
[1] gen_ai.operation.name: If one of the predefined values applies, but specific system uses a different name it’s RECOMMENDED to document it in the semantic conventions for specific GenAI system and use system-specific name in the instrumentation. If a different name is not documented, instrumentation libraries SHOULD use applicable predefined value.

[2] error.type: The error.type SHOULD match the error code returned by the Generative AI provider or the client library, the canonical name of exception that occurred, or another low-cardinality error identifier. Instrumentations SHOULD document the list of errors they report.

[3] gen_ai.tool.type: Extension: A tool executed on the agent-side to directly call external APIs, bridging the gap between the agent and real-world systems. Agent-side operations involve actions that are performed by the agent on the server or within the agent’s controlled environment. Function: A tool executed on the client-side, where the agent generates parameters for a predefined function, and the client executes the logic. Client-side operations are actions taken on the user’s end or within the client application. Datastore: A tool used by the agent to access and query structured or unstructured external data for retrieval-augmented tasks or knowledge updates.

[4] gen_ai.tool.call.arguments:

Warning
This attribute may contain sensitive information.

It’s expected to be an object - in case a serialized string is available to the instrumentation, the instrumentation SHOULD do the best effort to deserialize it to an object. When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported and SHOULD be recorded in structured form otherwise.

[5] gen_ai.tool.call.result:

Warning
This attribute may contain sensitive information.

It’s expected to be an object - in case a serialized string is available to the instrumentation, the instrumentation SHOULD do the best effort to deserialize it to an object. When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported and SHOULD be recorded in structured form otherwise.

The following attributes can be important for making sampling decisions and SHOULD be provided at span creation time (if provided at all):

gen_ai.operation.name
error.type has the following list of well-known values. If one of them applies, then the respective value MUST be used; otherwise, a custom value MAY be used.

Value	Description	Stability
_OTHER	A fallback error value to be used when the instrumentation doesn’t define a custom value.	Stable
gen_ai.operation.name has the following list of well-known values. If one of them applies, then the respective value MUST be used; otherwise, a custom value MAY be used.

Value	Description	Stability
chat	Chat completion operation such as OpenAI Chat API	Development
create_agent	Create GenAI agent	Development
embeddings	Embeddings operation such as OpenAI Create embeddings API	Development
execute_tool	Execute a tool	Development
generate_content	Multimodal content generation operation such as Gemini Generate Content	Development
invoke_agent	Invoke GenAI agent	Development
retrieval	Retrieval operation such as OpenAI Search Vector Store API	Development
text_completion	Text completions operation such as OpenAI Completions API (Legacy)	Development