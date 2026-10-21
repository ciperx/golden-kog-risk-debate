import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { debate, ruleProblems, NO_CASE, type DebateDeps, type DebateInput, type RouteArgs } from "../src/debate.ts";

const FACTS = [
  "supply 1000000 tokens",
  "top10 62.4 percent of supply",
  "liquidity 18400 USD in one pool",
  "holders 2140 wallets",
  "mint authority none",
  "top1 18.5 percent of supply",
].join("\n");

const SOUND = "Supply is fixed at 1000000 tokens with no mint authority, and 2140 wallets hold it. The top 10 hold 62.4 percent of supply, so the base is spread over many owners.";
const FRAGILE = "The top 1 wallet holds 18.5 percent of supply and liquidity is 18400 USD in one pool. A single owner can move the structure and the pool is thin.";
const REVIEW = JSON.stringify({
  text: "The structure has 2140 holders and a fixed supply of 1000000 tokens. Concentration at 62.4 percent and liquidity of 18400 USD in one pool are the weak points.",
  weight: ["HOLDER_CONCENTRATION", "THIN_LIQUIDITY", "NOT_A_RULE"],
  unknown: ["unlock schedule"],
  tension: "Spread ownership and one large wallet pull in opposite directions.",
});

function input(over: Partial<DebateInput> = {}): DebateInput {
  return {
    facts_text: FACTS,
    level: "medium",
    points: 42,
    flag_ids: ["HOLDER_CONCENTRATION", "THIN_LIQUIDITY"],
    unknown: ["unlock schedule"],
    ...over,
  };
}

function fakeDeps(over: Partial<DebateDeps> = {}) {
  const calls: RouteArgs[] = [];
  const deps: DebateDeps = {
    route: async (args: RouteArgs) => {
      calls.push(args);
      if (args.payload.role === "reviewer") return { content: REVIEW, model: "apex-1", cost_usd: 0.02 };
      return { content: args.payload.role === "sound" ? SOUND : FRAGILE, model: "exec-1", cost_usd: 0.01 };
    },
    ...over,
  };
  return { deps, calls };
}

test("A1 the two advocates run in parallel, the reviewer gets both texts and the facts", async () => {
  let running = 0;
  let peak = 0;
  const calls: RouteArgs[] = [];
  const { deps } = fakeDeps({
    route: async (args: RouteArgs) => {
      calls.push(args);
      if (args.payload.role === "reviewer") return { content: REVIEW };
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return { content: args.payload.role === "sound" ? SOUND : FRAGILE };
    },
  });
  const out = await debate(input(), deps);

  const advocateCalls = calls.filter((c) => c.payload.role !== "reviewer");
  const reviewerCall = calls.find((c) => c.payload.role === "reviewer");
  assert.equal(advocateCalls.length, 2);
  assert.deepEqual(advocateCalls.map((c) => c.payload.role).sort(), ["fragile", "sound"]);
  assert.equal(peak, 2, "both advocate calls were in flight at the same time");
  assert.equal(reviewerCall?.complexity, "apex");
  assert.equal(advocateCalls[0].complexity, "exec");
  assert.equal(reviewerCall?.task_type, "risk_debate");
  assert.equal(reviewerCall?.tier_class, "text");
  assert.equal(reviewerCall?.agent_id, "golden-kog");
  assert.equal(reviewerCall?.constitutional_flag, false);
  assert.ok(reviewerCall!.payload.prompt.includes(SOUND));
  assert.ok(reviewerCall!.payload.prompt.includes(FRAGILE));
  assert.ok(reviewerCall!.payload.prompt.includes(FACTS));
  assert.equal(out.status, "ok");
  assert.equal(out.sound, SOUND);
  assert.equal(out.fragile, FRAGILE);
  assert.equal(out.shown, false);
});

