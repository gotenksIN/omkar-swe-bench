import type { PermissionRule } from "@opencode/client";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { ensureDir0700, writePrivateFile0600 } from "../util/fs.ts";
import { isJsonArray, isJsonObject, isString, parseJsoncObject, type JsonValue } from "../util/json.ts";
import { parseModelSpec } from "./models.ts";

const DIRECT_SHELL = "Run project checks such as unittest, bun test, ruff, tsc, or task scripts through the direct shell tool, not through execute.";
const STANDALONE_CODER = "Run this assignment without delegation. Follow the task's commit instructions and report directly after verification.";
const PAIR_CODER = 'When the task requires code review, delegate static review to code-reviewer without passing a model override, and supply the repository path, diff range, changed files, and requirements. If the reviewer runs in the background, end the turn with "Review pending" while waiting. Fix substantiated defects on HEAD, rerun tests, and fold fixes into HEAD with git commit --amend --no-edit while leaving non-HEAD commits untouched. Decline false alarms or unreachable findings with a concise technical reason.';

const NEUTRAL_CODER_PROMPT = [
  "Before editing, inspect relevant files, repository AGENTS.md, and Git state.",
  "Preserve unrelated working-tree changes.",
  "Implement only the requested behavior within scope. Make reasonable, reversible choices when minor details are unspecified.",
  DIRECT_SHELL,
  "Follow the task's commit rules. Leave changes uncommitted when requested. When you must commit, capture commit_context first if available, create clean scoped commits, and never push.",
  "Report verification outcomes and any missing external fixtures. Do not fabricate files outside the task scope.",
].join("\n");

const REVIEWER_GIT_RULE = "Your working directory is already the repository root. When inspecting diffs or history with shell, run one standalone git diff --no-ext-diff --no-textconv <range> or git log --no-ext-diff --no-textconv <range> command per shell call without -C, cd, git status, git show, or command chaining.";

const NEUTRAL_REVIEWER_PROMPT = [
  "Perform a read-only static review of the requested commit range, working-tree diff, and in-scope files against the task prompt and repository AGENTS.md (when present).",
  "Do not edit files, mutate Git state, run tests, or delegate.",
  "If you have a commit range but no explicit file list, derive the changed files from git diff and git log.",
  REVIEWER_GIT_RULE,
  "Respect explicit file exclusions.",
  "Report only discrete, actionable defects introduced in scope. Do not invent speculative regressions or request abstractions outside the task.",
  "When a change patches symptoms on top of a fundamentally flawed design—such as extending a fragile substring or flag denylist—flag the root design flaw and recommend replacing it with a sound mechanism instead of proposing another narrow patch.",
  'Open with "Scope needed" and list the missing inputs only when the target repository or diff scope is genuinely missing.',
].join("\n");

const FINDINGS_FORMAT = 'Report actionable items under "## Findings" as "- **[P1]** `path:line` — Explanation", with the appropriate severity (P0 critical, P1 high, P2 medium, P3 low). If none are actionable, say "No actionable findings." If scope is missing, open with "Scope needed".';

interface AgentConfig {
  readonly description: string;
  readonly system: string;
  readonly mode: "primary" | "subagent" | "all";
  readonly permissions: readonly PermissionRule[];
  readonly model?: string;
}

export interface TrialConfig {
  readonly $schema: "https://opencode.ai/config.json";
  readonly update: "disable";
  readonly snapshots: false;
  readonly warming: false;
  readonly experimental: { readonly subagent_depth: 1 | 2 };
  readonly plugins: readonly string[];
  readonly agents: { readonly coder: AgentConfig; readonly "code-reviewer": AgentConfig };
}

type AgentName = keyof TrialConfig["agents"];

export interface TrialConfigOptions {
  readonly role: "coder" | "code-reviewer" | "pair";
  readonly needsCommitGuard?: boolean;
  readonly agentsFile?: string;
  readonly reviewerModel?: string;
  readonly reviewRequirements?: string;
  readonly reviewerBrief?: string;
}

export interface TrialConfigResult {
  readonly config: TrialConfig;
  readonly agent_profile: string;
}

interface AgentOverrides {
  readonly description: string | undefined;
  readonly system: string | undefined;
  readonly permissions: readonly PermissionRule[];
}

const COMMON_DENIALS: readonly PermissionRule[] = [
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "experimental_image_generate", resource: "*", effect: "deny" },
];

const SUBAGENT_DENIAL: PermissionRule = { action: "subagent", resource: "*", effect: "deny" };

