import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSquadGithubRoot } from "../src/paths.js";
import { selectEconomyModel, selectEconomyDelegateModel } from "../src/engine/copilot/economy-routing.js";

const root = resolveSquadGithubRoot()!;
const available = ["gpt-5.6-sol", "gpt-6.1-sol", "gpt-5.3-codex", "gpt-5.4-mini", "claude-sonnet-5.5", "claude-opus-5"];

test("economy picks the cheapest fit >=2 model without crossing the role floor", () => {
  const pick = selectEconomyModel(root, "developer", "default", available);
  assert.equal(pick.model, "gpt-5.3-codex");
  assert.equal(pick.rankedModel, "gpt-5.3-codex");
  assert.equal(selectEconomyModel(root, "developer", "fast", available).model, "gpt-5.4-mini");
  assert.equal(selectEconomyModel(root, "developer", "extended", available).model, "gpt-6.1-sol");
});

test("research, review and council retain fit-first ranked selection", () => {
  assert.equal(selectEconomyModel(root, "researcher", "default", available).model, "gpt-5.6-sol");
  assert.equal(selectEconomyModel(root, "tester", "default", available).model, "gpt-5.6-sol");
  assert.equal(selectEconomyModel(root, "council-product-owner", "default", available).model, "claude-opus-5");
});

test("routing fails explicitly when account availability cannot meet a floor", () => {
  assert.throws(() => selectEconomyModel(root, "developer", "default", ["gpt-5.4-mini"]), /no available catalog model/);
  assert.throws(() => selectEconomyModel(root, "developer", "unknown", available), /Unknown economy model floor/);
});

test("unrostered workers use the parent ranked model without weakening floors", () => {
  const models = ["claude-sonnet-5", "claude-fable-5.1"];
  const parent = selectEconomyModel(root, "developer", "default", models);
  assert.equal(parent.model, "claude-sonnet-5");
  assert.equal(parent.rankedModel, "claude-fable-5.1");
  const worker = selectEconomyDelegateModel(root, parent, undefined, "fast", models);
  assert.equal(worker.model, parent.rankedModel);
  assert.equal(worker.floor, "default");
  assert.match(worker.rationale, /parent ranked pick/);
  const known = selectEconomyDelegateModel(root, parent, "researcher", "default", available);
  assert.equal(known.model, "gpt-5.6-sol");
  assert.equal(known.role, "researcher");
  assert.throws(() => selectEconomyDelegateModel(root, parent, "researcher", "default", ["gpt-5.4-mini"]), /no available catalog model/);
});
