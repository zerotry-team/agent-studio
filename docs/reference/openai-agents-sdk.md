# OpenAI Agents API (beta): `openai` SDK v7.19.0 reference

Source of truth: the type definitions in `node_modules/openai` v7.19.0
(`resources/beta/agents/**`, `lib/agents/**`, `core/streaming.mjs`, `resources/webhooks/**`).
Anything marked **not present** does not exist in the SDK types for this version.
Optional fields are marked `?`. `T | null` means the server may return (or accept) `null`.

> **Runtime:** the `openai@7.19.0` `package.json` declares `"engines": { "node": ">=22.0.0" }`.
> This repo pins `.nvmrc` to `22` but its root `package.json` allows `>=20.19.0`. Plan for Node 22+.

Types: `import type { AgentSession } from 'openai/resources/beta/agents/agents'` or `OpenAI.Beta.Agents.AgentSession`
(both type-check with `--module nodenext`).

---

## 1. Client and beta header

```ts
const client = new OpenAI({ apiKey?, organization?, project?, baseURL?, timeout?, maxRetries?, defaultHeaders?, webhookSecret? });
// default env vars: OPENAI_API_KEY, OPENAI_ORG_ID, OPENAI_PROJECT_ID, OPENAI_BASE_URL, OPENAI_WEBHOOK_SECRET
```

- **The SDK adds `OpenAI-Beta: agents=v1` automatically** on every `client.beta.agents.*` request. Every
  method in `resources/beta/agents/**/*.mjs` calls `buildHeaders([{ 'OpenAI-Beta': 'agents=v1' }, options?.headers])`.
  You don't need to set it yourself.
- `sessions.events.stream` also sends `Accept: text/event-stream`, and `artifacts.content` sends `Accept: application/octet-stream`.
- Routes: `/agents`, `/agents/sessions[/{id}/events|turns|items|artifacts|subagents]`, `/agents/environments[/templates]`,
  `/vaults[/{id}/credentials]`. Updates use **POST** (for example `POST /agents/sessions/{id}`). No method uses PATCH.

## 2. `sessions.create`

```ts
client.beta.agents.sessions.create(body: SessionCreateParamsNonStreaming, options?): APIPromise<AgentSession>
client.beta.agents.sessions.create(body: SessionCreateParamsStreaming,    options?): APIPromise<Stream<AgentSessionEvent>>

interface SessionCreateParamsBase {
  environment: EnvironmentParam;                      // REQUIRED
  agent?: SessionCreateParams.Agent;                  // inline config, or overrides for agent_id
  agent_id?: string;                                  // saved agent; omit `agent` to use it unchanged
  input?: string | Array<AgentSessionInputMessageParam> | null;  // initial input; starts a turn
  metadata?: { [key: string]: string } | null;        // <=16 pairs, key <=64 chars, value <=512 chars
  stream?: boolean;                                   // default false; true => SSE Stream<AgentSessionEvent>
  vault_ids?: Array<string> | null;                   // vaults whose credentials MCP tools may use
}

namespace SessionCreateParams {
  interface Agent {            // "With agent_id, supplied fields override the saved agent. Without agent_id, model is required."
    model?: string;
    instructions?: string | null;             // appended to the default base instructions
    reasoning?: AgentReasoningParam | null;
    text?: AgentTextParam | null;
    tools?: Array<AgentToolParam> | null;     // omit = inherit from agent_id, null = clear
    service_tier?: 'auto' | 'default' | 'flex' | 'priority' | 'fast' | null;
    multi_agent?: MultiAgentConfigParam | null;
    // NOTE: no `name` and no `metadata` here (those exist only on saved agents / session metadata)
  }
}
```

### `EnvironmentParam` (discriminated on `type`)

```ts
type EnvironmentParam = EnvironmentParamNone | EnvironmentParamOpenAIHosted | EnvironmentParamSelfHosted;

interface EnvironmentParamNone { type: 'none' }        // no execution environment

interface EnvironmentParamSelfHosted {                 // YOU run the executor
  type: 'self_hosted';
  workspace_directory: string;                         // REQUIRED, absolute path inside your environment
  capability_directories?: Array<string> | null;       // default []
  // Not present for self_hosted: packages, setup_commands, files, env, network, skills, plugins, environment_template_id
}

interface EnvironmentParamOpenAIHosted {               // OpenAI runs the sandbox
  type: 'openai_hosted';
  environment_template_id?: string;                    // template applied first; omitted fields inherit from it;
                                                       // network overrides cannot broaden the template's policy
  capability_directories?: Array<string> | null;
  env?: { [key: string]: string } | null;
  files?: Array<HostedEnvironmentFileParam> | null;    // default []
  network?: { access: 'enabled' | 'disabled' | 'restricted'; allowed_domains?: Array<string> | null } | null;
  packages?: { npm?: string[] | null; python?: string[] | null; system?: string[] | null } | null;
  plugins?: Array<HostedPluginParam> | null;
  setup_commands?: Array<SetupCommandParam> | null;    // ordered, confidential; bodies are never returned
  skills?: Array<HostedSkillParam> | null;
}

type HostedEnvironmentFileParam =
  | { type: 'file_id'; file_id: string; path: string }  // Files API upload; path is absolute and inside /workspace
  | { type: 'inline'; data: string; path: string };     // standard base64 data
interface SetupCommandParam { command: string; cwd?: string | null }   // cwd defaults to /workspace
type HostedSkillParam =
  | { type: 'skill_reference'; skill_id: string; version?: string | null }  // positive integer string or 'latest'
  | { type: 'inline'; name: string; description: string; source: InlineCapabilitySourceParam };
interface HostedPluginParam { type: 'inline'; name: string; description: string; source: InlineCapabilitySourceParam }
  // name and description must match .codex-plugin/plugin.json (skills: SKILL.md)
interface InlineCapabilitySourceParam { type: 'base64'; media_type: 'application/zip'; data: string }
```

