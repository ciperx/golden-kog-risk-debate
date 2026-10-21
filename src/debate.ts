/**
 * Golden Kog risk debate.
 *
 * Two advocates argue a token's structure from measured facts (one for a sound
 * structure, one for a fragile structure), then a reviewer weighs them.
 * Risk only: never a trading view, no price target, no advice.
 *
 * The pattern is adapted from TradingAgents (TauricResearch, Apache 2.0),
 * without its trader or portfolio manager.
 */

export type Role = "sound" | "fragile" | "reviewer";
export type Mode = "off" | "shadow" | "on";
export type Status = "ok" | "rejected" | "timeout" | "off";

export interface DebateInput {
  facts_text: string;
  level: string;
  points: number;
  flag_ids: string[];
  unknown: string[];
}

export interface RouteArgs {
  task_type: "risk_debate";
  tier_class: "text";
  complexity: "exec" | "apex";
  context_tokens: number;
  constitutional_flag: false;
  agent_id: "golden-kog";
  payload: {
    role: Role;
    system: string;
    prompt: string;
    max_tokens: number;
  };
}

export interface RouteResult {
  content: string;
  model?: string;
  cost_usd?: number;
}

export interface DebateDeps {
  route: (args: RouteArgs) => Promise<RouteResult>;
  check?: (text: string) => string[];
  mode?: Mode;
  log?: (row: object) => void;
  timeoutMs?: number;
}

export interface Debate {
  status: Status;
  shown: boolean;
  sound: string;
  fragile: string;
  reviewer: string;
  weight: string[];
  unknown: string[];
  tension?: string;
  models: { sound?: string; fragile?: string; reviewer?: string };
  usd: number;
  rejected: string[];
}

export const NO_CASE = "No case could be written from the measured facts.";

const MAX_WORDS_ADVOCATE = 180;
const MAX_WORDS_REVIEWER = 150;

/** Words that turn a risk note into a trading view. */
export const BANNED_WORDS = [
  "bull",
  "bear",
  "bullish",
  "bearish",
  "upside",
  "downside",
  "undervalued",
  "overvalued",
  "accumulate",
  "moon",
  "entry",
  "exit",
];

/** Phrases that turn a risk note into a trading view. */
export const BANNED_PHRASES = [
  "upside target",
  "downside target",
  "price target",
  "buy now",
  "sell now",
  "take profit",
  "not financial advice",
];

