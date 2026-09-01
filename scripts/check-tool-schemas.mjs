/**
 * Assert that every tool compiles to a schema the model can actually pass
 * arguments to. Run under NODE, not bun.
 *
 * Why a script instead of a test: `dsh-tools`' schema compiler identifies plain
 * objects by string-matching V8's native-function `toString` output
 * ("function Object() { [native code] }"). JavaScriptCore formats it with
 * newlines, so every `defineTool` call throws under Bun. dsh runs on Node, so
 * this check must too.
 *
 * What it guards: the tools were once written in defineTool's per-property DSL
 * but registered raw, which compiles to `{type:"object"}` with no properties —
 * callable by the model, but unable to receive a single argument. Typecheck did
 * not catch it and neither did any unit test, because nothing asserted the
 * COMPILED shape.
 */

import assert from "node:assert/strict";
import { createTools } from "../lib/tools.js";

const stub = {
  chat: async () => "",
  searchMessages: async () => [],
  searchConclusions: async () => [],
  remember: async () => {},
  currentSessionName: () => "session",
};

const REQUIRED_ARG = {
  honcho_search: "query",
  honcho_chat: "query",
  honcho_remember: "content",
};

const tools = createTools({ observationMode: "unified", peerName: "p" }, stub);

assert.deepEqual(
  tools.map((t) => t.name).sort(),
  Object.keys(REQUIRED_ARG).sort(),
  "tool set changed — update REQUIRED_ARG",
);

for (const tool of tools) {
  const params = tool.parameters;
  const arg = REQUIRED_ARG[tool.name];

  assert.equal(params?.type, "object", `${tool.name}: parameters must be an object schema`);
  assert.ok(
    params.properties && Object.keys(params.properties).length > 0,
    `${tool.name}: schema has NO properties — the model cannot pass arguments`,
  );
  assert.ok(params.properties[arg], `${tool.name}: missing the "${arg}" parameter`);
  assert.equal(params.properties[arg].type, "string", `${tool.name}.${arg} must be a string`);
  assert.ok(params.required?.includes(arg), `${tool.name}: "${arg}" must be required`);

  for (const [name, spec] of Object.entries(params.properties)) {
    assert.ok(spec.description, `${tool.name}.${name}: every parameter needs a description`);
  }
}

console.log(`tool schemas ok — ${tools.length} tools, all with passable arguments`);
for (const tool of tools) {
  console.log(`  ${tool.name}(${Object.keys(tool.parameters.properties).join(", ")})`);
}