const REVIEWER_COMMON_RULES: readonly PermissionRule[] = [
  { action: "skill", resource: "code-review", effect: "deny" },
  SUBAGENT_DENIAL,
  { action: "edit", resource: "*", effect: "deny" },
  { action: "execute", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
];

const REVIEWER_FLAG_DENIALS: readonly PermissionRule[] = [
  { action: "shell", resource: "*--output*", effect: "deny" },
  { action: "shell", resource: "*--ext-diff*", effect: "deny" },
  { action: "shell", resource: "*--textconv*", effect: "deny" },
  { action: "shell", resource: "*--no-index*", effect: "deny" },
  { action: "shell", resource: "*--show-signature*", effect: "deny" },
];

function reviewerRules(role: TrialConfigOptions["role"]): readonly PermissionRule[] {
  // In writable pair trials, require runtime AST approval (`ask`) on reviewer git
  // diff/log commands so session-runner enforces the strict allowlist regardless of flag order.
  const effect: PermissionRule["effect"] = role === "pair" ? "ask" : "allow";

  return [
    ...REVIEWER_COMMON_RULES,
    { action: "shell", resource: "git diff *", effect },
    { action: "shell", resource: "git log *", effect },
    ...(role === "pair" ? [] : REVIEWER_FLAG_DENIALS),
  ];
}

function readAgent(agents: JsonValue | undefined, name: AgentName): AgentOverrides {
  if (agents !== undefined && !isJsonObject(agents)) {
    throw new Error("Expected agents in --agents-file to be an object.");
  }

  const agent = agents?.[name];

  if (agent !== undefined && !isJsonObject(agent)) {
    throw new Error(`Expected agents.${name} in --agents-file to be an object.`);
  }

  const { description, system, permissions } = agent ?? {};

  if (description !== undefined && !isString(description)) {
    throw new Error(`Expected agents.${name}.description in --agents-file to be a string.`);
  }

  if (system !== undefined && !isString(system)) {
    throw new Error(`Expected agents.${name}.system in --agents-file to be a string.`);
  }

  if (permissions !== undefined && !isJsonArray(permissions)) {
    throw new Error(`Expected agents.${name}.permissions in --agents-file to be an array.`);
  }

  const rules = (permissions ?? []).map((rule, index): PermissionRule => {
    if (isJsonObject(rule)) {
      const { action, resource, effect } = rule;

      if (isString(action) && isString(resource) && (effect === "allow" || effect === "deny" || effect === "ask")) {
        return { action, resource, effect };
      }
    }

    throw new Error(`Invalid rule in agents.${name}.permissions[${index}] in --agents-file.`);
  });

  return { description, system, permissions: rules };
}

export function buildTrialConfig({
  role,
  needsCommitGuard = false,
  agentsFile,
  reviewerModel,
  reviewRequirements,
  reviewerBrief,
}: TrialConfigOptions): TrialConfigResult {
  const agents = agentsFile === undefined ? undefined : parseJsoncObject(readFileSync(agentsFile, "utf8")).agents;
  const coderBase = readAgent(agents, "coder");
  const reviewerBase = readAgent(agents, "code-reviewer");

  const coderPrompt = coderBase.system === undefined
    ? [NEUTRAL_CODER_PROMPT]
    : [coderBase.system, DIRECT_SHELL];

  const reviewerPrompt = reviewerBase.system === undefined
    ? [NEUTRAL_REVIEWER_PROMPT, FINDINGS_FORMAT]
    : [reviewerBase.system, REVIEWER_GIT_RULE, FINDINGS_FORMAT];

  const coderRules = [...coderBase.permissions, ...COMMON_DENIALS];

  if (role === "coder") {
    coderPrompt.push(STANDALONE_CODER);
    coderRules.push(SUBAGENT_DENIAL);
  } else if (role === "pair") {
    coderPrompt.push(PAIR_CODER);
    coderRules.push(SUBAGENT_DENIAL, { action: "subagent", resource: "code-reviewer", effect: "allow" });

    if (reviewRequirements) {
      reviewerPrompt.push(reviewRequirements);
    }

    if (reviewerBrief) {
      reviewerPrompt.push(reviewerBrief);
    }
  }

  const reviewer: AgentConfig = {
    description: reviewerBase.description ?? "Reviews changes without editing files",
    system: reviewerPrompt.join("\n\n"),
    mode: role === "code-reviewer" ? "all" : "subagent",
    permissions: [...reviewerBase.permissions, ...COMMON_DENIALS, ...reviewerRules(role)],
  };

  return {
    config: {
      $schema: "https://opencode.ai/config.json",
      update: "disable",
      snapshots: false,
      warming: false,
      experimental: { subagent_depth: role === "pair" ? 2 : 1 },
      plugins: needsCommitGuard ? ["opencode-commit-guard@1.1.1"] : [],
      agents: {
        coder: {
          description: coderBase.description ?? "Implements changes and verifies them",
          system: coderPrompt.join("\n\n"),
          mode: "primary",
          permissions: coderRules,
        },
        "code-reviewer": role === "pair" && reviewerModel !== undefined
          ? { ...reviewer, model: parseModelSpec(reviewerModel).spec }
          : reviewer,
      },
    },
    agent_profile: agentsFile === undefined ? "neutral" : `file:${basename(agentsFile)}`,
  };
}

export function writeTrialConfig(trialDir: string, config: TrialConfig): string {
  const configDir = join(trialDir, "config", "opencode");
  const path = join(configDir, "opencode.json");

  ensureDir0700(configDir);
  writePrivateFile0600(path, `${JSON.stringify(config, null, 2)}\n`);

  return path;
}