const DASHES = /[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/;
const NUMBER_TOKEN = /[0-9]+(?:[.,][0-9]+)?/g;

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function wordCount(text: string): number {
  return words(text).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove the machine ids from a text, so their hyphens and digits are not judged as prose. */
function stripIds(text: string, ids: string[]): string {
  let out = text;
  for (const id of ids) {
    if (!id) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(id)}\\b`, "g"), " ");
  }
  return out;
}

function numbersIn(text: string): string[] {
  return text.match(NUMBER_TOKEN) ?? [];
}

function hasForeignDigit(text: string): boolean {
  for (const ch of text) {
    if (/\p{Nd}/u.test(ch) && !/[0-9]/.test(ch)) return true;
  }
  return false;
}

function hasBannedWord(text: string): boolean {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  for (const w of BANNED_WORDS) {
    if (new RegExp(`\\b${escapeRegExp(w)}\\b`).test(lower)) return true;
  }
  return false;
}

export interface RuleOptions {
  factsText: string;
  flagIds?: string[];
  unknown?: string[];
  check?: (text: string) => string[];
  maxWords: number;
  allowForeign?: boolean;
}

/**
 * Every rule a part must pass. Returns the list of problems; empty means fine.
 * The ids in the text are not prose: their hyphens and digits are ignored.
 */
export function ruleProblems(text: string, options: RuleOptions): string[] {
  const problems: string[] = [];
  const ids = [...(options.flagIds ?? []), ...(options.unknown ?? [])];
  const prose = stripIds(text ?? "", ids);

  const allowed = new Set(numbersIn(options.factsText));
  for (const token of numbersIn(prose)) {
    if (!allowed.has(token)) problems.push(`number not in facts: ${token}`);
  }
  if (hasBannedWord(prose)) problems.push("refused word in text");
  if (DASHES.test(prose)) problems.push("dash character in text");
  if (hasForeignDigit(prose)) problems.push("non Latin digit in text");
  if (wordCount(text ?? "") > options.maxWords) {
    problems.push(`too many words: ${wordCount(text ?? "")} over ${options.maxWords}`);
  }
  let extra: string[] = [];
  try {
    extra = options.check ? options.check(text ?? "") : [];
  } catch (err) {
    extra = [`check threw: ${(err as Error)?.message ?? "unknown"}`];
  }
  for (const problem of extra ?? []) problems.push(String(problem));
  return problems;
}

function contextTokens(input: DebateInput): number {
  const chars = (input?.facts_text ?? "").length;
  return Math.max(1, Math.ceil(chars / 4));
}

class TooSlow extends Error {
  role: Role;
  constructor(role: Role) {
    super(`timeout for ${role}`);
    this.role = role;
  }
}

async function withTimeout<T>(role: Role, ms: number, work: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TooSlow(role)), ms);
  });
  try {
    return await Promise.race([work(), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function advocateSystem(role: "sound" | "fragile"): string {
  const side =
    role === "sound"
      ? "You argue that the token's structure is sound: supply, holders, liquidity and concentration look healthy."
      : "You argue that the token's structure is fragile: supply, holders, liquidity and concentration carry risk.";
  return [
    "You are an advocate in a token structure debate.",
    side,
    "Use only the measured facts you are given. Every number you write must appear in the facts, written exactly as it appears.",
    "Never give a trading view: no buy or sell words, no price target, no entry or exit, no advice.",
    "Use Latin digits only and no dash characters. At most 180 words. Plain prose, no lists.",
  ].join(" ");
}

function reviewerSystem(): string {
  return [
    "You are the reviewer of a token structure debate.",
    "Weigh the sound case and the fragile case against the measured facts.",
    "Never give a trading view: no buy or sell words, no price target, no entry or exit, no advice.",
    "Use Latin digits only and no dash characters. At most 150 words.",
    'Answer with JSON only: {"text": string, "weight": string[], "unknown": string[], "tension": string}.',
    "weight holds only the ids of the risk rules that fired and that you relied on. unknown lists the facts that are still missing. tension is one short sentence when the cases conflict, otherwise leave it out.",
  ].join(" ");
}

function advocatePrompt(input: DebateInput, role: "sound" | "fragile"): string {
  return [
    `Measured facts, one per line:`,
    input.facts_text,
    ``,
    `Risk rules that fired: ${(input.flag_ids ?? []).join(", ") || "none"}.`,
    `Still unknown: ${(input.unknown ?? []).join(", ") || "none"}.`,
    `Write the ${role} case from these facts.`,
  ].join("\n");
}

function reviewerPrompt(input: DebateInput, sound: string, fragile: string): string {
  return [
    `Measured facts, one per line:`,
    input.facts_text,
    ``,
    `Risk rules that fired: ${(input.flag_ids ?? []).join(", ") || "none"}.`,
    `Known ids you may put in weight: ${(input.flag_ids ?? []).join(", ") || "none"}.`,
    ``,
    `Sound case:`,
    sound,
    ``,
    `Fragile case:`,
    fragile,
    ``,
    `Weigh them. JSON only, shape: {"text": string, "weight": string[], "unknown": string[], "tension": string}.`,
  ].join("\n");
}

function parseReviewer(content: string): Record<string, unknown> | null {
  const raw = (content ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function emptyDebate(status: Status, shown: boolean, rejected: string[], usd = 0): Debate {
  return {
    status,
    shown,
    sound: "",
    fragile: "",
    reviewer: "",
    weight: [],
    unknown: [],
    models: {},
    usd,
    rejected,
  };
}

export async function debate(input: DebateInput, deps: DebateDeps): Promise<Debate> {
  const mode: Mode = deps?.mode ?? "shadow";
  if (mode === "off") {
    return emptyDebate("off", false, []);
  }
  const timeoutMs = deps.timeoutMs ?? 45000;
  const flagIds = Array.isArray(input?.flag_ids) ? input.flag_ids : [];
  const unknown = Array.isArray(input?.unknown) ? input.unknown : [];
  const factsText = input?.facts_text ?? "";
  const tokens = contextTokens(input);

  const call = async (role: Role, complexity: "exec" | "apex", system: string, prompt: string, maxTokens: number) => {
    const args: RouteArgs = {
      task_type: "risk_debate",
      tier_class: "text",
      complexity,
      context_tokens: tokens,
      constitutional_flag: false,
      agent_id: "golden-kog",
      payload: { role, system, prompt, max_tokens: maxTokens },
    };
    const result = await withTimeout(role, timeoutMs, () => deps.route(args));
    return {
      role,
      content: typeof result?.content === "string" ? result.content : "",
      model: result?.model,
      usd: typeof result?.cost_usd === "number" ? result.cost_usd : 0,
    };
  };

  let usd = 0;
  const models: Debate["models"] = {};
  const rejected: string[] = [];

  // A1: the two advocates run in parallel.
  const settled = await Promise.allSettled([
    call("sound", "exec", advocateSystem("sound"), advocatePrompt(input, "sound"), 420),
    call("fragile", "exec", advocateSystem("fragile"), advocatePrompt(input, "fragile"), 420),
  ]);

  const timedOut = settled.some((r) => r.status === "rejected" && r.reason instanceof TooSlow);
  if (timedOut) {
    return emptyDebate("timeout", false, ["timeout on an advocate call"], usd);
  }
  const failed = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) {
    return emptyDebate("rejected", false, [`route threw: ${(failed.reason as Error)?.message ?? "unknown"}`], usd);
  }

  const advocateParts = (settled as PromiseFulfilledResult<Awaited<ReturnType<typeof call>>>[]).map((r) => r.value);
  for (const part of advocateParts) {
    usd += part.usd;
    if (part.model) models[part.role] = part.model;
  }

  const advocateText = (role: "sound" | "fragile"): string => {
    const part = advocateParts.find((p) => p.role === role);
    const text = (part?.content ?? "").trim();
    const problems = ruleProblems(text, {
      factsText,
      flagIds,
      unknown,
      check: deps.check,
      maxWords: MAX_WORDS_ADVOCATE,
    });
    if (text.length === 0) problems.push("empty text");
    if (problems.length > 0) {
      for (const problem of problems) rejected.push(`${role}: ${problem}`);
      return NO_CASE;
    }
    return text;
  };

  const sound = advocateText("sound");
  const fragile = advocateText("fragile");

  // The reviewer weighs both texts.
  let review: Awaited<ReturnType<typeof call>>;
  try {
    review = await call("reviewer", "apex", reviewerSystem(), reviewerPrompt(input, sound, fragile), 320);
  } catch (err) {
    if (err instanceof TooSlow) {
      return emptyDebate("timeout", false, [...rejected, "timeout on the reviewer call"], usd);
    }
    return emptyDebate("rejected", false, [...rejected, `route threw: ${(err as Error)?.message ?? "unknown"}`], usd);
  }
  usd += review.usd;
  if (review.model) models.reviewer = review.model;

  const parsed = parseReviewer(review.content);
  const reviewText = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  const reviewProblems = parsed
    ? ruleProblems(reviewText, {
        factsText,
        flagIds,
        unknown,
        check: deps.check,
        maxWords: MAX_WORDS_REVIEWER,
      })
    : ["reviewer answer is not JSON"];
  if (parsed && reviewText.length === 0) reviewProblems.push("empty text");

  if (!parsed || reviewProblems.length > 0) {
    for (const problem of reviewProblems) rejected.push(`reviewer: ${problem}`);
    const out = emptyDebate("rejected", false, rejected, usd);
    out.models = models;
    return out;
  }

  const weight = Array.isArray(parsed?.weight)
    ? (parsed!.weight as unknown[]).map((w) => String(w)).filter((w) => flagIds.includes(w))
    : [];
  const unknownOut = Array.isArray(parsed?.unknown)
    ? (parsed!.unknown as unknown[]).map((u) => String(u))
    : unknown;
  const tension = typeof parsed?.tension === "string" && parsed.tension.trim().length > 0 ? parsed.tension.trim() : undefined;

  const result: Debate = {
    status: "ok",
    shown: mode === "on",
    sound,
    fragile,
    reviewer: reviewText,
    weight,
    unknown: unknownOut,
    models,
    usd,
    rejected,
  };
  if (tension) result.tension = tension;

  if (mode === "shadow") {
    try {
      deps.log?.(result);
    } catch {
      /* logging must never break a debate */
    }
  }

  return result;
}

export default debate;
