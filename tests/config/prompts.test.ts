import { OpenCode, type ModelListOutput, type PermissionRule } from "@opencode/client";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CODER_MODELS, PAIR_REVIEWER_MODELS, parseModelRef, parseModelSpec, REVIEWER_MODELS, validateModels } from "../../src/config/models.ts";
import { buildTrialConfig, writeTrialConfig } from "../../src/config/prompts.ts";
import { parseJsoncObject } from "../../src/util/json.ts";

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");

  return new RegExp(`^${escaped}$`, "su").test(value);
}

function evaluatePermission(
  rules: readonly PermissionRule[],
  action: string,
  resource: string,
): PermissionRule["effect"] | undefined {
  let effect: PermissionRule["effect"] | undefined;

  for (const rule of rules) {
    if (globMatches(rule.action, action) && globMatches(rule.resource, resource)) {
      effect = rule.effect;
    }
  }

  return effect;
}

let tempDir: string;

beforeEach(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  tempDir = mkdtempSync("/tmp/opencode/bench-prompts-");
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

for (const role of ["coder", "code-reviewer", "pair"] as const) {
  test(`enforces role isolation and permission policy for ${role}`, () => {
    const { config, agent_profile } = buildTrialConfig({ role });
    const { coder, "code-reviewer": reviewer } = config.agents;

    expect(agent_profile).toBe("neutral");
    expect(config.experimental.subagent_depth).toBe(role === "pair" ? 2 : 1);
    expect(config.plugins).toEqual([]);
    expect(buildTrialConfig({ role, needsCommitGuard: true }).config.plugins).toEqual(["opencode-commit-guard@1.1.1"]);
    expect(reviewer.mode).toBe(role === "code-reviewer" ? "all" : "subagent");
    expect(reviewer.system).toContain("## Findings");
    expect(reviewer.system).toContain("No actionable findings.");
    expect(reviewer.system).toContain("Scope needed");

    if (role === "pair") {
      expect(reviewer.system).not.toContain("working-tree diff");
      expect(reviewer.system).toContain("explicit <start>..<end> commit range");
    } else {
      expect(reviewer.system).toContain("working-tree diff");
    }

    expect(reviewer).not.toHaveProperty("model");

    for (const [action, resource] of [
      ["external_directory", "/etc/passwd"],
      ["websearch", "query"],
      ["webfetch", "https://example.com"],
      ["question", "ask"],
      ["experimental_image_generate", "img"],
    ] as const) {
      expect(evaluatePermission(coder.permissions, action, resource)).toBe("deny");
      expect(evaluatePermission(reviewer.permissions, action, resource)).toBe("deny");
    }

    expect(evaluatePermission(coder.permissions, "subagent", "explore")).toBe(role === "code-reviewer" ? undefined : "deny");
    expect(evaluatePermission(coder.permissions, "subagent", "code-reviewer")).toBe(
      role === "pair" ? "allow" : role === "coder" ? "deny" : undefined,
    );

    expect(evaluatePermission(reviewer.permissions, "edit", "src/app.ts")).toBe("deny");
    expect(evaluatePermission(reviewer.permissions, "execute", "code")).toBe("deny");
    expect(evaluatePermission(reviewer.permissions, "subagent", "explore")).toBe("deny");
    expect(evaluatePermission(reviewer.permissions, "skill", "code-review")).toBe("deny");
    const expectedGitEffect = role === "pair" ? "ask" : "allow";
    const expectedFlagEffect = role === "pair" ? "ask" : "deny";
    expect(evaluatePermission(reviewer.permissions, "shell", "rm -rf .")).toBe("deny");
    expect(evaluatePermission(reviewer.permissions, "shell", "git diff main..HEAD")).toBe(expectedGitEffect);
    expect(evaluatePermission(reviewer.permissions, "shell", "git diff --no-ext-diff --no-textconv main..HEAD")).toBe(expectedGitEffect);
    expect(evaluatePermission(reviewer.permissions, "shell", "git log -n 5")).toBe(expectedGitEffect);
    expect(evaluatePermission(reviewer.permissions, "shell", "git log --no-ext-diff --no-textconv -n 5")).toBe(expectedGitEffect);
    expect(evaluatePermission(reviewer.permissions, "shell", "git log --no-ext-diff --no-textconv --show-signature -n 5")).toBe(expectedFlagEffect);
    expect(evaluatePermission(reviewer.permissions, "shell", "git diff --no-ext-diff --no-textconv --output=pwned.txt")).toBe(expectedFlagEffect);
    expect(evaluatePermission(reviewer.permissions, "shell", "git diff --no-ext-diff --no-textconv --no-index /etc/passwd /dev/null")).toBe(expectedFlagEffect);
    expect(evaluatePermission(reviewer.permissions, "shell", "git log --no-ext-diff --no-textconv --ext-diff -p")).toBe(expectedFlagEffect);
    expect(evaluatePermission(reviewer.permissions, "shell", "git diff --no-ext-diff --no-textconv --textconv HEAD")).toBe(expectedFlagEffect);
  });
}

test("imports only approved agent fields, overrides user allows via last-match-wins, and writes 0600 config", () => {
  const agentsFile = join(tempDir, "personal.jsonc");

  writeFileSync(agentsFile, `{
    // Unrelated user configuration never enters the trial.
    "plugins": ["personal-plugin"],
    "mcp": { "servers": {} },
    "websearch": { "provider": "random" },
    "instructions": ["AGENTS.md"],
    "references": { "personal": { "path": "." } },
    "agents": {
      "coder": {
        "description": "Custom coder",
        "system": "Implement carefully.",
        "mode": "subagent",
        "permissions": [
          { "action": "question", "resource": "*", "effect": "allow", "ignored": true },
          { "action": "external_directory", "resource": "*", "effect": "allow" }
        ]
      },
      "code-reviewer": {
        "description": "Custom reviewer",
        "system": "Review carefully.",
        "model": "other/personal#high",
        "permissions": [{ "action": "shell", "resource": "*", "effect": "allow" }]
      },
      "explore": { "system": "Explore." }
    }
  }`);

  const { config, agent_profile } = buildTrialConfig({
    role: "pair",
    agentsFile,
    reviewerModel: "openrouter/anthropic/claude-opus-5-5#high",
    reviewRequirements: "Review only the submitted patch.",
    reviewerBrief: "Check the error handling.",
  });

  const { coder, "code-reviewer": reviewer } = config.agents;

  expect(agent_profile).toBe("file:personal.jsonc");
  expect(config.plugins).toEqual([]);
  expect(Object.keys(config.agents)).toEqual(["coder", "code-reviewer"]);
  expect(coder.description).toBe("Custom coder");
  expect(coder.mode).toBe("primary");
  expect(evaluatePermission(coder.permissions, "question", "prompt")).toBe("deny");
  expect(evaluatePermission(coder.permissions, "external_directory", "/tmp/secret")).toBe("deny");
  expect(evaluatePermission(coder.permissions, "subagent", "code-reviewer")).toBe("allow");
  expect(evaluatePermission(coder.permissions, "subagent", "explore")).toBe("deny");

  expect(reviewer.description).toBe("Custom reviewer");
  expect(reviewer.model).toBe("openrouter/anthropic/claude-opus-5-5#high");
  expect(reviewer.system).toContain("Review carefully.");
  expect(reviewer.system).toContain("## Findings");
  expect(reviewer.system).toContain("--no-ext-diff --no-textconv");
  expect(reviewer.system).toContain("Review only the submitted patch.");
  expect(reviewer.system).toContain("Check the error handling.");
  expect(evaluatePermission(reviewer.permissions, "shell", "bun test")).toBe("deny");
  expect(evaluatePermission(reviewer.permissions, "shell", "git diff --no-ext-diff --no-textconv HEAD~1..HEAD")).toBe("ask");
  expect(evaluatePermission(reviewer.permissions, "shell", "git diff --no-ext-diff --no-textconv a1b2..HEAD -- docs/--output.md")).toBe("ask");

  const path = writeTrialConfig(tempDir, config);
  expect(path).toBe(join(tempDir, "config", "opencode", "opencode.json"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(parseJsoncObject(readFileSync(path, "utf8"))).toEqual(parseJsoncObject(JSON.stringify(config)));
  expect(() => writeTrialConfig(tempDir, config)).toThrow(/EEXIST/u);
});

test.each([
  ['{"agents": []}', "Expected agents in --agents-file to be an object"],
  ['{"agents": {"coder": "bad"}}', "Expected agents.coder in --agents-file to be an object"],
  ['{"agents": {"coder": {"description": 42}}}', "Expected agents.coder.description in --agents-file to be a string"],
  ['{"agents": {"code-reviewer": {"system": true}}}', "Expected agents.code-reviewer.system in --agents-file to be a string"],
  ['{"agents": {"coder": {"permissions": {}}}}', "Expected agents.coder.permissions in --agents-file to be an array"],
  ['{"agents": {"coder": {"permissions": [{"action": "shell", "resource": "*", "effect": "maybe"}]}}}', "Invalid rule in agents.coder.permissions[0]"],
])("rejects malformed --agents-file payload %s", (payload, expectedError) => {
  const agentsFile = join(tempDir, "bad-agents.jsonc");
  writeFileSync(agentsFile, payload);

  expect(() => buildTrialConfig({ role: "coder", agentsFile })).toThrow(expectedError);
});

test("default model matrices contain unique valid specs", () => {
  for (const matrix of [CODER_MODELS, REVIEWER_MODELS, PAIR_REVIEWER_MODELS]) {
    expect(matrix.length).toBeGreaterThan(0);
    expect(new Set(matrix).size).toBe(matrix.length);

    for (const spec of matrix) {
      expect(() => parseModelSpec(spec)).not.toThrow();
    }
  }

  for (const spec of PAIR_REVIEWER_MODELS) {
    expect(REVIEWER_MODELS).toContain(spec);
  }
});

test("parses simple and slash-delimited model specs and session references", () => {
  expect(parseModelSpec("test/model#high")).toEqual({
    spec: "test/model#high",
    providerID: "test",
    modelID: "model",
    variant: "high",
  });
  expect(parseModelSpec("openrouter/anthropic/claude-sonnet-5.5#high")).toEqual({
    spec: "openrouter/anthropic/claude-sonnet-5.5#high",
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet-5.5",
    variant: "high",
  });
  expect(parseModelRef("openrouter/anthropic/claude-sonnet-5.5#high")).toEqual({
    providerID: "openrouter",
    id: "anthropic/claude-sonnet-5.5",
    variant: "high",
  });
  expect(parseModelRef("test/model")).toEqual({ providerID: "test", id: "model" });
  expect(parseModelRef("test/model")).not.toHaveProperty("variant");
});

test.each([
  "", "test", "/model", "test/", "test/model/", "test/a//b", "test/model#",
  "test/model#a#b", "test/model#a/b", "test/m odel", "test/model\n",
])("rejects malformed model spec %j", (spec) => {
  expect(() => parseModelSpec(spec)).toThrow(/Invalid model spec/u);
});

test("validates models against the OpenCode catalog by providerID, catalog id, enabled flag, and variant", async () => {
  const requests: string[] = [];

  const catalog: ModelListOutput = {
    location: { directory: "/fixture" },
    data: [
      {
        id: "catalog-alias",
        providerID: "test",
        modelID: "wire-model",
        name: "Aliased model",
        variants: [{ id: "high" }],
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 1024, output: 256 },
      },
      {
        id: "anthropic/claude-sonnet-5.5",
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet-5.5",
        name: "Slash model",
        variants: [{ id: "high" }],
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 1024, output: 256 },
      },
      {
        id: "disabled-model",
        providerID: "test",
        modelID: "disabled-model",
        name: "Disabled model",
        variants: [],
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: false,
        limit: { context: 1024, output: 256 },
      },
    ],
  };

  const transport = Object.assign(async (url: URL | RequestInfo) => {
    requests.push(String(url));

    return Response.json(catalog);
  }, { preconnect: fetch.preconnect });

  const client = OpenCode.make({ baseUrl: "http://example.test", fetch: transport });
  const options = { client, directory: "/fixture" };

  await expect(validateModels([
    "test/catalog-alias",
    "test/catalog-alias#high",
    "openrouter/anthropic/claude-sonnet-5.5#high",
  ], options)).resolves.toEqual([]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("/api/model");

  await expect(validateModels(["test/wire-model"], options)).rejects.toThrow("Unknown model test/wire-model");
  await expect(validateModels(["other/catalog-alias"], options)).rejects.toThrow("Unknown model other/catalog-alias");
  await expect(validateModels(["test/disabled-model"], options)).rejects.toThrow("disabled");
  await expect(validateModels(["test/catalog-alias#low"], options)).rejects.toThrow("Unsupported variant");

  requests.length = 0;
  await expect(validateModels(["test/catalog-alias", "malformed"], options)).rejects.toThrow("Invalid model spec");
  expect(requests).toEqual([]);
});

test("warns when the catalog is unavailable or omitted without accepting malformed specs", async () => {
  const transport = Object.assign(async () => {
    throw new Error("Offline");
  }, { preconnect: fetch.preconnect });

  const client = OpenCode.make({ baseUrl: "http://example.test", fetch: transport });

  await expect(validateModels(["test/model"], { client })).resolves.toEqual([expect.stringContaining("unverified")]);
  await expect(validateModels(["test/model"])).resolves.toEqual([expect.stringContaining("unverified")]);
  await expect(validateModels(["test/model#"])).rejects.toThrow("Invalid model spec");
});