### `input` format

```ts
input: 'plain text'   // string => normalized to one user message
input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]   // AgentSessionInputMessageParam[]

interface AgentSessionInputMessageParam {
  role: 'user';
  content: Array<InputContentParam>;
  type?: 'message';
}
type InputContentParam =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string };   // URL or base64 data URL
```

Other session methods:

```ts
sessions.retrieve(sessionID: string, options?): APIPromise<AgentSession>
sessions.update(sessionID: string, body?: SessionUpdateParams | null, options?): APIPromise<AgentSession>
  interface SessionUpdateParams {
    agent?: { model?: string; reasoning?: { effort?: Effort | null }; service_tier?: ServiceTier | null };  // applies to later turns
    metadata?: { [k: string]: string } | null;   // replaces all; null or {} clears
  }
sessions.list(query?: { agent_id?: string; after?: string; limit?: number | null; order?: 'asc' | 'desc' }): PagePromise<CursorPage<AgentSession>>
sessions.delete(sessionID: string, options?): APIPromise<AgentSessionDeleted>
  // { id: string; deleted: boolean; object: 'agent.session.deleted' }
  // If backend execution has already ended, delete can cancel a still-open turn and drop outputs that were not yet published.
  // "Running execution must be cancelled first." Physical cleanup may finish later.
```

`Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`;
`ServiceTier = 'auto' | 'default' | 'flex' | 'priority' | 'fast'`.

## 3. `AgentSession` object

```ts
interface AgentSession {
  id: string;
  object: 'agent.session';
  status: 'idle' | 'in_progress' | 'requires_action' | 'failed';
        // idle: no turn running and ready for input (a hosted env may still be provisioning)
  agent: AgentSession.Agent;               // resolved snapshot (see below)
  environment: Environment;                // see below; NOTE: has NO status field
  required_actions: Array<SessionRequiredActionResourceFunctionCall | SessionRequiredActionResourceEnvironmentConnection>;
  error: string | null;                    // why the session failed
  usage: TokenUsage | null;                // best effort
  metadata: { [key: string]: string };
  vault_ids: Array<string>;
  created_at: number;                      // unix seconds
  last_active_at: number;
}

namespace AgentSession {
  interface Agent {
    id: string; name: string | null; model: string; instructions: string | null;
    reasoning: AgentReasoning; text: AgentText; tools: Array<AgentTool>;
    service_tier: 'auto' | 'default' | 'flex' | 'priority' | 'fast'; multi_agent: MultiAgentConfig;
  }
  interface SessionRequiredActionResourceFunctionCall {   // "Run a function tool and submit its result."
    type: 'function_call';
    call_id: string;          // echo this in agent.session.input.tool_result
    turn_id: string;          // echo this in agent.session.input.tool_result
    name: string;
    arguments: unknown;       // typed unknown: may be a JSON string or an object (the SDK helper handles both)
  }
  interface SessionRequiredActionResourceEnvironmentConnection {   // "Reconnect a session environment."
    type: 'environment_connection';
    environment_id: string;
  }
}
```

There are exactly **two** required-action types: `function_call` and `environment_connection`. No client event
resolves `environment_connection`. It is resolved by (re)connecting the self-hosted executor to the environment's
`remote_url`. That is an inference from the doc comments; the types show no other mechanism.

### `Environment` (as returned on the session)

```ts
type Environment =
  | { type: 'none' }
  | { type: 'openai_hosted'; id: string; capability_directories: string[]; files: HostedEnvironmentFile[];
      network: { access: 'enabled' | 'disabled' | 'restricted'; allowed_domains: string[] };
      packages: { npm: string[]; python: string[]; system: string[] };
      plugins: HostedPlugin[]; skills: HostedSkill[] }
  | { type: 'self_hosted'; id: string; capability_directories: string[];
      remote_url: string;             // "Pass this URL unchanged to `codex exec-server --remote`"
      workspace_directory: string };  // default /workspace

type HostedEnvironmentFile =
  | { type: 'file_id'; id: string; file_id: string; path: string; size_bytes: number }
  | { type: 'inline'; id: string; path: string; size_bytes: number };
interface HostedPlugin { type: 'inline'; name: string; description: string }
type HostedSkill =
  | { type: 'skill_reference'; skill_id: string; name: string; description: string; version: string }
  | { type: 'inline'; name: string; description: string };
```

