import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadProviderConfig, writeProviderConfig } from "../../src/config/providers.ts";
import { parseJsoncObject } from "../../src/util/json.ts";

let workspace: string;
let previousHome: string | undefined;
let previousXdgConfigHome: string | undefined;

beforeEach(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  workspace = mkdtempSync("/tmp/opencode/bench-providers-");
  previousHome = process.env.HOME;
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = workspace;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }

  rmSync(workspace, { force: true, recursive: true });
});

test("filters providers and rewrites tokens relative to the canonical source and home", () => {
  const sourceDir = join(workspace, "source");
  const source = join(sourceDir, "providers.jsonc");
  const link = join(workspace, "linked.jsonc");
  const relativeFile = join(sourceDir, "secret");
  const homeFile = join(workspace, "home-key");

  mkdirSync(sourceDir);
  writeFileSync(relativeFile, "relative secret");
  writeFileSync(homeFile, "home secret");
  symlinkSync(relativeFile, join(sourceDir, "alias"));
  symlinkSync(source, link);
  writeFileSync(source, `{
    // Copy only providers used by the trial.
    "mcp": { "example": "{file:do-not-open}" },
    "plugins": ["personal-plugin"],
    "providers": {
      "openai": {
        "settings": {
          "apiKey": "{file:alias}",
          "headers": ["{env:API_KEY} {file:~/home-key} {file:secret}", "{env:API_KEY}:{env:OTHER}", 42, false, null],
        },
      },
      "google": { "settings": { "apiKey": "{env:GOOGLE_KEY}" } },
      "unused": { "settings": { "apiKey": "{env:UNUSED}{file:do-not-open}" } },
    },
  }`);

  const credentials = loadProviderConfig({ activeProviderIds: ["openai", "google", "openai"], providersFile: link });

  const providers = {
    openai: {
      settings: {
        apiKey: `{file:${relativeFile}}`,
        headers: [
          `{env:API_KEY} {file:${homeFile}} {file:${relativeFile}}`,
          "{env:API_KEY}:{env:OTHER}", 42, false, null,
        ],
      },
    },
    google: { settings: { apiKey: "{env:GOOGLE_KEY}" } },
  };

  expect(credentials).toEqual({
    filteredProviders: providers,
    extraRoFiles: [relativeFile, homeFile],
    extraEnvNames: ["API_KEY", "OTHER", "GOOGLE_KEY"],
  });

  const configFile = writeProviderConfig(workspace, credentials);
  expect(configFile).toBe(join(workspace, "config", "opencode", "opencode.jsonc"));
  expect(statSync(configFile).mode & 0o777).toBe(0o600);
  expect(parseJsoncObject(readFileSync(configFile, "utf8"))).toEqual({
    $schema: "https://opencode.ai/config.json",
    providers,
  });
  expect(() => writeProviderConfig(workspace, credentials)).toThrow(/EEXIST/u);
});

test("rejects a directory or missing file referenced by an active provider", () => {
  const providersFile = join(workspace, "providers.jsonc");
  const options = { activeProviderIds: ["openai"], providersFile };

  mkdirSync(join(workspace, "keys"));
  writeFileSync(providersFile, '{"providers":{"openai":{"apiKey":"{file:keys}"}}}');
  expect(() => loadProviderConfig(options)).toThrow(/regular file.*\{file:keys\}/u);
  writeFileSync(providersFile, '{"providers":{"openai":{"apiKey":"{file:missing}"}}}');
  expect(() => loadProviderConfig(options)).toThrow(/missing/u);
});

test("uses the XDG config home and rejects missing active providers even in dry runs", () => {
  process.env.XDG_CONFIG_HOME = join(workspace, "xdg");
  const sourceDir = join(process.env.XDG_CONFIG_HOME, "opencode");

  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "opencode.jsonc"), '{"providers":{"google":{}}}');
  expect(loadProviderConfig({ activeProviderIds: ["google"] }).filteredProviders).toEqual({ google: {} });
  expect(() => loadProviderConfig({ activeProviderIds: ["openai"], dryRun: true }))
    .toThrow('Missing active provider "openai"');
  expect(() => loadProviderConfig({ activeProviderIds: ["constructor"] })).toThrow('Missing active provider "constructor"');
});

test("falls back to a synthetic stub only for dry runs with no host file", () => {
  const sourceDir = join(workspace, ".config", "opencode");

  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "opencode.json"), '{"providers":{"openai":{"apiKey":"ignore me"}}}');
  expect(loadProviderConfig({ activeProviderIds: ["openai", "google"], dryRun: true })).toEqual({
    filteredProviders: { openai: {}, google: {} },
    extraRoFiles: [],
    extraEnvNames: [],
  });
  expect(() => loadProviderConfig({ activeProviderIds: ["openai"] })).toThrow(/opencode\.jsonc/u);
  expect(() => loadProviderConfig({
    activeProviderIds: ["openai"],
    dryRun: true,
    providersFile: join(sourceDir, "override.jsonc"),
  })).toThrow(/override\.jsonc/u);

  writeFileSync(join(sourceDir, "opencode.jsonc"), '{"providers":{"openai":{"default":true}}}');
  expect(loadProviderConfig({ activeProviderIds: ["openai"] }).filteredProviders).toEqual({ openai: { default: true } });
});
