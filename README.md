# Golden Kog risk debate

A small TypeScript module that adds a two sided structure debate to a token risk
analysis. Two advocates argue from measured facts, one for a sound structure and
one for a fragile structure, then a reviewer weighs them.

It is a risk tool, never a trading tool: no buy or sell view, no price target, no
entry or exit, and no advice. It never returns or changes a level or points.

The pattern is adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents)
(TauricResearch, Apache 2.0), without its trader or portfolio manager.

## Interface

`src/debate.ts` exports `debate(input, deps) -> Promise<Debate>`.

```ts
import { debate } from "./src/debate.ts";

const out = await debate(
  {
    facts_text: "supply 1000000 tokens\ntop10 62.4 percent of supply\nliquidity 18400 USD in one pool\nholders 2140 wallets",
    level: "medium",
    points: 42,
    flag_ids: ["HOLDER_CONCENTRATION", "THIN_LIQUIDITY"],
    unknown: ["unlock schedule"],
  },
  {
    route: async (args) => ({ content: await yourModel(args.payload), model: "your-model", cost_usd: 0.01 }),
    check: (text) => [],           // optional extra guard from the caller
    mode: "shadow",                // off | shadow | on, default shadow
    log: (row) => store(row),      // called in shadow mode
    timeoutMs: 45000,              // default 45000
  },
);
```

`input`: `facts_text` is the block of measured facts, one fact per line, every
number already computed. `flag_ids` are the ids of the risk rules that fired.

`deps.route(args)` is the only model call. Its args are
`{task_type: "risk_debate", tier_class: "text", complexity: "exec" | "apex",
context_tokens, constitutional_flag: false, agent_id: "golden-kog",
payload: {role, system, prompt, max_tokens}}`.

- `complexity: "exec"` for the two advocates, `complexity: "apex"` for the reviewer.
- `payload.role` is `sound`, `fragile` or `reviewer`.
- The reviewer is asked for JSON `{text, weight, unknown, tension?}`.

## Call flow

1. The two advocate calls start together, in parallel, with roles `sound` and `fragile`.
2. Each advocate part is checked against the rules below. A part that breaks one is
   replaced with exactly `No case could be written from the measured facts.` and its
   reasons are kept in `rejected`.
3. The reviewer is called once, with both advocate texts and the facts, at `apex`.
4. The reviewer answer is parsed as JSON. `weight` keeps only ids that are in
   `flag_ids`. An unparseable or rule breaking reviewer answer gives `status: "rejected"`
   with empty texts.
5. `usd` is the sum of `cost_usd` over the calls that were made. In `mode: "shadow"`
   the Debate is passed to `log` and returned with `shown: false`; `mode: "on"` returns
   `shown: true`; `mode: "off"` makes no call at all.

## Rules

Every part, advocates and reviewer, must pass all of these:

- every number in it appears in `facts_text`, written the same way;
- none of these words or phrases: bull, bear, bullish, bearish, upside, downside,
  upside target, downside target, undervalued, overvalued, accumulate, moon, buy now,
  sell now, price target, entry, exit, take profit, not financial advice;
- `deps.check(text)` returns nothing (an empty array means fine);
- at most 180 words for an advocate, 150 for the reviewer;
- Latin digits only, and no dash characters.

The ids in `flag_ids` and `unknown` are not prose: their digits and hyphens are
ignored when the rules are applied, so a rule id such as `THIN-LIQUIDITY` is allowed
inside a text.

A call that runs longer than `timeoutMs` gives `status: "timeout"` and never throws.

## Example Debate

```json
{
  "status": "ok",
  "shown": true,
  "sound": "Supply is fixed at 1000000 tokens with no mint authority, and 2140 wallets hold it. The top 10 hold 62.4 percent of supply, so the base is spread over many owners.",
  "fragile": "The top 1 wallet holds 18.5 percent of supply and liquidity is 18400 USD in one pool. A single owner can move the structure and the pool is thin.",
  "reviewer": "The structure has 2140 holders and a fixed supply of 1000000 tokens. Concentration at 62.4 percent and liquidity of 18400 USD in one pool are the weak points.",
  "weight": ["HOLDER_CONCENTRATION", "THIN_LIQUIDITY"],
  "unknown": ["unlock schedule"],
  "tension": "Spread ownership and one large wallet pull in opposite directions.",
  "models": { "sound": "exec-1", "fragile": "exec-1", "reviewer": "apex-1" },
  "usd": 0.04,
  "rejected": []
}
```

## Tests

```
npm install
npm test
```

Node 22 or later, no runtime dependency. One test per acceptance item, named A1 to A7.

## House rules

Latin digits only, no long dashes in text people see, no secrets in code or logs,
and the Five Laws are accepted.

## License

MIT. The debate pattern is adapted from TradingAgents (TauricResearch, Apache 2.0).
