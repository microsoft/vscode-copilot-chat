Invoke agent span
Status:Development

Describes GenAI agent invocation.

The gen_ai.operation.name SHOULD be invoke_agent.

Span name SHOULD be invoke_agent {gen_ai.agent.name} if gen_ai.agent.name is readily available. When gen_ai.agent.name is not available, it SHOULD be invoke_agent. Semantic conventions for individual GenAI systems and frameworks MAY specify different span name format.

Span kind SHOULD be CLIENT and MAY be set to INTERNAL on spans representing invocation of agents running in the same process. It’s RECOMMENDED to use CLIENT kind when the agent being instrumented usually runs in a different process than its caller or when the agent invocation happens over instrumented protocol such as HTTP.

Examples of span kinds for different agent scenarios:

CLIENT: Remote agent services (e.g., OpenAI Assistants API, AWS Bedrock Agents)
INTERNAL: In-process agents (e.g., LangChain agents, CrewAI agents)
Span status SHOULD follow the Recording Errors document.

Attributes:

Key	Stability	Requirement Level	Value Type	Description	Example Values
gen_ai.operation.name	Development	Required	string	The name of the operation being performed. [1]	chat; generate_content; text_completion
gen_ai.provider.name	Development	Required	string	The Generative AI provider as identified by the client or server instrumentation. [2]	openai; gcp.gen_ai; gcp.vertex_ai
error.type	Stable	Conditionally Required if the operation ended in an error	string	Describes a class of error the operation ended with. [3]	timeout; java.net.UnknownHostException; server_certificate_invalid; 500
gen_ai.agent.description	Development	Conditionally Required when available	string	Free-form description of the GenAI agent provided by the application.	Helps with math problems; Generates fiction stories
gen_ai.agent.id	Development	Conditionally Required if applicable.	string	The unique identifier of the GenAI agent.	asst_5j66UpCpwteGg4YSxUnt7lPY
gen_ai.agent.name	Development	Conditionally Required when available	string	Human-readable name of the GenAI agent provided by the application.	Math Tutor; Fiction Writer
gen_ai.agent.version	Development	Conditionally Required when available	string	The version of the GenAI agent.	1.0.0; 2025-05-01
gen_ai.conversation.id	Development	Conditionally Required when available	string	The unique identifier for a conversation (session, thread), used to store and correlate messages within this conversation. [4]	conv_5j66UpCpwteGg4YSxUnt7lPY
gen_ai.data_source.id	Development	Conditionally Required if applicable.	string	The data source identifier. [5]	H7STPQYOND
gen_ai.output.type	Development	Conditionally Required [6]	string	Represents the content type requested by the client. [7]	text; json; image
gen_ai.request.choice.count	Development	Conditionally Required if available, in the request, and !=1	int	The target number of candidate completions to return.	3
gen_ai.request.model	Development	Conditionally Required If available.	string	The name of the GenAI model a request is being made to. [8]	gpt-4
gen_ai.request.seed	Development	Conditionally Required if applicable and if the request includes a seed	int	Requests with same seed value more likely to return same result.	100
server.port	Stable	Conditionally Required If server.address is set.	int	GenAI server port. [9]	80; 8080; 443
gen_ai.request.frequency_penalty	Development	Recommended	double	The frequency penalty setting for the GenAI request.	0.1
gen_ai.request.max_tokens	Development	Recommended	int	The maximum number of tokens the model generates for a request.	100
gen_ai.request.presence_penalty	Development	Recommended	double	The presence penalty setting for the GenAI request.	0.1
gen_ai.request.stop_sequences	Development	Recommended	string[]	List of sequences that the model will use to stop generating further tokens.	["forest", "lived"]
gen_ai.request.temperature	Development	Recommended	double	The temperature setting for the GenAI request.	0.0
gen_ai.request.top_p	Development	Recommended	double	The top_p sampling setting for the GenAI request.	1.0
gen_ai.response.finish_reasons	Development	Recommended	string[]	Array of reasons the model stopped generating tokens, corresponding to each generation received.	["stop"]; ["stop", "length"]
gen_ai.response.id	Development	Recommended	string	The unique identifier for the completion.	chatcmpl-123
gen_ai.response.model	Development	Recommended	string	The name of the model that generated the response. [10]	gpt-4-0613
gen_ai.usage.cache_creation.input_tokens	Development	Recommended	int	The number of input tokens written to a provider-managed cache. [11]	25
gen_ai.usage.cache_read.input_tokens	Development	Recommended	int	The number of input tokens served from a provider-managed cache. [12]	50
gen_ai.usage.input_tokens	Development	Recommended	int	The number of tokens used in the GenAI input (prompt). [13]	100
gen_ai.usage.output_tokens	Development	Recommended	int	The number of tokens used in the GenAI response (completion).	180
server.address	Stable	Recommended when span kind is CLIENT.	string	GenAI server address. [14]	example.com; 10.1.2.80; /tmp/my.sock
gen_ai.input.messages	Development	Opt-In	any	The chat history provided to the model as an input. [15]	[
  {
    “role”: “user”,
    “parts”: [
      {
        “type”: “text”,
        “content”: “Weather in Paris?"
      }
    ]
  },
  {
    “role”: “assistant”,
    “parts”: [
      {
        “type”: “tool_call”,
        “id”: “call_VSPygqKTWdrhaFErNvMV18Yl”,
        “name”: “get_weather”,
        “arguments”: {
          “location”: “Paris”
        }
      }
    ]
  },
  {
    “role”: “tool”,
    “parts”: [
      {
        “type”: “tool_call_response”,
        “id”: " call_VSPygqKTWdrhaFErNvMV18Yl”,
        “result”: “rainy, 57°F”
      }
    ]
  }
]
gen_ai.output.messages	Development	Opt-In	any	Messages returned by the model where each message represents a specific model response (choice, candidate). [16]	[
  {
    “role”: “assistant”,
    “parts”: [
      {
        “type”: “text”,
        “content”: “The weather in Paris is currently rainy with a temperature of 57°F."
      }
    ],
    “finish_reason”: “stop”
  }
]
gen_ai.system_instructions	Development	Opt-In	any	The system message or instructions provided to the GenAI model separately from the chat history. [17]	[
  {
    “type”: “text”,
    “content”: “You are an Agent that greet users, always use greetings tool to respond”
  }
]; [
  {
    “type”: “text”,
    “content”: “You are a language translator."
  },
  {
    “type”: “text”,
    “content”: “Your mission is to translate text in English to French."
  }
]
gen_ai.tool.definitions	Development	Opt-In	any	The list of source system tool definitions available to the GenAI agent or model. [18]	[
  {
    “type”: “function”,
    “name”: “get_current_weather”,
    “description”: “Get the current weather in a given location”,
    “parameters”: {
      “type”: “object”,
      “properties”: {
        “location”: {
          “type”: “string”,
          “description”: “The city and state, e.g. San Francisco, CA”
        },
        “unit”: {
          “type”: “string”,
          “enum”: [
            “celsius”,
            “fahrenheit”
          ]
        }
      },
      “required”: [
        “location”,
        “unit”
      ]
    }
  }
]
[1] gen_ai.operation.name: If one of the predefined values applies, but specific system uses a different name it’s RECOMMENDED to document it in the semantic conventions for specific GenAI system and use system-specific name in the instrumentation. If a different name is not documented, instrumentation libraries SHOULD use applicable predefined value.

