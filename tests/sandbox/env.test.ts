import { expect, test } from "bun:test";

import { buildTrialEnv, toBwrapEnvArgs } from "../../src/sandbox/env.ts";
import type { BuildTrialEnvInput } from "../../src/sandbox/env.ts";

const trialInput: BuildTrialEnvInput = {
  trialDir: "/tmp/trial",
  tsCompilerDirs: [],
  resolvedHostToolDirs: ["/host/first/bin", "/host/second/bin"],
  keepWorkspaces: false,
  extraEnvNames: [],
};

test("builds only the allowlisted environment and admits defined provider names", () => {
  const hostNames = [
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GPG_AGENT_INFO",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITLAB_TOKEN",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENCODE_CONFIG",
    "OPENCODE_PASSWORD",
    "UV_CACHE_DIR",
    "HOME",
    "BENCH_ACTIVE_TOKEN",
    "BENCH_INACTIVE_TOKEN",
  ];

  const previous = hostNames.map((name) => [name, process.env[name]] as const);

  try {
    for (const name of hostNames) {
      process.env[name] = "host-value";
    }

    const env = buildTrialEnv({
      ...trialInput,
      extraEnvNames: [...hostNames.slice(0, -1), "BENCH_UNDEFINED_TOKEN"],
    });

    const password = env.get("OPENCODE_PASSWORD");

    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(password).not.toBe(
      buildTrialEnv(trialInput).get("OPENCODE_PASSWORD")
    );

    for (const secret of [
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
      "GPG_AGENT_INFO",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITLAB_TOKEN",
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_RUNTIME_DIR",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "OPENCODE_CONFIG",
      "UV_CACHE_DIR",
      "BENCH_INACTIVE_TOKEN",
      "BENCH_UNDEFINED_TOKEN",
    ]) {
      expect(env.has(secret)).toBe(false);
    }

    expect(env.get("HOME")).toBe("/tmp/trial/home");
    expect(env.get("XDG_CONFIG_HOME")).toBe("/tmp/trial/config");
    expect(env.get("PATH")).toBe(
      "/host/first/bin:/host/second/bin:/usr/local/bin:/usr/bin:/bin"
    );
    expect(env.get("OPENCODE_DB")).toBe(":memory:");
    expect(env.get("OPENCODE_DISABLE_CLAUDE_CODE")).toBe("1");
    expect(env.get("OPENCODE_DISABLE_PROJECT_CONFIG")).toBe("1");
    expect(env.get("OPENCODE_DISABLE_EXTERNAL_SKILLS")).toBe("1");
    expect(env.get("OPENCODE_DISABLE_MODELS_FETCH")).toBe("1");
    expect(env.get("BENCH_ACTIVE_TOKEN")).toBe("host-value");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("prioritizes trial binaries and persists kept sessions", () => {
  const env = buildTrialEnv({
    ...trialInput,
    tsCompilerDirs: [
      {
        sourceDir: "/harness/node_modules/typescript",
        packageSubpath: "typescript",
      },
    ],
    keepWorkspaces: true,
  });

  expect(Object.fromEntries(env)).toMatchObject({
    PATH: "/tmp/trial/ts-bin:/host/first/bin:/host/second/bin:/usr/local/bin:/usr/bin:/bin",
    OPENCODE_DB: "/tmp/trial/session.db",
  });
});

test("passes values verbatim to bwrap", () => {
  expect(
    toBwrapEnvArgs(
      new Map([
        ["PATH", "/usr/bin"],
        ["TOKEN", "a b\nc=d"],
      ])
    )
  ).toEqual(["--setenv", "PATH", "/usr/bin", "--setenv", "TOKEN", "a b\nc=d"]);
});
