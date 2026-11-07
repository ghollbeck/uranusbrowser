# AI providers

Every AI feature in Uranus Browser asks one place, the native host's **AI registry** (`chromium/native-host/ai/registry.ts`), which provider and model to use. No feature talks to a model service or reads a key on its own; `chromium/native-host/ai/openaiApi.ts` is the only file that calls `api.openai.com`.

## Providers

| Provider | How it signs in | Chat and routines (browser tools) | Meeting notes (text) | Transcription (audio) |
|---|---|---|---|---|
| **ChatGPT** (`ai/codex.ts`) | Sign in with ChatGPT, run by the official Codex app-server | yes | yes | **no**: a ChatGPT plan has no transcription endpoint |
| **OpenAI API key** (`ai/openaiApi.ts`) | a key stored in the macOS Keychain | yes | yes | yes |
| **On this Mac / Underdog** (`ai/underdog.ts`) | nothing; OpenWhisper's on-device model | no: it can't drive the browser tools | yes | no: text only |

On-device Whisper for transcription is still chosen in the Meeting notes sheet (it is an engine there, not a registry provider).

## Features

`chat` (the Agent panel; companions and artifacts run in it), `routines` (follow the chat unless set), `meetingSummary`, `transcribe`. Each has a provider and a model, saved in `the browser profile/ai/prefs.json` (choices only, never a key or token). With nothing saved, everything uses the API key, as before.

- **Settings › AI**: the three providers (sign in or out, paste or remove a key, the on-device model's state) and a provider and model picker per feature. Options that can't work are greyed out with the reason.
- **The composer's selector** (bottom right; the panel's only model picker): its pill shows the companion and the model. **Model ›** picks the chat's model from ChatGPT's and the API key's lists; a new model starts a fresh conversation (the transcript stays on screen; the model doesn't see it), and it can't change while the agent is working. **Thinking ›** (Light, Medium, High, Ultra) sets how hard the model thinks, for ChatGPT and API-key chats alike. The old Efficient / Default / Expert modes are gone.
- **Codex's own skills are off.** Codex bundles skills of its own (image generation, OpenAI docs, skill installation); with ChatGPT they'd be advertised although their tools are switched off here, so `skills.bundled.enabled=false` keeps them out. A companion's skills (the Agent panel's Skills) come in Uranus Browser's own instructions.
- When a provider becomes ready (a sign-in finishes, a key is saved), features whose provider wasn't ready move to it.
- Development overrides still win over saved choices: `ANUS_AGENT_MODEL`, `ANUS_MEETING_SUMMARY_MODEL`, `ANUS_MEETING_TRANSCRIBE_MODEL` (OpenAI models), `ANUS_CODEX_BIN` (which `codex`), `ANUS_AI_DIR` (where prefs and Codex's home live).

## ChatGPT through Codex

Uranus Browser starts `codex app-server` (JSON-RPC over stdio) the first time ChatGPT is needed and stops it with the host. It finds Codex at `ANUS_CODEX_BIN`, the Codex app, the `PATH`, `/opt/homebrew/bin` or `/usr/local/bin`; the npm package's Node launcher is skipped in favour of the native binary inside it.

- **Sign-in**: `account/login/start {type:"chatgpt"}` gives a ChatGPT sign-in page, which opens in a Uranus Browser tab; Codex's own local callback finishes it and sends `account/login/completed`, and the tab closes. Codex keeps and refreshes the tokens. Uranus Browser never reads or stores them, and its errors are scrubbed of anything token-shaped.
- **Isolation**: Codex runs with its own `CODEX_HOME` (`the browser profile/ai/codex-home`), so the user's own Codex setup (config, MCP servers, skills, plugins, sign-in) never comes in, and signing out of Uranus Browser doesn't sign the Codex CLI out. Its environment is an allow-list (no API keys).
- **Locked down**: every thread is ephemeral, works in an empty folder (`…/ai/codex-workspace`), has `sandbox: read-only` and `approvalPolicy: never`, and Codex's shell, apps, plugins, web search, browser, computer-use and image tools are switched off. Any approval request Codex sends anyway is declined.
- **Browser tools** go in as Codex *dynamic tools* (`thread/start.dynamicTools`, experimental API). When the model calls one, Codex sends `item/tool/call` and waits; the host hands the call to the same chat loop as any provider's (`agentChat.ts`), so the approval rules and cards apply unchanged, and answers with the result (page text fenced as untrusted data).
- **Streaming**: `item/agentMessage/delta` updates the answer in the panel as it comes.
- **Failures**: a usage limit, a sign-out, no network or a server that goes quiet for 150 s ends the run with a short message; Stop sends `turn/interrupt`.
- **Meeting notes** through ChatGPT use a tool-less ephemeral thread with the summary's JSON schema as `outputSchema`.
- **Plan and limits**: Settings › AI shows the signed-in email, plan, and the short and weekly limits from `account/rateLimits/read`.

## The API key

Pasted in Settings › AI, it goes once from the page to the host, which stores it with `security -i` (read from stdin, so it never appears in a process list) under service `dev.oprimo.anus.agent.openai`. It is never sent back: the page only learns that there is one. `OPENAI_API_KEY` in the host's environment still works for development.

See [privacy and data flows](privacy.md) for the content sent to providers and the retention distinction.

## Tests

- `node chromium/tests/run.mjs aiRegistry`: choices, persistence without secrets, env overrides, greyed-out reasons, a picked model reaching the next request.
- `node chromium/tests/run.mjs codexProvider`: the ChatGPT provider against `tests/fakeCodexServer.mjs`, a stand-in app-server replaying Codex 0.164's JSON-RPC (sign-in, models, a locked-down thread, a dynamic tool through the approval gate, streaming, usage limit, silence, a crash, Stop, schema answers).
