# Golden Kog risk debate

Two advocates argue one token's structure from measured facts, then a reviewer weighs them. It is a
risk tool and never a trading tool: there is no position, no price level, no direction, no advice,
and the module never returns or changes a level or a points total.

The pattern is adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents) by
TauricResearch, Apache 2.0, with its trader and portfolio manager removed: only the two sided
argument and the review remain.

## Install and use

Node 22 or later. No runtime dependency.

```ts
import { debate } from './src/debate.ts';

const result = await debate(
  {
    facts_text: 'Top 10 holders own 42.5 percent of supply\nMint authority is revoked',
    level: 'high',
    points: 70,
    flag_ids: ['conc-1'],
    unknown: ['team wallets'],
  },
  {
    route: (args) => router.complete(args),   // injected by the caller
    check: (text) => guard.problems(text),    // optional extra guard
    mode: 'shadow',                           // off | shadow | on
    log: (row) => store.write(row),           // optional
    timeoutMs: 45000,
  },
);
```

`route` receives `task_type: 'risk_debate'`, `tier_class: 'text'`, `complexity: 'exec'` for the two
advocates and `'apex'` for the reviewer, `context_tokens` measured from the facts, and
`payload: {role, system, prompt, max_tokens}`. The two advocates run in parallel; the reviewer gets
both texts plus the facts and answers `{text, weight, unknown, tension}` as JSON.

## What the guards do, and why they exist

Every part passes the same rules before it is shown:

- Every number it writes must already appear, written the same way, in the measured facts. A number
  the facts do not contain is a number the model invented.
- No trading vocabulary: bull, bear, bullish, bearish, upside, downside target, undervalued,
  overvalued, accumulate, moon, buy now, sell now, price target, entry, exit, take profit, not
  financial advice.
- At most 180 words per advocate and 150 for the reviewer.
- Latin digits only, no dash characters.
- `deps.check(text)` may add the caller's own problems.

A failing advocate is replaced by exactly "No case could be written from the measured facts." and
the reasons are kept in `rejected`. A failing or unparseable reviewer drops the debate to
`status: 'rejected'` with empty texts, because a review that cannot be trusted must not be shown at
all. `weight` keeps only ids that are in `flag_ids`.

Modes: `off` makes no call at all, `shadow` runs everything and logs the result with `shown: false`,
`on` returns `shown: true`. A call over `timeoutMs` returns `status: 'timeout'`. `usd` is the sum of
the reported `cost_usd`.

## Tests

```bash
npm test
```

An offline harness with an injected `route`: parallel advocate order and roles, the reviewer seeing
both texts, `complexity` exec then apex, weight filtering, cost summing, an invented number being
replaced with the reason kept, an unparseable reviewer emptying the debate, refused wording, a dash,
an over long part, a `deps.check` problem, the timeout, `off` touching nothing, and `on` setting
`shown`.

## Scope, stated plainly

This module argues about structure only. It does not fetch data, decide a risk level, or recommend
an action; the caller supplies the measured facts and owns whatever it does with the review.