**Environment status is not on `AgentSession`.** Two sources:
- Stream events `agent.session.environment.*`, each carrying `environment: AgentSessionEnvironmentState` (§5).
- `client.beta.agents.environments.retrieve(id)` → `EnvironmentInfo.status` (§10).

`remote_url` appears **only** on `AgentSession.environment` when `type === 'self_hosted'`. It is not on `EnvironmentInfo`.

## 4. `sessions.events.create` (client → session)

```ts
client.beta.agents.sessions.events.create(sessionID: string, params: EventCreateParams, options?): APIPromise<void>
// HTTP 202 means the event was accepted, not that it finished.

interface EventCreateParams {
  events: Array<AgentSessionInputParam>;   // body
  'Idempotency-Key'?: string;              // sent as a header; makes retries of submitted messages idempotent
}

type AgentSessionInputParam =
  | { type: 'agent.session.input.message'; input: Array<AgentSessionInputMessageParam> }   // adds user messages and starts a turn
  | { type: 'agent.session.input.cancel' }                                                  // cancels the active turn
  | { type: 'agent.session.input.tool_result';                                              // submits a function result
      turn_id: string;
      call_id: string;
      success: boolean;
      output?: AgentFunctionCallOutputParam | null;
      error?: string | null;                 // message when success === false
    };

type AgentFunctionCallOutputParam = string | Array<InputContentParam>;   // text, or input_text/input_image parts
```

- These are the **only** three client event types. The SDK has no approval, interrupt or steer event,
  and no event that resolves an environment connection.
- Cancel: "can recover a still-open turn whose backend execution has ended by marking it cancelled and
  abandoning unpublished outputs. Saved results, published files and existing terminal outcomes are kept."
- If you send `input.message` while a turn is running, it may fail with turn error code `active_turn_not_steerable` (§9).

## 5. `sessions.events.stream` and `AgentSessionEvent`

```ts
client.beta.agents.sessions.events.stream(sessionID: string, options?): APIPromise<Stream<AgentSessionEvent>>
// GET /agents/sessions/{id}/events (live events; no cursor or replay params exist in the types)
// Stream<T>: AsyncIterable<T>, .controller: AbortController, .tee(), .toReadableStream()
```

**SSE decoding caveat (`core/streaming.mjs`):** when the SSE `event:` name is `error`, or the JSON has a truthy
top-level `error` field, the iterator **throws `APIError`** and does not yield the event. In practice
`{ type: 'error' }` (`AgentSessionErrorEvent`) reaches you as an exception, so wrap `for await` in `try/catch`.
Breaking out of `for await` aborts the HTTP request. It does **not** cancel the turn.

Common fields: every event has `event_id: string` and `type`. Most events also have `session_id: string`, and
turn-scoped events have `turn_id`.

| `type` | Key fields (besides `event_id`) |
|---|---|
| `agent.session.created` | `session: AgentSession` |
| `agent.session.in_progress` | `session: AgentSession` |
| `agent.session.idle` | `session: AgentSession` |
| `agent.session.requires_action` | `session: AgentSession` (read `session.required_actions`) |
| `agent.session.failed` | `session: AgentSession` (`session.error`) |
| `error` | `session_id`, `error: SessionError { code: string\|null; message; param: string\|null; type }` (thrown by the SDK, see above) |
| `agent.session.turn.created` | `session_id, turn_id, turn: Turn` |
| `agent.session.turn.in_progress` | `session_id, turn_id, turn: Turn` |
| `agent.session.turn.completed` | `session_id, turn_id, turn: Turn, usage: TokenUsage\|null` |
| `agent.session.turn.failed` | `session_id, turn_id, turn: Turn (turn.error: SessionTurnError), usage` |
| `agent.session.turn.cancelled` | `session_id, turn_id, turn: Turn, usage` |
| `agent.session.turn.item.added` | `session_id, turn_id: string\|null, output_index: number\|null, item: AgentSessionItem` |
| `agent.session.turn.item.done` | `session_id, turn_id\|null, output_index: number, item: AgentOutputItem` |
| `agent.session.turn.content_part.added` | `item_id, output_index, content_index, part: OutputText, session_id, turn_id\|null` |
| `agent.session.turn.content_part.done` | same as added (`part` is complete) |
| `agent.session.turn.output_text.delta` | `item_id, output_index, content_index, delta: string, session_id, turn_id\|null` |
| `agent.session.turn.output_text.done` | `item_id, output_index, content_index, text: string, session_id, turn_id\|null` |
| `agent.session.turn.reasoning_summary_part.added` | `item_id, output_index, summary_index, part: SummaryText, ...` |
| `agent.session.turn.reasoning_summary_part.done` | `... part: SummaryText, status: 'incomplete' \| null` |
| `agent.session.turn.reasoning_summary_text.delta` | `item_id, output_index, summary_index, delta, ...` |
| `agent.session.turn.reasoning_summary_text.done` | `item_id, output_index, summary_index, text, ...` |
| `agent.output.command_execution_output.delta` | `item_id, output_index, delta, session_id, turn_id\|null` (note the `agent.output.` prefix) |
| `agent.session.environment.pending` | `session_id, turn_id\|null, environment: AgentSessionEnvironmentState` |
| `agent.session.environment.ready` | same (hosted env ready to connect) |
| `agent.session.environment.connected` | same |
| `agent.session.environment.disconnected` | same |
| `agent.session.environment.failed` | same (`environment.error`) |
| `agent.session.subagent.created` | `subagent: Subagent` |
| `agent.session.subagent.active` | `subagent: Subagent` (closed subagent resumed) |
| `agent.session.subagent.closed` | `subagent: Subagent` |

