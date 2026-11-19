import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { TsCompilerDir } from "./tools.ts";

export interface BuildTrialEnvInput {
  readonly trialDir: string;
  readonly tsCompilerDirs: readonly TsCompilerDir[];
  readonly resolvedHostToolDirs: readonly string[];
  readonly keepWorkspaces: boolean;
  readonly extraEnvNames: readonly string[];
  readonly modelsCatalogPath?: string | null;
}

const excludedHostNames = new Set([
  "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO",
  "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN",
  "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  "AWS_SECRET_ACCESS_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
]);

export function buildTrialEnv(input: BuildTrialEnvInput): ReadonlyMap<string, string> {
  const { trialDir, tsCompilerDirs, resolvedHostToolDirs, keepWorkspaces, extraEnvNames } = input;
  const home = join(trialDir, "home");
  const path: string[] = [];

  if (tsCompilerDirs.length > 0) {
    path.push(join(trialDir, "ts-bin"));
  }

  path.push(...resolvedHostToolDirs, "/usr/local/bin", "/usr/bin", "/bin");

  const env = new Map([
    ["HOME", home],
    ["USERPROFILE", home],
    ["XDG_CONFIG_HOME", join(trialDir, "config")],
    ["XDG_DATA_HOME", join(trialDir, "data")],
    ["XDG_STATE_HOME", join(trialDir, "state")],
    ["XDG_CACHE_HOME", join(trialDir, "cache")],
    ["TMPDIR", "/tmp"],
    ["PATH", path.join(":")],
    ["LANG", "C.UTF-8"],
    ["LC_ALL", "C.UTF-8"],
    ["TERM", "dumb"],
    ["NO_COLOR", "1"],
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_CONFIG_COUNT", "4"],
    ["GIT_CONFIG_KEY_0", "log.showSignature"],
    ["GIT_CONFIG_VALUE_0", "false"],
    ["GIT_CONFIG_KEY_1", "core.fsmonitor"],
    ["GIT_CONFIG_VALUE_1", "false"],
    ["GIT_CONFIG_KEY_2", "core.hooksPath"],
    ["GIT_CONFIG_VALUE_2", "/dev/null"],
    ["GIT_CONFIG_KEY_3", "gpg.ssh.program"],
    ["GIT_CONFIG_VALUE_3", "ssh-keygen"],
    ["GIT_TERMINAL_PROMPT", "0"],
    ["PYTHONDONTWRITEBYTECODE", "1"],
    ["OPENCODE_DB", keepWorkspaces ? join(trialDir, "session.db") : ":memory:"],
    ["OPENCODE_PASSWORD", randomBytes(32).toString("base64url")],
    ["OPENCODE_DISABLE_CLAUDE_CODE", "1"],
    ["OPENCODE_DISABLE_PROJECT_CONFIG", "1"],
    ["OPENCODE_DISABLE_EXTERNAL_SKILLS", "1"],
    ["OPENCODE_DISABLE_MODELS_FETCH", "1"],
  ]);

  if (input.modelsCatalogPath !== undefined && input.modelsCatalogPath !== null) {
    env.set("OPENCODE_MODELS_PATH", input.modelsCatalogPath);
  }

  for (const name of extraEnvNames) {
    if (
      env.has(name) || excludedHostNames.has(name) || name.startsWith("OPENCODE_")
      || name.startsWith("UV_") || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
    ) {
      continue;
    }

    const value = process.env[name];

    if (value !== undefined) {
      env.set(name, value);
    }
  }

  return env;
}

export function toBwrapEnvArgs(env: ReadonlyMap<string, string>): string[] {
  return Array.from(env).flatMap(([key, value]) => ["--setenv", key, value]);
}
