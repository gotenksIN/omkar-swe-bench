import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageAssistantTool } from "@opencode/client";

import { isFiniteNumber } from "../util/json.ts";
import type { SessionRunResult } from "./session-runner.ts";

export interface SubagentTokenTotals {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
}

export interface TrialTelemetry extends SubagentTokenTotals {
  readonly subagent_tokens: SubagentTokenTotals;
  readonly root_cost_usd: number;
  readonly subagent_cost_usd: number;
  readonly retry_cost_usd: number;
  readonly total_cost_usd: number;
  readonly steps: number;
  readonly first_ttfrt_s: number | null;
  readonly median_ttfrt_s: number | null;
  readonly first_ttfvt_s: number | null;
  readonly median_ttfvt_s: number | null;
  readonly output_decode_tok_per_s: number | null;
  readonly total_model_tok_per_s: number | null;
  readonly reasoning_share: number;
  readonly cache_hit_ratio: number;
  readonly tool_calls: number;
  readonly tool_errors: number;
  readonly subagent_tool_errors: number;
  readonly outer_retries: number;
  readonly retries: number;
}

function toolStart(part: SessionMessageAssistantTool): number | undefined {
  // The 2.3.2 REST type puts the run timestamp on the part.
  if ("time" in part.state) {
    const time: object = Object(part.state.time);

    if (time === part.state.time && "start" in time && isFiniteNumber(time.start)) {
      return time.start;
    }
  }

  return part.time?.ran;
}

function visibleStart(message: SessionMessageAssistant, sseVisible: number | undefined): number | undefined {
  let gate = message.time.firstToken;
  let visible: number | undefined;

  for (const part of message.content) {
    if (part.type === "reasoning") {
      const completed = part.time?.completed;

      if (completed !== undefined) {
        gate = Math.max(gate ?? completed, completed);
      }
    } else {
      visible = part.type === "tool" ? toolStart(part) ?? part.time?.created ?? gate : sseVisible ?? gate;
      break;
    }
  }

  const start = message.time.created;

  if (visible !== undefined && visible >= start) {
    return visible;
  }

  return sseVisible !== undefined && sseVisible >= start ? sseVisible : undefined;
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];

  return upper === undefined ? null : (upper + (sorted.length % 2 === 0 ? sorted[middle - 1] ?? upper : upper)) / 2;
}

function summarize(sessions: Iterable<readonly SessionMessageInfo[]>, textStarts: ReadonlyMap<string, number>) {
  const tokens = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const rt: (number | null)[] = [];
  const vt: (number | null)[] = [];
  let cost = 0;
  let steps = 0;
  let visibleTokens = 0;
  let streamS = 0;
  let activeTokens = 0;
  let activeS = 0;
  let tools = 0;
  let errors = 0;

  for (const messages of sessions) {
    for (const message of messages) {
      if (message.type !== "assistant" && !(message.type === "compaction" && message.status !== "running")) {
        continue;
      }

      const usage = message.tokens;
      tokens.input_tokens += usage?.input ?? 0;
      tokens.output_tokens += usage?.output ?? 0;
      tokens.reasoning_tokens += usage?.reasoning ?? 0;
      tokens.cache_read_tokens += usage?.cache.read ?? 0;
      tokens.cache_write_tokens += usage?.cache.write ?? 0;
      cost += message.cost ?? 0;

      if (message.type !== "assistant") {
        continue;
      }

      steps += 1;
      const { created: start, firstToken: first, streamed, completed } = message.time;
      const end = streamed ?? completed;
      const visible = visibleStart(message, textStarts.get(message.id));
      const output = usage?.output ?? 0;
      rt.push(first !== undefined && first >= start ? (first - start) / 1_000 : null);
      vt.push(visible === undefined ? null : (visible - start) / 1_000);

      if (end !== undefined && visible !== undefined && end > visible && output > 0) {
        visibleTokens += output;
        streamS += (end - visible) / 1_000;
      }

      if (end !== undefined && end > start) {
        activeTokens += output + (usage?.reasoning ?? 0);
        activeS += (end - start) / 1_000;
      }

      for (const part of message.content) {
        if (part.type === "tool") {
          tools += 1;
          errors += Number(part.state.status === "error");
        }
      }
    }
  }

  return { tokens, rt, vt, cost, steps, visibleTokens, streamS, activeTokens, activeS, tools, errors };
}

function warmMedian(latencies: readonly (number | null)[]): number | null {
  return median(latencies.slice(1).filter((latency) => latency !== null));
}

export function computeTelemetry(
  result: Pick<SessionRunResult, "rootMessages" | "childMessagesBySessionId" | "textStartedMsByMessageId" | "scheduledRetries">,
  outerRetries = 0,
  retryCostUsd = 0,
): TrialTelemetry {
  const root = summarize([result.rootMessages], result.textStartedMsByMessageId);
  const child = summarize(result.childMessagesBySessionId.values(), result.textStartedMsByMessageId);
  const input = root.tokens.input_tokens + child.tokens.input_tokens;
  const output = root.tokens.output_tokens + child.tokens.output_tokens;
  const reasoning = root.tokens.reasoning_tokens + child.tokens.reasoning_tokens;
  const read = root.tokens.cache_read_tokens + child.tokens.cache_read_tokens;
  const write = root.tokens.cache_write_tokens + child.tokens.cache_write_tokens;
  const streamS = root.streamS + child.streamS;
  const activeS = root.activeS + child.activeS;

  return {
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cache_read_tokens: read,
    cache_write_tokens: write,
    subagent_tokens: child.tokens,
    root_cost_usd: root.cost,
    subagent_cost_usd: child.cost,
    retry_cost_usd: retryCostUsd,
    total_cost_usd: root.cost + child.cost + retryCostUsd,
    steps: root.steps + child.steps,
    first_ttfrt_s: root.rt[0] ?? null,
    median_ttfrt_s: warmMedian(root.rt),
    first_ttfvt_s: root.vt[0] ?? null,
    median_ttfvt_s: warmMedian(root.vt),
    output_decode_tok_per_s: streamS > 0 ? (root.visibleTokens + child.visibleTokens) / streamS : null,
    total_model_tok_per_s: activeS > 0 ? (root.activeTokens + child.activeTokens) / activeS : null,
    reasoning_share: reasoning / Math.max(1, output + reasoning),
    cache_hit_ratio: read / Math.max(1, input + read + write),
    tool_calls: root.tools + child.tools,
    tool_errors: root.errors + child.errors,
    subagent_tool_errors: child.errors,
    outer_retries: outerRetries,
    retries: outerRetries + result.scheduledRetries,
  };
}