The union has 30 members. No event type exists for approvals, usage-only updates, or function-call argument deltas.

```ts
interface AgentSessionEnvironmentState {
  id: string;
  type: string;                                                   // plain string, not a literal union
  status: 'pending' | 'ready' | 'connected' | 'disconnected' | 'failed';
  error: { code: string; message: string; type: string } | null;
}
interface TokenUsage {
  input_tokens: number; output_tokens: number; total_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}
interface Subagent {
  id: string; object: 'agent.session.subagent'; session_id: string; parent_agent_id: string;
  name: string | null; instructions: AgentContent[] | null; status: 'active' | 'closed';
  opened_at: number; closed_at: number | null;
}
```

Turn events also fire for **subagent turns**. Check `event.turn.subagent_id === null` to find the root
(coordinator) turn.

## 6. `sessions.stream(...)`: the `AgentSessionStream` helper (`lib/agents/agent-session-stream`)

```ts
client.beta.agents.sessions.stream(sessionID: string, params: AgentSessionStreamParams, options?): AgentSessionStream

interface AgentSessionStreamParams {
  input: string | AgentSessionInputMessageParam[];       // must not be empty
  toolHandlers?: Record<string, AgentToolHandler>;       // keyed by function name
  idempotencyKey?: string;                               // for the input submission only
}
type AgentToolHandler = (arguments_: Record<string, unknown>) => AgentToolOutput | PromiseLike<AgentToolOutput>;
type AgentToolOutput = AgentFunctionCallOutputParam | object | null;   // objects are JSON.stringify'd

class AgentSessionStream implements AsyncIterable<AgentSessionEvent> {
  readonly controller: AbortController;
  abort(reason?: unknown): void;             // closes local requests; does NOT cancel the backend turn
}
```

Behavior, from the source:
1. Nothing runs until you start iterating, and the stream can be consumed once.
2. It calls `sessions.retrieve`. If `status !== 'idle'` it throws `OpenAIError` ("use sessions.events.stream for active sessions").
3. It subscribes with `events.stream` **before** it sends input, then posts one `agent.session.input.message`.
   The input's `Idempotency-Key` is a header, `params.idempotencyKey`, `options.idempotencyKey`, or a new `uuid4()`.
4. It yields the **original** events, deduplicated by `event_id` over a window of 1024.
5. The first `agent.session.turn.created` with `turn.subagent_id === null` becomes the followed turn. Iteration ends
   after that turn's `completed | failed | cancelled` event **followed by `agent.session.idle`**, or on `agent.session.failed`.
   If the stream hits EOF before that, it throws.
6. Tool dispatch: on `agent.session.turn.item.added` where `item.type === 'function_call'` (including subagent turns,
   deduplicated by `[turn_id, call_id]`), after the event is yielded, the matching handler runs **sequentially**.
   `arguments` is JSON-parsed if it is a string and must be an object. The result is submitted as
   `{ type: 'agent.session.input.tool_result', turn_id, call_id, success: true, output }`, with a new uuid Idempotency-Key per submission.
   If the handler throws, it submits `success: false, error: 'Tool handler failed.'` and does not leak the exception text.
   On a 400 with the message `Unknown pending tool call: <call_id>` it retries after 100, 300 and 600 ms.
7. Functions without a handler are left for you to answer yourself with `events.create`.

`outputText(message: AgentSessionMessage): string` (`openai/lib/agents/output-text`) joins the `output_text` parts in
order. It does **not** filter by `phase`.

## 7. Tools

### Session-level `AgentToolParam` (for `sessions.create({ agent: { tools } })`)

```ts
type AgentToolParam =
  | { type: 'function'; name: string; description: string; parameters: { [k: string]: unknown };  // JSON Schema
      defer_loading?: boolean }                                  // default false; discovered through tool_search
  | { type: 'tool_search' }                                      // loads deferred functions
  | { type: 'programmatic_tool_calling'; enabled?: boolean }     // default true; call tools from model-generated code
  | AgentToolConfigParamMcp
  | { type: 'web_search'; allowed_domains?: string[] | null; context_size?: 'low' | 'medium' | 'high' | null;
      mode?: 'disabled' | 'cached' | 'live' | null;
      location?: { city?: string | null; country?: string | null; region?: string | null; timezone?: string | null } | null };

interface AgentToolConfigParamMcp {
  type: 'mcp';
  server_label: string;
  transport: McpTransportParam;
  allowed_tools?: Array<string> | null;                 // omit = all server tools
  connection_origin?: 'service' | 'environment' | null; // service: Managed Agents network; environment: session's execution env
  credential_id?: string | null;                        // vault credential; optional if exactly one attached credential matches server_url
  request_metadata?: { [k: string]: unknown } | null;   // metadata included with requests to this server
  required?: boolean;                                   // default false; must initialize before the first turn
}
type McpTransportParam =
  | { type: 'http'; server_url: string; authorization?: string | null; headers?: { [k: string]: string } | null }
  | { type: 'stdio'; command: string; cwd: string; args?: string[] | null;
      env?: { [k: string]: string } | null;             // values set on the process
      env_vars?: string[] | null };                     // names inherited from the execution environment
```