[2] gen_ai.provider.name: The attribute SHOULD be set based on the instrumentation’s best knowledge and may differ from the actual model provider.

Multiple providers, including Azure OpenAI, Gemini, and AI hosting platforms are accessible using the OpenAI REST API and corresponding client libraries, but may proxy or host models from different providers.

The gen_ai.request.model, gen_ai.response.model, and server.address attributes may help identify the actual system in use.

The gen_ai.provider.name attribute acts as a discriminator that identifies the GenAI telemetry format flavor specific to that provider within GenAI semantic conventions. It SHOULD be set consistently with provider-specific attributes and signals. For example, GenAI spans, metrics, and events related to AWS Bedrock should have the gen_ai.provider.name set to aws.bedrock and include applicable aws.bedrock.* attributes and are not expected to include openai.* attributes.

[3] error.type: The error.type SHOULD match the error code returned by the Generative AI provider or the client library, the canonical name of exception that occurred, or another low-cardinality error identifier. Instrumentations SHOULD document the list of errors they report.

[4] gen_ai.conversation.id: Instrumentations SHOULD populate conversation id when they have it readily available for a given operation, for example:

when client framework being instrumented manages conversation history (see LlamaIndex chat store)
when instrumenting GenAI client libraries that maintain conversation on the backend side (see AWS Bedrock agent sessions, OpenAI Assistant threads)
Application developers that manage conversation history MAY add conversation id to GenAI and other spans or logs using custom span or log record processors or hooks provided by instrumentation libraries.

[5] gen_ai.data_source.id: Data sources are used by AI agents and RAG applications to store grounding data. A data source may be an external database, object store, document collection, website, or any other storage system used by the GenAI agent or application. The gen_ai.data_source.id SHOULD match the identifier used by the GenAI system rather than a name specific to the external storage, such as a database or object store. Semantic conventions referencing gen_ai.data_source.id MAY also leverage additional attributes, such as db.*, to further identify and describe the data source.

[6] gen_ai.output.type: when applicable and if the request includes an output format.

[7] gen_ai.output.type: This attribute SHOULD be used when the client requests output of a specific type. The model may return zero or more outputs of this type. This attribute specifies the output modality and not the actual output format. For example, if an image is requested, the actual output could be a URL pointing to an image file. Additional output format details may be recorded in the future in the gen_ai.output.{type}.* attributes.

