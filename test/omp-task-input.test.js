import assert from "node:assert/strict";
import test from "node:test";

import { taskInputWithoutEmptyFields } from "../omp/task-input.js";

test("empty optional fields are dropped from a task call and from each of its tasks", () => {
  const input = {
    context: "# Goal\nReview it",
    model: [],
    tasks: [
      { name: "AstroDependencyReview", agent: "reviewer", task: "Review it", solutionSpace: "One review", tools: ["read"], model: [], sourceSession: "" },
      { name: "Correctness", agent: "reviewer", task: "Check it", model: "", taskFile: "  ", schemaMode: null },
      { name: "Plain", agent: "reviewer", task: "No extras" },
    ],
  };

  assert.deepEqual(taskInputWithoutEmptyFields(input), {
    context: "# Goal\nReview it",
    tasks: [
      { name: "AstroDependencyReview", agent: "reviewer", task: "Review it", solutionSpace: "One review", tools: ["read"] },
      { name: "Correctness", agent: "reviewer", task: "Check it" },
      { name: "Plain", agent: "reviewer", task: "No extras" },
    ],
  });
});

test("a call without empty optional fields runs unchanged, and values are kept", () => {
  assert.equal(taskInputWithoutEmptyFields({ agent: "scout", task: "Look around" }), undefined);
  assert.equal(taskInputWithoutEmptyFields({ agent: "scout", model: "openai-codex/gpt-6-luna" }), undefined);
  assert.equal(taskInputWithoutEmptyFields({ tasks: [{ agent: "seance", sourceSession: "01abc", task: "Recall" }] }), undefined);
  assert.equal(taskInputWithoutEmptyFields({ tasks: [{ agent: "scout", isolated: false, task: "x" }] }), undefined);
  assert.equal(taskInputWithoutEmptyFields(undefined), undefined);
});

test("the fields that make a call are kept even when empty, so OMP reports the real mistake", () => {
  assert.equal(taskInputWithoutEmptyFields({ agent: "", task: "", name: "", context: "" }), undefined);
  assert.equal(taskInputWithoutEmptyFields({ tasks: [{ agent: "reviewer", task: "x", solutionSpace: "" }] }), undefined);
  assert.deepEqual(taskInputWithoutEmptyFields({ tasks: [], model: [] }), { tasks: [] });
});