- **Not present in SDK v7.19.0:** `require_approval` or any approval setting, `vault_ids` on a tool
  (`vault_ids` exists only on the session), headers on stdio, and built-in `shell`, `apply_patch`, `computer_use`,
  `file_search` or `code_interpreter` tool params. Command execution shows up only as the output item
  `command_execution` (§9), which the environment produces. No tool param enables it.
- Resource form `AgentTool` (on `session.agent.tools`) covers `function | programmatic_tool_calling | mcp | web_search`.
  It has no `tool_search` member. Its fields are the same but required. The MCP resource transport is
  `{ type:'http'; server_url }` or `{ type:'stdio'; command; cwd; args; env_vars }`. Secrets and headers are not echoed back.

### Saved-agent `PersistedAgentToolParam` (for `agents.create/update({ tools })`)

This has the same five variants, but MCP is **credential-free**:

```ts
type PersistedMcpTransportParam =
  | { type: 'http'; server_url: string; headers?: { [k: string]: string } | null }   // non-secret headers; NO authorization
  | { type: 'stdio'; command: string; cwd: string; args?: string[] | null; env_vars?: string[] | null };  // NO env
```

On a saved agent, authenticate MCP servers through `credential_id` + session `vault_ids`, or with per-session
`agent.tools` overrides that carry `authorization`.

## 8. Saved agents (`client.beta.agents`)

```ts
agents.create(body: AgentCreateParams, options?): APIPromise<Agent>
agents.retrieve(agentID: string, options?): APIPromise<Agent>
agents.update(agentID: string, body?: AgentUpdateParams | null, options?): APIPromise<Agent>   // POST /agents/{id}
agents.list(query?: { after?: string; limit?: number | null; order?: 'asc' | 'desc' }): PagePromise<CursorPage<Agent>>
agents.delete(agentID: string, options?): APIPromise<AgentDeleted>   // { id; deleted: boolean; object: 'agent.deleted' }

interface AgentCreateParams {
  model: string;                                              // REQUIRED
  name?: string | null;
  instructions?: string | null;                               // appended to the default base instructions
  metadata?: { [k: string]: string } | null;                  // <=16 pairs, key <=64, value <=512
  reasoning?: { effort?: Effort | null; summary?: 'concise' | 'detailed' | 'auto' | null } | null;
  text?: { format?: TextFormatParam | null; verbosity?: 'low' | 'medium' | 'high' | null } | null;
  tools?: Array<PersistedAgentToolParam> | null;              // default []
  service_tier?: ServiceTier | null;
  multi_agent?: { enabled: boolean; max_concurrent_subagents?: number } | null;   // default max 6
}
interface AgentUpdateParams { /* same fields, all optional (model?: string); metadata replaces all; name: null clears */ }
type TextFormatParam = { type: 'text' } | { type: 'json_schema'; schema: { [k: string]: unknown } };

interface Agent {
  id: string; object: 'agent'; name: string | null; model: string; instructions: string | null;
  metadata: { [k: string]: string };
  reasoning: { effort: Effort | null; summary: 'concise' | 'detailed' | 'auto' | null };
  text: { format: TextFormat; verbosity: 'low' | 'medium' | 'high' };
  tools: PersistedAgentTool[]; service_tier: ServiceTier;
  multi_agent: { enabled: boolean; max_concurrent_subagents: number | null };
  created_at: number; updated_at: number;
}
```

