---
bump: patch
type: Fixed
---

- **Cowork later-stage calls now use GPT-5.6 Sol through Azure OpenAI's Responses
  API instead of the GPT-4.1 mini test deployment.** The backend keeps an
  explicit legacy Chat Completions mode, while the deployed GPT-5.6 Sol path
  avoids unsupported `temperature` / `max_tokens` fields, uses a 32,768-token
  output budget, and accepts bounded 256,000-character artifact extracts. Azure
  OpenAI error bodies are reduced to safe error codes, so context-length and
  content-policy failures return actionable MCP tool messages without exposing
  provider details or caller content. The uploadable Cowork plugin advances to
  version 1.2.3 (project-manager skill 1.3) so installed clients receive the
  updated cross-stage context and retry guidance. Large model artifacts and
  encrypted run context are now split across Azure Table-safe string properties
  and reassembled on read, avoiding the 64 KiB per-property failure that affected
  successful long GPT-5.6 responses. The deployed Responses path also pins
  reasoning effort and output verbosity to `medium`: representative architecture
  work completed in 16 seconds instead of the model's observed 170-second,
  49,002-character default response, keeping synchronous Cowork calls bounded
  without dropping to low reasoning quality. Project-aware calls now negotiate
  a schema-1 M365 checkpoint (`project` + `projectContext`), reject stale or
  colliding folder identities before inference, partition automatic memory and
  the ledger by the explicit project, and return changed `.copilot-tracking`
  files for Cowork to materialize into its schema-2 project folder. The private
  bridge registry is hidden from generic memory reads/writes, async status polls
  inherit the originating run's project binding, and overflow delta collection
  filters pointer metadata before fetching historical blobs. `squad_history`
  now returns an MCP-native `content[]` result plus structured metadata so
  strict Cowork clients can consume successful index/list/read responses.