test("A2 a number not in the facts replaces an advocate part, and drops the debate for the reviewer", async () => {
  const { deps } = fakeDeps({
    route: async (args: RouteArgs) => {
      if (args.payload.role === "reviewer") return { content: REVIEW };
      if (args.payload.role === "sound") return { content: "Supply is fixed at 1000000 tokens and 99.9 percent is locked." };
      return { content: FRAGILE };
    },
  });
  const out = await debate(input(), deps);
  assert.equal(out.sound, NO_CASE);
  assert.equal(out.fragile, FRAGILE);
  assert.equal(out.status, "ok");
  assert.ok(out.rejected.some((r) => r.startsWith("sound:") && r.includes("99.9")));

  const bad = fakeDeps({
    route: async (args: RouteArgs) => {
      if (args.payload.role === "reviewer") {
        return { content: JSON.stringify({ text: "The structure is fine with 7 invisible holders.", weight: [], unknown: [] }) };
      }
      return { content: args.payload.role === "sound" ? SOUND : FRAGILE };
    },
  });
  const dropped = await debate(input(), bad.deps);
  assert.equal(dropped.status, "rejected");
  assert.equal(dropped.sound, "");
  assert.equal(dropped.fragile, "");
  assert.equal(dropped.reviewer, "");
  assert.ok(dropped.rejected.some((r) => r.includes("number not in facts")));
});

test("A3 a refused word, a dash, a non Latin digit, too many words or a check problem are refused", async () => {
  const cases = [
    "The top 10 hold 62.4 percent, which is bullish for holders.",
    "The top 10 hold 62.4 percent \u2014 a crowded book.",
    "The top 10 hold 62.4 percent and 3 wallets hold the rest.",
    "word ".repeat(200) + "62.4",
  ];
  for (const bad of cases) {
    const { deps } = fakeDeps({
      route: async (args: RouteArgs) => {
        if (args.payload.role === "reviewer") return { content: REVIEW };
        return { content: args.payload.role === "sound" ? bad : FRAGILE };
      },
    });
    const out = await debate(input(), deps);
    assert.equal(out.sound, NO_CASE, `refused: ${bad.slice(0, 40)}`);
    assert.ok(out.rejected.some((r) => r.startsWith("sound:")), `a reason is kept: ${bad.slice(0, 40)}`);
  }

  const asciiDash = fakeDeps({
    route: async (args: RouteArgs) => {
      if (args.payload.role === "reviewer") return { content: REVIEW };
      return { content: args.payload.role === "sound" ? "The top-10 hold 62.4 percent." : FRAGILE };
    },
  });
  const dashed = await debate(input(), asciiDash.deps);
  assert.equal(dashed.sound, NO_CASE);

  const checked = fakeDeps({ check: (text) => (text.startsWith("Supply is fixed") ? ["caller guard: holder count not audited"] : []) });
  const guarded = await debate(input(), checked.deps);
  assert.equal(guarded.sound, NO_CASE, "a deps.check problem refuses the part");
  assert.ok(guarded.rejected.some((r) => r.includes("holder count not audited")));

  const reviewerGuard = fakeDeps({ check: (text) => (text.startsWith("The structure has") ? ["caller guard on the review"] : []) });
  const guardedReview = await debate(input(), reviewerGuard.deps);
  assert.equal(guardedReview.status, "rejected");
  assert.equal(guardedReview.reviewer, "");
});

