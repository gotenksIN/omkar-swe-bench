import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ensureDir0700, writePrivateFile0600 } from "../util/fs.ts";
import { isJsonObject, isJsonRecord, isString, parseJsoncObject, type JsonObject, type JsonValue } from "../util/json.ts";

export interface ProviderConfigOptions {
  readonly activeProviderIds: Iterable<string>;
  readonly providersFile?: string;
  readonly dryRun?: boolean;
}

export interface ProviderConfig {
  readonly filteredProviders: JsonObject;
  readonly extraRoFiles: readonly string[];
  readonly extraEnvNames: readonly string[];
}

function providerSource(path: string, allowSynthetic: boolean): string | undefined {
  try {
    return realpathSync(path);
  } catch (cause) {
    if (allowSynthetic && cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }

    throw new Error(`Cannot resolve the OpenCode providers file at ${path}.`, { cause });
  }
}

export function loadProviderConfig({
  activeProviderIds,
  providersFile,
  dryRun = false,
}: ProviderConfigOptions): ProviderConfig {
  const home = process.env.HOME || homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, ".config");

  const path = providerSource(
    providersFile ?? join(xdgConfigHome, "opencode", "opencode.jsonc"),
    dryRun && providersFile === undefined,
  );

  if (path === undefined) {
    return {
      filteredProviders: Object.fromEntries(Array.from(activeProviderIds, (id) => [id, {}])),
      extraRoFiles: [],
      extraEnvNames: [],
    };
  }

  if (!statSync(path).isFile()) {
    throw new Error(`Expected the OpenCode providers file to be a regular file: ${path}`);
  }

  const { providers } = parseJsoncObject(readFileSync(path, "utf8"));
  const extraRoFiles = new Set<string>();
  const extraEnvNames = new Set<string>();
  const sourceDirectory = dirname(path);

  function rewriteTokens(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
      return value.map(rewriteTokens);
    }

    if (isJsonRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteTokens(entry)]));
    }

    if (!isString(value)) {
      return value;
    }

    return value.replaceAll(/\{(file|env):([^{}]+)\}/gu, (token: string, kind: string, name: string) => {
      if (kind === "env") {
        extraEnvNames.add(name);

        return token;
      }

      const target = name.startsWith("~/") ? join(home, name.slice(2)) : resolve(sourceDirectory, name);
      const realPath = realpathSync(target);

      if (!statSync(realPath).isFile()) {
        throw new Error(`Expected a regular file for ${token} in ${path}.`);
      }

      extraRoFiles.add(realPath);

      return `{file:${realPath}}`;
    });
  }

  const entries: [string, JsonValue][] = [];

  for (const id of new Set(activeProviderIds)) {
    if (!isJsonObject(providers) || !Object.hasOwn(providers, id)) {
      throw new Error(`Missing active provider ${JSON.stringify(id)} in ${path}.`);
    }

    const provider = providers[id];

    if (!isJsonObject(provider)) {
      throw new Error(`Expected provider ${JSON.stringify(id)} in ${path} to be an object.`);
    }

    entries.push([id, rewriteTokens(provider)]);
  }

  return {
    filteredProviders: Object.fromEntries(entries),
    extraRoFiles: [...extraRoFiles],
    extraEnvNames: [...extraEnvNames],
  };
}

export function writeProviderConfig(trialDir: string, { filteredProviders }: ProviderConfig): string {
  const configDir = join(trialDir, "config", "opencode");
  const path = join(configDir, "opencode.jsonc");

  ensureDir0700(configDir);
  writePrivateFile0600(path, `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    providers: filteredProviders,
  }, null, 2)}\n`);

  return path;
}
