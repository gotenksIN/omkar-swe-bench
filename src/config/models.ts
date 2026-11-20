import type {
  ModelListOutput,
  OpenCodeClient,
  SessionCreateInput,
} from "@opencode/client";

export const CODER_MODELS: readonly string[] = [
  "openai/gpt-6.2-sol#medium",
  "openai/gpt-6.2-sol#high",
  "google/gemini-4-hydrogen#high",
  "google/gemini-4-neon#medium",
  "google/gemini-4-neon#high",
  "anthropic/claude-sonnet-5-5#high",
  "anthropic/claude-opus-5-5#medium",
  "deepseek/deepseek-flash#high",
];

export const REVIEWER_MODELS: readonly string[] = [
  "openai/gpt-6.2-sol#high",
  "openai/gpt-6.2-sol#xhigh",
  "google/gemini-4-carbon#medium",
  "google/gemini-4-neon#high",
  "google/gemini-4-neon#xhigh",
  "anthropic/claude-opus-5-5#high",
  "openai/gpt-6.2-astra#medium",
  "openai/gpt-6.2-astra#high",
  "anthropic/claude-fable-5-2#high",
];

export const PAIR_REVIEWER_MODELS: readonly string[] = [
  "openai/gpt-6.2-astra#medium",
  "google/gemini-4-carbon#medium",
];

export interface ParsedModelSpec {
  readonly spec: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly variant: string | undefined;
}

export type ModelRef = NonNullable<SessionCreateInput["model"]>;

export const parseModelSpec = (spec: string): ParsedModelSpec => {
  const match =
    /^(?<providerID>[^/#\s]+)\/(?<modelID>[^#\s]+)(?:#(?<variant>[^/#\s]+))?$/u.exec(
      spec
    );

  const providerID = match?.groups?.providerID;
  const modelID = match?.groups?.modelID;
  const variant = match?.groups?.variant;

  if (
    providerID === undefined ||
    modelID === undefined ||
    modelID.startsWith("/") ||
    modelID.endsWith("/") ||
    modelID.includes("//")
  ) {
    throw new Error(
      `Invalid model spec ${JSON.stringify(spec)}. Use provider/model or provider/model#variant.`
    );
  }

  return {
    spec,
    providerID,
    modelID,
    variant,
  };
};

export const parseModelRef = (spec: string): ModelRef => {
  const { modelID: id, providerID, variant } = parseModelSpec(spec);

  if (variant === undefined) {
    return { id, providerID };
  }

  return { id, providerID, variant };
};

export interface ValidateModelsOptions {
  readonly client?: Pick<OpenCodeClient, "model">;
  readonly directory?: string;
}

/** Reject invalid specs and return any warnings about skipped catalog validation. */
export const validateModels = async (
  specs: readonly string[],
  { client, directory }: ValidateModelsOptions = {}
): Promise<readonly string[]> => {
  const parsedSpecs = specs.map(parseModelSpec);

  if (parsedSpecs.length === 0) {
    return [];
  }

  if (client === undefined) {
    return [
      "No OpenCode catalog client supplied. Model and variant availability is unverified.",
    ];
  }

  let catalog: ModelListOutput;

  try {
    catalog = await client.model.list(
      directory === undefined ? undefined : { location: { directory } },
      { signal: AbortSignal.timeout(5000) }
    );
  } catch {
    return [
      "Could not query the OpenCode model catalog. Model and variant availability is unverified.",
    ];
  }

  for (const { spec, providerID, modelID, variant } of parsedSpecs) {
    const model = catalog.data.find(
      (entry) => entry.providerID === providerID && entry.id === modelID
    );

    if (model === undefined) {
      throw new Error(
        `Unknown model ${providerID}/${modelID} in the OpenCode catalog.`
      );
    }

    if (!model.enabled) {
      throw new Error(
        `Model ${providerID}/${modelID} is disabled in the OpenCode catalog.`
      );
    }

    if (
      variant !== undefined &&
      !model.variants.some((entry) => entry.id === variant)
    ) {
      throw new Error(`Unsupported variant in model spec ${spec}.`);
    }
  }

  return [];
};