test("A4 the reviewer JSON is parsed, weight keeps only known ids, unparseable JSON is rejected", async () => {
  const good = await debate(input(), fakeDeps().deps);
  assert.deepEqual(good.weight, ["HOLDER_CONCENTRATION", "THIN_LIQUIDITY"]);
  assert.deepEqual(good.unknown, ["unlock schedule"]);
  assert.equal(good.tension, "Spread ownership and one large wallet pull in opposite directions.");

  const fenced = fakeDeps({
    route: async (args: RouteArgs) => {
      if (args.payload.role === "reviewer") return { content: "```json\n" + REVIEW + "\n```" };
      return { content: args.payload.role === "sound" ? SOUND : FRAGILE };
    },
  });
  const parsedFence = await debate(input(), fenced.deps);
  assert.equal(parsedFence.status, "ok");
  assert.equal(parsedFence.weight.length, 2);

  const broken = fakeDeps({
    route: async (args: RouteArgs) => {
      if (args.payload.role === "reviewer") return { content: "I think the structure is fine." };
      return { content: args.payload.role === "sound" ? SOUND : FRAGILE };
    },
  });
  const out = await debate(input(), broken.deps);
  assert.equal(out.status, "rejected");
  assert.equal(out.reviewer, "");
  assert.ok(out.rejected.some((r) => r.includes("not JSON")));
});

test("A5 a call over timeoutMs gives status timeout without throwing", async () => {
  const { deps } = fakeDeps({
    route: (args: RouteArgs) =>
      args.payload.role === "reviewer"
        ? new Promise((r) => setTimeout(() => r({ content: REVIEW }), 500))
        : new Promise((r) => setTimeout(() => r({ content: SOUND }), 500)),
  });
  const out = await debate(input(), { ...deps, timeoutMs: 30 });
  assert.equal(out.status, "timeout");
  assert.equal(out.shown, false);
  assert.equal(out.reviewer, "");

  const slowReviewer = fakeDeps({
    route: (args: RouteArgs) =>
      args.payload.role === "reviewer"
        ? new Promise((r) => setTimeout(() => r({ content: REVIEW }), 500))
        : Promise.resolve({ content: args.payload.role === "sound" ? SOUND : FRAGILE }),
  });
  const out2 = await debate(input(), { ...slowReviewer.deps, timeoutMs: 40 });
  assert.equal(out2.status, "timeout");
});

test("A6 mode off makes no call, shadow logs and hides, on shows, usd sums the calls", async () => {
  const off = fakeDeps();
  const offOut = await debate(input(), { ...off.deps, mode: "off" });
  assert.equal(off.calls.length, 0);
  assert.equal(offOut.status, "off");
  assert.equal(offOut.shown, false);
  assert.equal(offOut.usd, 0);
  assert.deepEqual(offOut.models, {});

  const rows: object[] = [];
  const shadow = fakeDeps({ log: (row) => rows.push(row) });
  const shadowOut = await debate(input(), { ...shadow.deps, mode: "shadow" });
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as { status: string }).status, "ok");
  assert.equal(shadowOut.shown, false);
  assert.ok(Math.abs(shadowOut.usd - 0.04) < 1e-9);

  const rowsOn: object[] = [];
  const on = fakeDeps({ log: (row) => rowsOn.push(row) });
  const onOut = await debate(input(), { ...on.deps, mode: "on" });
  assert.equal(onOut.shown, true);
  assert.equal(rowsOn.length, 0);

  const noModel = await debate(input(), fakeDeps().deps);
  assert.equal(noModel.models.sound, "exec-1");
  assert.equal(noModel.models.reviewer, "apex-1");
  assert.equal(noModel.status, "ok");
});

test("A7 the README shows the call flow, the rules, an example Debate and credits TradingAgents", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.match(readme, /Call flow/i);
  assert.match(readme, /Rules/i);
  assert.match(readme, /Example Debate/i);
  assert.match(readme, /TradingAgents/);
  assert.match(readme, /Apache 2\.0/);
  assert.match(readme, /"status": "ok"/);
});

test("the debate never returns or changes a level or points", async () => {
  const out = await debate(input({ level: "high", points: 99 }), fakeDeps().deps);
  assert.equal(out.status, "ok");
  assert.equal("level" in out, false);
  assert.equal("points" in out, false);
  const problems = ruleProblems(SOUND, { factsText: FACTS, maxWords: 180 });
  assert.deepEqual(problems, []);
});