**Versioning: not present in SDK v7.19.0.** There is no `version` field or version param on agents. A session
stores a snapshot of the agent in `session.agent` (for example, `name` is "the reusable agent's name when the session
was created"). `sessions.create({ agent_id, agent })` overrides fields for that one session.

## 9. Turns, items and final output

```ts
sessions.turns.list(sessionID: string, query?: { after?: string; limit?: number; order?: 'asc' | 'desc' }): PagePromise<CursorPage<Turn>>
sessions.turns.retrieve(turnID: string, params: { session_id: string }): APIPromise<Turn>

interface Turn {
  id: string; object: 'agent.session.turn'; session_id: string; agent_id: string;
  subagent_id: string | null;
  status: 'queued' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled';   // waiting = needs external input
  error: SessionTurnError | null;
  usage: TokenUsage | null;                                    // per-turn tokens (best effort)
  created_at: number; started_at: number | null; completed_at: number | null;
}
interface SessionTurnError {
  code: 'context_length_exceeded' | 'session_budget_exceeded' | 'usage_limit_exceeded' | 'credit_balance_exhausted'
      | 'rate_limit_exceeded' | 'server_overloaded' | 'cyber_policy' | 'connection_failed' | 'server_error'
      | 'authentication_error' | 'invalid_request' | 'resource_not_found' | 'sandbox_error'
      | 'executor_version_incompatible' | 'active_turn_not_steerable' | 'request_timeout' | 'internal_error';
  message: string;
}

sessions.items.list(sessionID: string, query?: { after?: string; limit?: number; order?: 'asc' | 'desc' })
  : PagePromise<CursorPage<AgentSessionItem>>   // root agent's items (incl. its subagent interactions); no turn filter, so filter by item.turn_id
```

`AgentSessionItem` (discriminate on `type`; every variant has `turn_id: string`):

| `type` | Shape |
|---|---|
| `message` | `AgentSessionMessage { id: string\|null; role: 'user'\|'assistant'; phase: 'commentary'\|'final_answer'\|null; status; content: Array<{type:'input_text';text} \| {type:'input_image';image_url} \| {type:'output_text';text}> }` |
| `reasoning` | `{ id; status: AgentOutputItemStatus\|null; summary: Array<{type:'summary_text';text}> }` |
| `function_call` | `{ id; call_id; name; arguments: unknown; status: AgentFunctionCallStatus }` |
| `function_call_output` | `{ id; call_id; output: string \| InputContent[] \| null; error: string\|null; status }` |
| `mcp_call` | `{ id; server_label; name; arguments: unknown; output: unknown; error: unknown; status }` |
| `web_search_call` | `{ id; status; action: {type:'search';query;queries} \| {type:'open_page';url} \| {type:'find_in_page';url;pattern} \| {type:'other'} \| null }` |
| `command_execution` | `{ id; command; cwd: string\|null; output: string\|null; exit_code: number\|null; duration_ms: number\|null; status }` |
| `agent_message` | `{ id; sender_agent_id; recipient_agent_id; content: AgentContent[] }` |
| `create_subagent_call` | `{ id; agent_id; content: AgentContent[]; model: string\|null; reasoning_effort: string\|null; status }` |
| `send_subagent_input_call` | `{ id; sender_agent_id; recipient_agent_id; content; status }` |
| `resume_subagent_call` / `interrupt_subagent_call` / `close_subagent_call` | `{ id; sender_agent_id; recipient_agent_id; status }` |
| `wait_for_subagents_call` | `{ id; sender_agent_id; recipient_agent_ids: string[]; status }` |

`AgentOutputItemStatus = 'in_progress' | 'completed' | 'incomplete'`.
`AgentFunctionCallStatus = 'in_progress' | 'completed' | 'failed' | 'incomplete'`.
`AgentContent = { type:'output_text'; text } | { type:'encrypted_content'; encrypted_content }`.
`AgentOutputItem` (in `turn.item.done`) is the same set **without** `function_call_output`, `agent_message` and user messages.
Its message variant is `AgentSessionAssistantMessage { id: string; role: 'assistant'; phase; status; content: OutputText[] }`.

**Final assistant text for a turn:**
- *Live:* use `agent.session.turn.item.done` where `item.type === 'message' && item.phase === 'final_answer'`, then
  `outputText(item)`. You can also accumulate `agent.session.turn.output_text.delta` or `.done` by `item_id`.
- *After the fact:* call `items.list(sessionId, { order: 'desc' })`, filter `turn_id === X && type === 'message' && role === 'assistant' && phase === 'final_answer'`, then call `outputText`.

**Usage:** `turn.completed|failed|cancelled` events carry `usage`, and `turns.retrieve(...).usage` has it too. `session.usage` is the session total.

**Subagent-scoped reads:** `sessions.subagents.list(sessionID)` and `.retrieve(subagentID, { session_id })`,
`sessions.subagents.items.list(subagentID, { session_id })`, `sessions.subagents.turns.list(subagentID, { session_id })` and
`.retrieve(turnID, { session_id, subagent_id })`, and `sessions.subagents.turns.items.list(turnID, { session_id, subagent_id })`.
That last one is the only per-turn items endpoint.

**Artifacts:** `sessions.artifacts.list(sessionID, { after?, environment_id?, limit?, order? })`,
`.retrieve(id, { session_id })`, `.delete(id, { session_id })` and `.content(id, { session_id }): APIPromise<Response>` (binary).
`SessionArtifact { id; object:'agent.session.artifact'; session_id; environment_id; turn_id; path; size_bytes; created_at }`.

## 10. Environments, templates, vaults

```ts
environments.retrieve(environmentID: string): APIPromise<EnvironmentInfo>
interface EnvironmentInfo {
  id: string; object: 'agent.environment';
  type: 'openai_hosted' | 'self_hosted';
  status: 'pending' | 'connected' | 'disconnected' | 'expired' | 'failed';   // has 'expired' but no 'ready' (the stream state is the reverse)
  files: HostedEnvironmentFile[]; plugins: HostedPlugin[]; skills: HostedSkill[];   // no remote_url
}

environments.files.create(environmentID, { type:'file_id'; file_id; path } | { type:'inline'; data; path }): APIPromise<EnvironmentFile>
environments.files.list(environmentID, { page?, limit?, order?, path? }): TokenPage<EnvironmentFile>   // needs a connected environment
  // EnvironmentFile { environment_id; object:'agent.environment.file'; path; size_bytes }

environments.templates.create(body?: TemplateCreateParams)           // also: retrieve / update (POST) / list / delete
interface TemplateCreateParams {   // TemplateUpdateParams has the same fields
  name?: string | null; capability_directories?: string[] | null; env?: { [k: string]: string } | null;
  files?: HostedEnvironmentFileParam[] | null;
  network?: { access: 'enabled' | 'disabled' | 'restricted'; allowed_domains?: string[] | null } | null;
  packages?: { npm?; python?; system? } | null; plugins?: HostedPluginParam[] | null;
  setup_commands?: SetupCommandParam[] | null; skills?: HostedSkillParam[] | null;
}
// EnvironmentTemplate { id; object:'agent.environment.template'; name; capability_directories; files; network;
//                       packages; plugins; skills; created_at; updated_at }   (templates are for openai_hosted only)

vaults.create({ name?: string; metadata?: {..} | null }): APIPromise<Vault>   // also: retrieve / list({ status?: 'active'|'archived'|[...] }) / delete
  // Vault { id; object:'vault'; name: string|null; metadata; created_at }
vaults.credentials.create(vaultID, { name: string /* 1..256 bytes */; auth: CredentialAuthCreateParam }): APIPromise<Credential>
type CredentialAuthCreateParam =
  | { type: 'static_bearer'; token: string; mcp_server_url: string }
  | { type: 'mcp_oauth'; access_token: string; mcp_server_url: string; expires_at?: string | null /* RFC 3339 */;
      refresh?: { client_id: string; refresh_token: string; token_endpoint: string;
                  token_endpoint_auth: { type:'none' } | { type:'client_secret_basic'; client_secret } | { type:'client_secret_post'; client_secret };
                  resource?: string | null; scope?: string | null } | null };
vaults.credentials.update(credentialID, { vault_id, auth: CredentialAuthRotateParam })   // rotate secrets
vaults.credentials.retrieve / delete(credentialID, { vault_id }); .list(vaultID, { status?, ... })
// Credential { id; object:'vault.credential'; vault_id; name; auth (secrets never returned); created_at; updated_at }
```

To wire credentials in: pass `vault_ids` on `sessions.create`, and set `credential_id` on the MCP tool.
`credential_id` can be omitted when exactly one attached credential matches the tool's `server_url`.

## 11. Approvals and human-in-the-loop

`grep -ri approv` over `resources/beta/agents/**` and `lib/agents/**` finds **no matches**.
**Approvals are not present in SDK v7.19.0 for the Agents API.** There is no `require_approval` on MCP tools, no
approval required-action, no approval input event, and no approval stream event. (`require_approval` exists only in
the Responses and Realtime APIs.)

The only human-in-the-loop primitives are:
- the `function_call` required action. Your backend decides whether to run the call, can ask a human first, and then
  submits `agent.session.input.tool_result`, or `success: false` + `error` to decline.
- `agent.session.input.cancel`.

A human approval step can be built on function tools: route sensitive operations through function tools instead of MCP.

## 12. Webhooks

- The webhook types have **no agent or session event types.** `UnwrapWebhookEvent` covers only these 19 types:
  `batch.{cancelled,completed,expired,failed}`, `eval.run.{canceled,failed,succeeded}`,
  `fine_tuning.job.{cancelled,failed,succeeded}`, `live.call.incoming`, `live.transport.incoming`,
  `realtime.call.incoming`, `response.{cancelled,completed,failed,incomplete}`, `safety.alert.created`,
  `safety.org_alert.created`. `WebhookCreateParams.event_types` also allows `video.completed` and `video.failed`.
- `client.webhooks.eventTypes.list(): APIPromise<{ object:'list'; data: string[] }>` returns the event types visible at
  runtime. Use it to check whether the server has agent events the SDK types don't know about.
- Signature verification:

```ts
client.webhooks.unwrap(payload: string, headers: HeadersLike, secret?: string | null, tolerance?: number /* s, default 300 */)
  : Promise<UnwrapWebhookEvent>          // verifies, then JSON.parse(payload); no runtime type validation
client.webhooks.verifySignature(payload, headers, secret?, tolerance?): Promise<void>   // throws on failure
// secret defaults to the client's webhookSecret (OPENAI_WEBHOOK_SECRET). Required headers: webhook-id, webhook-timestamp, webhook-signature.
// Needs global `crypto.subtle`. Pass the RAW request body string.
```

- Endpoint management also exists: `client.webhooks.create/retrieve/update/list/delete/rotateSecret/test`.
- For agent sessions, get notifications from `sessions.events.stream` or by polling `sessions.retrieve` / `turns.retrieve`.

---

## Minimal working examples

These snippets type-check with `tsc 5.9.3 --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022`
against `openai@7.19.0`, in a single `.mts` file.

```ts
import OpenAI from 'openai';
import type { AgentSession, AgentSessionInputParam, AgentToolParam } from 'openai/resources/beta/agents/agents';
import { outputText } from 'openai/lib/agents/output-text';

const client = new OpenAI(); // OpenAI-Beta: agents=v1 is added by the SDK
```

### (a) self_hosted session: inline agent, function tool, environment-origin HTTP MCP with headers, initial text

```ts
const tools: AgentToolParam[] = [
  {
    type: 'function',
    name: 'lookup_order',
    description: 'Look up an order by ID.',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'mcp',
    server_label: 'internal_docs',
    connection_origin: 'environment', // the connection starts from the self-hosted environment
    transport: {
      type: 'http',
      server_url: 'http://127.0.0.1:8931/mcp',
      headers: { 'X-Tenant-Id': 'tenant_123' },
      // authorization: 'Bearer ...',  // optional; session-level tools only
    },
    allowed_tools: ['search_docs', 'read_doc'],
    required: true,
  },
];

export async function createSession(): Promise<AgentSession> {
  const session = await client.beta.agents.sessions.create({
    environment: { type: 'self_hosted', workspace_directory: '/workspace' },
    agent: {
      model: 'your-model-id', // plain string; required when agent_id is omitted
      instructions: 'You are a support agent for Agent Studio.',
      reasoning: { effort: 'medium', summary: 'auto' },
      tools,
    },
    input: 'Where is order 42?', // a string becomes one user message
    metadata: { tenant: 'tenant_123' },
  });
  if (session.environment.type === 'self_hosted') {
    // run `codex exec-server --remote <remote_url>` on your executor host
    console.log(session.environment.id, session.environment.remote_url);
  }
  return session;
}
```

### (b) Stream events and answer function calls

```ts
async function runTool(name: string, args: unknown): Promise<string> {
  const parsed: unknown = typeof args === 'string' ? JSON.parse(args) : args; // `arguments` is typed unknown
  if (name === 'lookup_order') return JSON.stringify({ status: 'shipped', input: parsed });
  throw new Error(`unknown tool ${name}`);
}

export async function streamTurn(sessionId: string, text: string): Promise<string> {
  // Subscribe first, then send input, so no events are missed.
  const stream = await client.beta.agents.sessions.events.stream(sessionId);
  await client.beta.agents.sessions.events.create(sessionId, {
    events: [
      {
        type: 'agent.session.input.message',
        input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
      },
    ],
  });

  const submitted = new Set<string>();
  let finalText = '';
  let turnEnded = false;
  let done = false;

  for await (const event of stream) {        // a `type: 'error'` event is thrown as APIError
    switch (event.type) {
      case 'agent.session.turn.output_text.delta':
        process.stdout.write(event.delta);
        break;
      case 'agent.session.turn.item.done':
        if (event.item.type === 'message' && event.item.phase === 'final_answer') {
          finalText = outputText(event.item);
        }
        break;
      case 'agent.session.requires_action': {
        const results: AgentSessionInputParam[] = [];
        for (const action of event.session.required_actions) {
          if (action.type !== 'function_call' || submitted.has(action.call_id)) continue;
          submitted.add(action.call_id);
          const base = {
            type: 'agent.session.input.tool_result',
            turn_id: action.turn_id, // both IDs come straight from the required action
            call_id: action.call_id,
          } as const;
          try {
            results.push({ ...base, success: true, output: await runTool(action.name, action.arguments) });
          } catch (err) {
            results.push({ ...base, success: false, error: err instanceof Error ? err.message : 'Tool failed' });
          }
        }
        if (results.length > 0) {
          await client.beta.agents.sessions.events.create(sessionId, { events: results });
        }
        break;
      }
      case 'agent.session.turn.completed':
      case 'agent.session.turn.failed':
      case 'agent.session.turn.cancelled':
        if (event.turn.subagent_id === null) {
          turnEnded = true;
          console.log(event.type, event.turn.status, event.usage?.total_tokens, event.turn.error?.code);
        }
        break;
      case 'agent.session.idle':
        done = turnEnded; // the first idle after the root turn ended
        break;
      case 'agent.session.failed':
        throw new Error(event.session.error ?? 'session failed');
      default:
        break;
    }
    if (done) break; // closes the SSE connection; the session stays alive
  }
  return finalText;
}

// The same flow with the helper (the session must be idle):
export async function streamWithHelper(sessionId: string): Promise<void> {
  const run = client.beta.agents.sessions.stream(sessionId, {
    input: 'Where is order 42?',
    toolHandlers: {
      lookup_order: async (args) => ({ status: 'shipped', order_id: args['order_id'] }),
    },
  });
  for await (const e of run) {
    if (e.type === 'agent.session.turn.output_text.delta') process.stdout.write(e.delta);
  }
}
```

### (c) Cancel the active turn

```ts
export async function cancelTurn(sessionId: string): Promise<void> {
  await client.beta.agents.sessions.events.create(sessionId, {
    events: [{ type: 'agent.session.input.cancel' }],
  });
}
```

### (d) Delete a session

```ts
export async function deleteSession(sessionId: string): Promise<boolean> {
  const res = await client.beta.agents.sessions.delete(sessionId); // cancel a running turn first
  return res.deleted; // res.object === 'agent.session.deleted'
}
```