[8] gen_ai.request.model: The name of the GenAI model a request is being made to. If the model is supplied by a vendor, then the value must be the exact name of the model requested. If the model is a fine-tuned custom model, the value should have a more specific name than the base model that’s been fine-tuned.

[9] server.port: When observed from the client side, and when communicating through an intermediary, server.port SHOULD represent the server port behind any intermediaries, for example proxies, if it’s available.

[10] gen_ai.response.model: If available. The name of the GenAI model that provided the response. If the model is supplied by a vendor, then the value must be the exact name of the model actually used. If the model is a fine-tuned custom model, the value should have a more specific name than the base model that’s been fine-tuned.

[11] gen_ai.usage.cache_creation.input_tokens: The value SHOULD be included in gen_ai.usage.input_tokens.

[12] gen_ai.usage.cache_read.input_tokens: The value SHOULD be included in gen_ai.usage.input_tokens.

[13] gen_ai.usage.input_tokens: This value SHOULD include all types of input tokens, including cached tokens. Instrumentations SHOULD make a best effort to populate this value, using a total provided by the provider when available or, depending on the provider API, by summing different token types parsed from the provider output.

[14] server.address: When observed from the client side, and when communicating through an intermediary, server.address SHOULD represent the server address behind any intermediaries, for example proxies, if it’s available.

[15] gen_ai.input.messages: Instrumentations MUST follow Input messages JSON schema. When the attribute is recorded on events, it MUST be recorded in structured form. When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported and SHOULD be recorded in structured form otherwise.

Messages MUST be provided in the order they were sent to the model. Instrumentations MAY provide a way for users to filter or truncate input messages.

Warning
This attribute is likely to contain sensitive information including user/PII data.

See Recording content on attributes section for more details.

[16] gen_ai.output.messages: Instrumentations MUST follow Output messages JSON schema

Each message represents a single output choice/candidate generated by the model. Each message corresponds to exactly one generation (choice/candidate) and vice versa - one choice cannot be split across multiple messages or one message cannot contain parts from multiple choices.

When the attribute is recorded on events, it MUST be recorded in structured form. When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported and SHOULD be recorded in structured form otherwise.

Instrumentations MAY provide a way for users to filter or truncate output messages.

Warning
This attribute is likely to contain sensitive information including user/PII data.

See Recording content on attributes section for more details.

[17] gen_ai.system_instructions: This attribute SHOULD be used when the corresponding provider or API allows to provide system instructions or messages separately from the chat history.

Instructions that are part of the chat history SHOULD be recorded in gen_ai.input.messages attribute instead.

Instrumentations MUST follow System instructions JSON schema.

When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported and SHOULD be recorded in structured form otherwise.

Instrumentations MAY provide a way for users to filter or truncate system instructions.

Warning
This attribute may contain sensitive information.

See Recording content on attributes section for more details.

[18] gen_ai.tool.definitions: The value of this attribute matches source system tool definition format.

It’s expected to be an array of objects where each object represents a tool definition. In case a serialized string is available to the instrumentation, the instrumentation SHOULD do the best effort to deserialize it to an array. When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported and SHOULD be recorded in structured form otherwise.

Since this attribute could be large, it’s NOT RECOMMENDED to populate it by default. Instrumentations MAY provide a way to enable populating this attribute.

The following attributes can be important for making sampling decisions and SHOULD be provided at span creation time (if provided at all):

gen_ai.operation.name
gen_ai.provider.name
gen_ai.request.model
server.address
server.port
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
gen_ai.output.type has the following list of well-known values. If one of them applies, then the respective value MUST be used; otherwise, a custom value MAY be used.

Value	Description	Stability
image	Image	Development
json	JSON object with known or unknown schema	Development
speech	Speech	Development
text	Plain text	Development
gen_ai.provider.name has the following list of well-known values. If one of them applies, then the respective value MUST be used; otherwise, a custom value MAY be used.

Value	Description	Stability
anthropic	Anthropic	Development
aws.bedrock	AWS Bedrock	Development
azure.ai.inference	Azure AI Inference	Development
azure.ai.openai	Azure OpenAI	Development
cohere	Cohere	Development
deepseek	DeepSeek	Development
gcp.gemini	Gemini [19]	Development
gcp.gen_ai	Any Google generative AI endpoint [20]	Development
gcp.vertex_ai	Vertex AI [21]	Development
groq	Groq	Development
ibm.watsonx.ai	IBM Watsonx AI	Development
mistral_ai	Mistral AI	Development
openai	OpenAI	Development
perplexity	Perplexity	Development
x_ai	xAI	Development
[19]: Used when accessing the ‘generativelanguage.googleapis.com’ endpoint. Also known as the AI Studio API.

[20]: May be used when specific backend is unknown.

[21]: Used when accessing the ‘aiplatform.googleapis.com’ endpoint.