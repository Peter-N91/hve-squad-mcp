/** Provider-owned policy metadata, reduced to an explicit public allowlist. */
export interface ContentPolicyDetails {
  direction: "prompt" | "completion" | "unknown";
  categories: {
    name: string;
    filtered?: boolean;
    detected?: boolean;
    severity?: "safe" | "low" | "medium" | "high";
  }[];
  providerRequestId?: string;
}

export interface ResponsibleAiBlocker extends ContentPolicyDetails {
  schemaVersion: 1;
  cause: "provider_content_policy";
  terminal: true;
  sameRunResumable: false;
  acknowledgmentCanOverride: false;
  runId?: string;
  stage: string;
  providerStatus?: number;
  providerCode?: string;
  nextActions: readonly ["review_and_correct_source", "stop", "escalate_false_positive"];
}

const CATEGORY_NAMES = [
  "hate", "self_harm", "sexual", "violence", "jailbreak",
  "indirect_attack", "protected_material_code", "protected_material_text",
] as const;
const SEVERITIES = new Set(["safe", "low", "medium", "high"]);
const POLICY_CODES = new Set([
  "content_filter", "contentfiltered", "content_policy", "content_policy_violation",
  "responsibleaipolicyviolation",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function contentPolicyDetails(
  filterResults: unknown,
  direction: ContentPolicyDetails["direction"] = "unknown",
  providerRequestId?: string | null,
): ContentPolicyDetails {
  const results = record(filterResults);
  const categories: ContentPolicyDetails["categories"] = [];
  for (const name of CATEGORY_NAMES) {
    const value = record(results?.[name]);
    if (!value) continue;
    const filtered = typeof value.filtered === "boolean" ? value.filtered : undefined;
    const detected = typeof value.detected === "boolean" ? value.detected : undefined;
    const severity = typeof value.severity === "string" && SEVERITIES.has(value.severity)
      ? value.severity as "safe" | "low" | "medium" | "high" : undefined;
    if (filtered === undefined && detected === undefined && severity === undefined) continue;
    categories.push({
      name,
      ...(filtered === undefined ? {} : { filtered }),
      ...(detected === undefined ? {} : { detected }),
      ...(severity === undefined ? {} : { severity }),
    });
  }
  return {
    direction: direction === "prompt" || direction === "completion" ? direction : "unknown",
    categories,
    ...(typeof providerRequestId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(providerRequestId)
      ? { providerRequestId } : {}),
  };
}

export function responsibleAiBlocker(
  error: { status?: number; providerCode?: string; contentPolicy?: ContentPolicyDetails },
  stage = "unknown",
  runId?: string,
): ResponsibleAiBlocker {
  // Revalidate even synthetic/custom backends: their error metadata is not authority.
  const supplied = record(error.contentPolicy);
  const direction = supplied?.direction === "prompt" || supplied?.direction === "completion"
    ? supplied.direction : "unknown";
  const entries = Array.isArray(supplied?.categories) ? supplied.categories : [];
  const filters = Object.fromEntries(entries.slice(0, CATEGORY_NAMES.length)
    .map(record)
    .filter((entry): entry is Record<string, unknown> => !!entry && CATEGORY_NAMES.some((name) => name === entry.name))
    .map((entry) => [entry.name, entry]));
  const details = contentPolicyDetails(filters, direction,
    typeof supplied?.providerRequestId === "string" ? supplied.providerRequestId : undefined);
  return {
    schemaVersion: 1,
    cause: "provider_content_policy",
    terminal: true,
    sameRunResumable: false,
    acknowledgmentCanOverride: false,
    ...(runId ? { runId } : {}),
    stage,
    ...details,
    ...(typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 200 && error.status <= 599
      ? { providerStatus: error.status } : {}),
    ...(typeof error.providerCode === "string" && POLICY_CODES.has(error.providerCode.toLowerCase())
      ? { providerCode: error.providerCode } : {}),
    nextActions: ["review_and_correct_source", "stop", "escalate_false_positive"],
  };
}

export function responsibleAiMessage(blocker: ResponsibleAiBlocker): string {
  const categories = blocker.categories.length
    ? blocker.categories.map((entry) =>
      `${entry.name}${entry.severity ? ` (${entry.severity})` : ""}` +
      `${entry.filtered === undefined ? "" : `; filtered=${entry.filtered}`}` +
      `${entry.detected === undefined ? "" : `; detected=${entry.detected}`}`).join(", ")
    : "not provided in validated metadata";
  return [
    "Responsible-AI block: the model provider rejected a request or output under its content policy.",
    `Direction: ${blocker.direction}. Stage: ${blocker.stage}. Categories/severity: ${categories}.`,
    ...(blocker.runId ? [`Run: ${blocker.runId}.`] : []),
    ...(blocker.providerRequestId ? [`Provider correlation: ${blocker.providerRequestId}.`] : []),
    "The exact triggering text is not identified by this receipt. Persisted work and human responses are retained; drafts may be partial or unreviewed.",
    "This run is terminal and cannot be resumed by acknowledgment. Review/correct the business request or source material before explicitly requesting new work, stop, or escalate a suspected false positive through provider support.",
    "Do not retry unchanged content automatically, switch models to evade policy, weaken filters, or mark filtered output complete.",
  ].join("\n\n");
}
