/**
 * Golden Kog risk debate: two advocates argue a token structure from measured facts, a reviewer
 * weighs them. A risk tool, never a trading tool.
 *
 * Pattern adapted from TradingAgents (TauricResearch, Apache 2.0), with the trader and the
 * portfolio manager removed: nothing here returns a level, a points total or a view.
 */

export type Role = 'sound' | 'fragile' | 'reviewer';
export type Mode = 'off' | 'shadow' | 'on';

export interface RouteArgs {
  task_type: 'risk_debate';
  tier_class: 'text';
  complexity: 'exec' | 'apex';
  context_tokens: number;
  constitutional_flag: false;
  agent_id: 'golden-kog';
  payload: { role: Role; system: string; prompt: string; max_tokens: number };
}

export interface RouteResult {
  content: string;
  model?: string;
  cost_usd?: number;
}

export interface DebateInput {
  facts_text: string;
  level: string;
  points: number;
  flag_ids: string[];
  unknown: string[];
}

export interface DebateDeps {
  route(args: RouteArgs): Promise<RouteResult>;
  check?(text: string): string[];
  mode?: Mode;
  log?(row: object): void;
  timeoutMs?: number;
}

export interface Debate {
  status: 'ok' | 'rejected' | 'timeout' | 'off';
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

const ADVOCATE_WORDS = 180;
const REVIEWER_WORDS = 150;
const REPLACEMENT = 'No case could be written from the measured facts.';

/** Refused vocabulary: a risk tool must not read as a trading call. */
const REFUSED = [
  'bull', 'bear', 'bullish', 'bearish', 'upside', 'downside target', 'undervalued',
  'overvalued', 'accumulate', 'moon', 'buy now', 'sell now', 'price target', 'entry',
  'exit', 'take profit', 'not financial advice',
];

const DASHES = /[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/;
const NON_LATIN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9\u0966-\u096F\uFF10-\uFF19]/;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function numbersIn(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

/** Every number in the part must be written the same way in the facts block. */
function unmeasuredNumbers(text: string, facts: string): string[] {
  const missing: string[] = [];
  for (const token of numbersIn(text)) {
    const pattern = new RegExp(`(^|[^\\d.])${token.replace('.', '\\.')}(?!\\d)`);
    if (!pattern.test(facts)) missing.push(token);
  }
  return missing;
}

function refusedWords(text: string): string[] {
  const lowered = text.toLowerCase();
  return REFUSED.filter((word) => {
    const pattern = new RegExp(`(^|[^a-z])${word.replace(/ /g, '\\s+')}([^a-z]|$)`, 'i');
    return pattern.test(lowered);
  });
}

/** Returns the reasons a part cannot be shown, empty when it is fine. */
function problems(text: string, facts: string, limit: number, deps: DebateDeps): string[] {
  const out: string[] = [];
  if (!text || !text.trim()) out.push('empty');
  if (words(text) > limit) out.push(`${words(text)} words over the ${limit} limit`);
  const missing = unmeasuredNumbers(text, facts);
  if (missing.length) out.push(`number not in the measured facts: ${missing.join(', ')}`);
  const refused = refusedWords(text);
  if (refused.length) out.push(`refused wording: ${refused.join(', ')}`);
  if (DASHES.test(text)) out.push('dash character');
  if (NON_LATIN_DIGITS.test(text)) out.push('non Latin digit');
  if (deps.check) {
    const extra = deps.check(text) ?? [];
    for (const problem of extra) out.push(problem);
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function advocateSystem(role: 'sound' | 'fragile'): string {
  const posture = role === 'sound'
    ? 'Argue that the measured structure is sound.'
    : 'Argue that the measured structure is fragile.';
  return [
    'You are a risk analyst arguing one side of a structural debate about a token.',
    posture,
    'Use only the measured facts given to you, and reuse their numbers exactly as written.',
    'This is a risk assessment, not a trading view: do not describe a position, a price level or a direction.',
    'Write at most 180 words, plain prose, no dashes.',
  ].join(' ');
}

function reviewerSystem(): string {
  return [
    'You are the reviewer of a two sided structural debate about a token.',
    'Weigh both cases against the measured facts and answer with JSON only:',
    '{"text": string, "weight": string[], "unknown": string[], "tension": string}',
    'text is at most 150 words, plain prose, no dashes.',
    'weight must contain only ids from the fired risk rules, unknown lists what the facts do not settle.',
    'This is a risk assessment, not a trading view: no position, no price level, no direction.',
  ].join(' ');
}

function parseReviewer(content: string): { text: string; weight: string[]; unknown: string[]; tension?: string } | null {
  if (typeof content !== 'string') return null;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.text !== 'string') return null;
  const weight = Array.isArray(row.weight) ? row.weight.filter((x): x is string => typeof x === 'string') : [];
  const unknown = Array.isArray(row.unknown) ? row.unknown.filter((x): x is string => typeof x === 'string') : [];
  const tension = typeof row.tension === 'string' ? row.tension : undefined;
  return { text: row.text, weight, unknown, tension };
}

export async function debate(input: DebateInput, deps: DebateDeps): Promise<Debate> {
  const mode: Mode = deps.mode ?? 'shadow';
  const timeoutMs = deps.timeoutMs ?? 45000;
  const base: Debate = {
    status: 'ok',
    shown: mode === 'on',
    sound: '',
    fragile: '',
    reviewer: '',
    weight: [],
    unknown: [],
    models: {},
    usd: 0,
    rejected: [],
  };

  if (mode === 'off') {
    return { ...base, status: 'off', shown: false };
  }

  const facts = input.facts_text ?? '';
  const contextTokens = Math.max(1, Math.ceil((facts.length + 400) / 4));

  const call = (role: Role, complexity: 'exec' | 'apex', system: string, prompt: string, maxTokens: number) =>
    deps.route({
      task_type: 'risk_debate',
      tier_class: 'text',
      complexity,
      context_tokens: contextTokens,
      constitutional_flag: false,
      agent_id: 'golden-kog',
      payload: { role, system, prompt, max_tokens: maxTokens },
    });

  const factsBlock = `Measured facts:\n${facts}\n\nFired risk rules: ${input.flag_ids.join(', ') || 'none'}\nOpen questions: ${input.unknown.join('; ') || 'none'}`;

  let soundResult: RouteResult;
  let fragileResult: RouteResult;
  try {
    [soundResult, fragileResult] = await withTimeout(
      Promise.all([
        call('sound', 'exec', advocateSystem('sound'), factsBlock, 500),
        call('fragile', 'exec', advocateSystem('fragile'), factsBlock, 500),
      ]),
      timeoutMs,
    );
  } catch {
    return { ...base, status: 'timeout' };
  }

  const usdOf = (result?: RouteResult) => (typeof result?.cost_usd === 'number' ? result.cost_usd : 0);
  let usd = usdOf(soundResult) + usdOf(fragileResult);
  const models: Debate['models'] = {};
  if (soundResult.model) models.sound = soundResult.model;
  if (fragileResult.model) models.fragile = fragileResult.model;

  const rejected: string[] = [];

  let sound = String(soundResult.content ?? '').trim();
  const soundProblems = problems(sound, facts, ADVOCATE_WORDS, deps);
  if (soundProblems.length) {
    rejected.push(`sound: ${soundProblems.join('; ')}`);
    sound = REPLACEMENT;
  }

  let fragile = String(fragileResult.content ?? '').trim();
  const fragileProblems = problems(fragile, facts, ADVOCATE_WORDS, deps);
  if (fragileProblems.length) {
    rejected.push(`fragile: ${fragileProblems.join('; ')}`);
    fragile = REPLACEMENT;
  }

  const reviewerPrompt = [
    factsBlock,
    '',
    'Case for a sound structure:',
    sound,
    '',
    'Case for a fragile structure:',
    fragile,
  ].join('\n');

  let reviewerRaw: RouteResult;
  try {
    reviewerRaw = await withTimeout(
      call('reviewer', 'apex', reviewerSystem(), reviewerPrompt, 400),
      timeoutMs,
    );
  } catch {
    return { ...base, status: 'timeout', sound, fragile, models, usd, rejected };
  }

  usd += usdOf(reviewerRaw);
  if (reviewerRaw.model) models.reviewer = reviewerRaw.model;

  const parsed = parseReviewer(String(reviewerRaw.content ?? ''));
  if (!parsed) {
    rejected.push('reviewer: answer was not the requested JSON');
    const out: Debate = { ...base, status: 'rejected', shown: false, models, usd, rejected };
    if (deps.log) deps.log(out);
    return out;
  }

  const reviewerProblems = problems(parsed.text, facts, REVIEWER_WORDS, deps);
  if (reviewerProblems.length) {
    rejected.push(`reviewer: ${reviewerProblems.join('; ')}`);
    const out: Debate = { ...base, status: 'rejected', shown: false, models, usd, rejected };
    if (deps.log) deps.log(out);
    return out;
  }

  const allowed = new Set(input.flag_ids ?? []);
  const weight = parsed.weight.filter((id) => allowed.has(id));

  const result: Debate = {
    status: 'ok',
    shown: mode === 'on',
    sound,
    fragile,
    reviewer: parsed.text.trim(),
    weight,
    unknown: parsed.unknown.length ? parsed.unknown : [...(input.unknown ?? [])],
    models,
    usd,
    rejected,
  };
  if (parsed.tension) result.tension = parsed.tension;

  if (deps.log) deps.log(result);
  return result;
}

export default debate;
