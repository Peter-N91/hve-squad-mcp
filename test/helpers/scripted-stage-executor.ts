import { composeEmbeddedPrompt } from "../../src/engine/embedded-prompt.js";
import type { ModelBackend } from "../../src/engine/model-backend.js";
import type { AdvisoryStageExecutor } from "../../src/engine/research-runtime.js";

/** Isolate routing/approval tests from the separately tested tool-execution protocol. */
export function scriptedStageExecutor(backend: ModelBackend): AdvisoryStageExecutor {
  return {
    execute: (persona, request, priorArtifact) => backend.complete(composeEmbeddedPrompt({
      systemAuthority: persona.charter,
      request: request.request,
      context: request.context,
      priorArtifact,
    })),
  };
}
