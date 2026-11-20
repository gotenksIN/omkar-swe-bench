import { expect, test } from "bun:test";

import type {
  SessionMessageAssistant,
  SessionMessageCompactionCompleted,
  SessionMessageInfo,
} from "@opencode/client";

import { computeTelemetry } from "../../src/driver/telemetry.ts";

const model = { id: "test-model", providerID: "synthetic" };

const text = {
  type: "text",
  text: "Answer",
} satisfies SessionMessageAssistant["content"][number];

const toolError = {
  type: "tool",
  id: "tool",
  name: "shell",
  time: { created: 8300, ran: 8500 },
  state: {
    status: "error",
    input: {},
    error: { type: "ToolError", message: "Failed" },
  },
} satisfies SessionMessageAssistant["content"][number];

const compaction: SessionMessageCompactionCompleted = {
  type: "compaction",
  id: "compact",
  status: "completed",
  reason: "auto",
  time: { created: 7500 },
  summary: "Summary",
  cost: 0.25,
  tokens: { input: 10, output: 7, reasoning: 3, cache: { read: 5, write: 1 } },
};

test("calculates root latencies, aggregate usage and throughput, and retry cost", () => {
  const root: SessionMessageInfo[] = [
    {
      type: "assistant",
      id: "cold",
      agent: "coder",
      model,
      time: {
        created: 1000,
        firstToken: 1200,
        streamed: 4000,
        completed: 9000,
      },
      content: [
        {
          type: "reasoning",
          text: "Work",
          time: { created: 1200, completed: 2000 },
        },
        text,
      ],
      cost: 0.5,
      tokens: {
        input: 20,
        output: 24,
        reasoning: 6,
        cache: { read: 10, write: 2 },
      },
    },
    {
      type: "assistant",
      id: "gate",
      agent: "coder",
      model,
      time: { created: 5000, firstToken: 5400, completed: 7000 },
      content: [
        {
          type: "reasoning",
          text: "First",
          time: { created: 5400, completed: 6000 },
        },
        {
          type: "reasoning",
          text: "Second",
          time: { created: 5500, completed: 5800 },
        },
        text,
      ],
      tokens: {
        input: 30,
        output: 12,
        reasoning: 8,
        cache: { read: 0, write: 3 },
      },
    },
    compaction,
    {
      type: "assistant",
      id: "tool-first",
      agent: "coder",
      model,
      time: { created: 8000, firstToken: 8200, completed: 10_000 },
      content: [toolError, text],
      tokens: {
        input: 30,
        output: 18,
        reasoning: 2,
        cache: { read: 0, write: 0 },
      },
    },
    {
      type: "assistant",
      id: "unfinished",
      agent: "coder",
      model,
      time: { created: 11_000, firstToken: 10_999, completed: 10_999 },
      content: [{ type: "reasoning", text: "Only reasoning" }],
    },
  ];

  const childTool = {
    ...toolError,
    time: { created: 2100, ran: 2200 },
    state: { ...toolError.state, time: { start: 2500 } },
  };

  const child: SessionMessageInfo[] = [
    {
      type: "assistant",
      id: "child",
      agent: "code-reviewer",
      model,
      time: { created: 2000, completed: 4000 },
      content: [
        childTool,
        {
          type: "tool",
          id: "pending",
          name: "read",
          time: { created: 3000 },
          state: { status: "streaming", input: "" },
        },
      ],
      cost: 0.125,
      tokens: {
        input: 40,
        output: 30,
        reasoning: 10,
        cache: { read: 8, write: 4 },
      },
    },
    {
      ...compaction,
      id: "child-compaction",
      status: "failed",
      error: { type: "TestError", message: "Failed" },
      cost: 0.0625,
    },
  ];

  const result = computeTelemetry(
    {
      rootMessages: root,
      childMessagesBySessionId: new Map([["child-session", child]]),
      textStartedMsByMessageId: new Map([
        ["cold", 2200],
        ["tool-first", 8900],
      ]),
      scheduledRetries: 3,
    },
    2,
    0.0625
  );

  expect(result).toEqual({
    input_tokens: 140,
    output_tokens: 98,
    reasoning_tokens: 32,
    cache_read_tokens: 28,
    cache_write_tokens: 11,
    subagent_tokens: {
      input_tokens: 50,
      output_tokens: 37,
      reasoning_tokens: 13,
      cache_read_tokens: 13,
      cache_write_tokens: 5,
    },
    root_cost_usd: 0.75,
    subagent_cost_usd: 0.1875,
    retry_cost_usd: 0.0625,
    total_cost_usd: 1,
    steps: 5,
    first_ttfrt_s: 0.2,
    median_ttfrt_s: (0.4 + 0.2) / 2,
    first_ttfvt_s: 1.2,
    median_ttfvt_s: 0.75,
    output_decode_tok_per_s: 84 / 5.8,
    total_model_tok_per_s: 110 / 9,
    reasoning_share: 32 / 130,
    cache_hit_ratio: 28 / 179,
    tool_calls: 3,
    tool_errors: 2,
    subagent_tool_errors: 1,
    outer_retries: 2,
    retries: 5,
  });
});

test("returns null latencies and throughput when no steps qualify", () => {
  const empty = {
    rootMessages: [],
    childMessagesBySessionId: new Map(),
    textStartedMsByMessageId: new Map(),
    scheduledRetries: 0,
  };

  expect(computeTelemetry(empty)).toEqual({
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    subagent_tokens: {
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    root_cost_usd: 0,
    subagent_cost_usd: 0,
    retry_cost_usd: 0,
    total_cost_usd: 0,
    steps: 0,
    first_ttfrt_s: null,
    median_ttfrt_s: null,
    first_ttfvt_s: null,
    median_ttfvt_s: null,
    output_decode_tok_per_s: null,
    total_model_tok_per_s: null,
    reasoning_share: 0,
    cache_hit_ratio: 0,
    tool_calls: 0,
    tool_errors: 0,
    subagent_tool_errors: 0,
    outer_retries: 0,
    retries: 0,
  });

  const unsupported: SessionMessageAssistant = {
    type: "assistant",
    id: "missing",
    agent: "coder",
    model,
    time: { created: 1000 },
    content: [],
  };

  const fallback: SessionMessageAssistant = {
    ...unsupported,
    id: "fallback",
    time: { created: 2000, firstToken: 2100 },
    content: [{ ...toolError, time: { created: 1000, ran: 1500 } }],
  };

  const result = computeTelemetry({
    ...empty,
    rootMessages: [unsupported, fallback],
    textStartedMsByMessageId: new Map([["fallback", 2400]]),
  });

  expect(result).toMatchObject({
    first_ttfrt_s: null,
    median_ttfrt_s: 0.1,
    first_ttfvt_s: null,
    median_ttfvt_s: 0.4,
    output_decode_tok_per_s: null,
    total_model_tok_per_s: null,
  });
});
