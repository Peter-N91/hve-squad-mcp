/**
 * The STRUCTURED backlog contract — the business-user bridge between this
 * advisory server (the brain) and the native, certified Azure DevOps / Jira
 * connectors (the hands).
 *
 * Why this exists. The advisory pipeline already ends in a "backlog handoff"
 * stage, but it emits PROSE. To create work items, a Copilot Studio agent must
 * call the native connector once per item with typed fields — so with a prose
 * artifact the orchestrator has to parse English, and that is the dominant
 * failure mode for a non-technical user ("it created one giant work item", "it
 * lost the acceptance criteria", "it invented a parent"). This module makes the
 * hand-off MACHINE-READABLE: the model is asked for JSON, the server VALIDATES
 * and NORMALIZES it, and the agent loops a flat, ready-to-write `workItems[]`.
 *
 * Trust boundary is unchanged (ADR-0001): this server still performs no ADO/Jira
 * write. It produces the plan; the certified connector executes it on the end
 * user's own connection, under that connector's own auth, DLP, and throttles.
 *
 * Robustness. Model output is untrusted text: it may be fenced, prefixed with
 * commentary, or malformed. {@link parseBacklog} therefore extracts the JSON
 * object defensively and validates every field, so the tool either returns a
 * schema-valid contract or a clean, explicit failure — never half-parsed JSON.
 */

/** One acceptance criterion (a plain sentence). */
export type AcceptanceCriterion = string;

/** A leaf task under a story. */
export interface BacklogTask {
  title: string;
  description: string;
}

/** A user story under an epic. */
export interface BacklogStory {
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  /** Optional relative size (`XS`..`XL` or a number as text); free-form. */
  estimate?: string;
  tasks: BacklogTask[];
}

/** A top-level epic. */
export interface BacklogEpic {
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  stories: BacklogStory[];
}

/**
 * One flattened, ready-to-create work item. This is the array a Copilot Studio
 * agent iterates, calling the native connector once per element.
 *
 * `ref` / `parentRef` are STABLE, server-assigned identifiers (`E1`, `E1-S2`,
 * `E1-S2-T1`). They let the agent create parents first and then link children by
 * matching the id it recorded, without inventing correlation keys or relying on
 * title matching (titles are not unique and the model may rephrase them).
 */
export interface FlatWorkItem {
  ref: string;
  parentRef?: string;
  /** `Epic` | `User Story` | `Task` — the ADO type names; Jira maps 1:1. */
  type: "Epic" | "User Story" | "Task";
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  estimate?: string;
}

/** The validated backlog contract returned by `squad_backlog`. */
export interface BacklogContract {
  /** A one-paragraph plain-language summary for the business user. */
  summary: string;
  epics: BacklogEpic[];
  /** Depth-first flattening of `epics`, ready for per-item connector calls. */
  workItems: FlatWorkItem[];
}

/** Raised when model output cannot be turned into a valid contract. */
export class BacklogContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacklogContractError";
  }
}

/** Hard caps so one call can never emit an unbounded backlog. */
const MAX_EPICS = 30;
const MAX_STORIES_PER_EPIC = 30;
const MAX_TASKS_PER_STORY = 30;
const MAX_CRITERIA = 20;
const MAX_TEXT = 4000;

function text(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function criteria(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => text(entry, 600))
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_CRITERIA);
}

/**
 * Extract the outermost JSON object from model output. Handles a bare object, a
 * ```json fenced block, and an object preceded/followed by commentary — the three
 * shapes a chat model actually produces. Returns `undefined` when no balanced
 * object is present.
 */
export function extractJsonObject(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  // Balance braces while ignoring braces inside strings, so a `{` in a title
  // cannot truncate the object.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/** Depth-first flattening with stable refs, so parents always precede children. */
export function flattenBacklog(epics: BacklogEpic[]): FlatWorkItem[] {
  const items: FlatWorkItem[] = [];
  epics.forEach((epic, epicIndex) => {
    const epicRef = `E${epicIndex + 1}`;
    items.push({
      ref: epicRef,
      type: "Epic",
      title: epic.title,
      description: epic.description,
      acceptanceCriteria: epic.acceptanceCriteria,
    });
    epic.stories.forEach((story, storyIndex) => {
      const storyRef = `${epicRef}-S${storyIndex + 1}`;
      items.push({
        ref: storyRef,
        parentRef: epicRef,
        type: "User Story",
        title: story.title,
        description: story.description,
        acceptanceCriteria: story.acceptanceCriteria,
        estimate: story.estimate,
      });
      story.tasks.forEach((task, taskIndex) => {
        items.push({
          ref: `${storyRef}-T${taskIndex + 1}`,
          parentRef: storyRef,
          type: "Task",
          title: task.title,
          description: task.description,
          acceptanceCriteria: [],
        });
      });
    });
  });
  return items;
}

/**
 * Parse and validate model output into a {@link BacklogContract}.
 *
 * Throws {@link BacklogContractError} when no JSON object can be extracted, the
 * JSON is malformed, or it contains no usable epic. Anything structurally present
 * but individually invalid (an untitled story, a non-string criterion) is DROPPED
 * rather than failing the whole call — a business user is better served by a
 * slightly smaller correct backlog than by an error.
 */
export function parseBacklog(raw: string): BacklogContract {
  const json = extractJsonObject(raw);
  if (!json) {
    throw new BacklogContractError("The backlog stage did not return a JSON object.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new BacklogContractError("The backlog stage returned malformed JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BacklogContractError("The backlog stage returned a non-object payload.");
  }
  const record = parsed as Record<string, unknown>;
  const rawEpics = Array.isArray(record.epics) ? record.epics : [];

  const epics: BacklogEpic[] = rawEpics
    .slice(0, MAX_EPICS)
    .map((rawEpic) => {
      const epic = (rawEpic ?? {}) as Record<string, unknown>;
      const rawStories = Array.isArray(epic.stories) ? epic.stories : [];
      return {
        title: text(epic.title, 400),
        description: text(epic.description),
        acceptanceCriteria: criteria(epic.acceptanceCriteria),
        stories: rawStories
          .slice(0, MAX_STORIES_PER_EPIC)
          .map((rawStory) => {
            const story = (rawStory ?? {}) as Record<string, unknown>;
            const rawTasks = Array.isArray(story.tasks) ? story.tasks : [];
            const estimate = text(story.estimate, 40);
            return {
              title: text(story.title, 400),
              description: text(story.description),
              acceptanceCriteria: criteria(story.acceptanceCriteria),
              ...(estimate.length > 0 ? { estimate } : {}),
              tasks: rawTasks
                .slice(0, MAX_TASKS_PER_STORY)
                .map((rawTask) => {
                  const task = (rawTask ?? {}) as Record<string, unknown>;
                  return { title: text(task.title, 400), description: text(task.description) };
                })
                .filter((task) => task.title.length > 0),
            } as BacklogStory;
          })
          .filter((story) => story.title.length > 0),
      } as BacklogEpic;
    })
    .filter((epic) => epic.title.length > 0);

  if (epics.length === 0) {
    throw new BacklogContractError("The backlog stage returned no usable epics.");
  }

  return { summary: text(record.summary), epics, workItems: flattenBacklog(epics) };
}
