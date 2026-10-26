import { debate } from './src/debate.ts';

const FACTS = 'Top 10 holders own 42.5 percent of supply\nMint authority is revoked\nLiquidity is 180000 USD';
const input = { facts_text: FACTS, level: 'high', points: 70, flag_ids: ['conc-1','liq-2'], unknown: ['team wallets'] };
const ok = (t) => ({ content: t, model: 'test-model', cost_usd: 0.01 });
let calls = [];
const order = [];
const deps = (answers, extra = {}) => ({
  route: async (args) => { calls.push(args); order.push(args.payload.role); return { ...ok(answers[args.payload.role]), cost_usd: 0.01 }; },
  ...extra,
});

let fails = 0;
const check = (name, cond, detail = '') => { if (!cond) { fails++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };

// A1 parallel advocates then reviewer
{
  calls = []; order.length = 0;
  const d = deps({
    sound: 'Top 10 holders own 42.5 percent of supply, and the mint authority is revoked.',
    fragile: 'Liquidity is 180000 USD, which is thin for the holder base described.',
    reviewer: JSON.stringify({ text: 'The two cases disagree on concentration while liquidity is 180000 USD.', weight: ['conc-1','bogus'], unknown: ['team wallets'] }),
  });
  const r = await debate(input, d);
  check('A1 status ok', r.status === 'ok', r.status);
  check('A1 two advocates called first, in parallel', calls.length === 3 && calls[0].payload.role === 'sound' && calls[1].payload.role === 'fragile');
  check('A1 reviewer got both texts', calls[2].payload.prompt.includes('42.5') && calls[2].payload.prompt.includes('180000'));
  check('A1 complexity exec then apex', calls[0].complexity === 'exec' && calls[2].complexity === 'apex');
  check('A1 weight filtered to flag ids', JSON.stringify(r.weight) === '["conc-1"]', JSON.stringify(r.weight));
  check('A1 usd summed', Math.abs(r.usd - 0.03) < 1e-9, String(r.usd));
  check('A1 shadow hides', r.shown === false);
}

// A2 unmeasured number replaces the advocate, reviewer failure drops the debate
{
  const goodReviewer = JSON.stringify({ text: 'Liquidity is 180000 USD.', weight: [], unknown: [] });
  const d = deps({
    sound: 'Holders own 99 percent of supply according to the facts.',
    fragile: 'Liquidity is 180000 USD.',
    reviewer: goodReviewer,
  });
  const r = await debate(input, d);
  check('A2 advocate replaced', r.sound === 'No case could be written from the measured facts.', JSON.stringify(r.sound));
  check('A2 reason kept', r.rejected.some((x) => x.includes('99')), JSON.stringify(r.rejected));
  check('A2 debate still ok with one replaced advocate', r.status === 'ok', r.status);

  const bad = deps({
    sound: 'Holders own 42.5 percent.',
    fragile: 'Liquidity is 180000 USD.',
    reviewer: 'not json at all',
  });
  const r2 = await debate(input, bad);
  check('A2 reviewer unparseable rejects with empty texts', r2.status === 'rejected' && r2.sound === '' && r2.fragile === '' && r2.reviewer === '', r2.status);
}

// A3 refused word, dash, word count, deps.check
{
  for (const [label, text] of [
    ['refused word', 'The structure is bullish and the supply is 42.5 percent held by 10 wallets.'],
    ['dash', 'Holders own 42.5 percent - a large share of the supply.'],
    ['too long', ('wallet 42.5 supply ').repeat(80)],
  ]) {
    const d = deps({ sound: text, fragile: 'Liquidity is 180000 USD.', reviewer: JSON.stringify({ text: 'Liquidity is 180000 USD.', weight: [], unknown: [] }) });
    const r = await debate(input, d);
    check(`A3 ${label} refused`, r.sound === 'No case could be written from the measured facts.' && r.rejected.length > 0, JSON.stringify(r.rejected));
  }
  const d = deps({ sound: 'Holders own 42.5 percent.', fragile: 'Liquidity is 180000 USD.', reviewer: JSON.stringify({ text: 'Liquidity is 180000 USD.', weight: [], unknown: [] }) }, { check: (t) => (t.includes('42.5') ? ['caller guard said no'] : []) });
  const r = await debate(input, d);
  check('A3 deps.check refuses', r.sound === 'No case could be written from the measured facts.' && r.rejected.join().includes('caller guard'), JSON.stringify(r.rejected));
}

// timeout, off, on
{
  const slow = { route: () => new Promise((res) => setTimeout(() => res({ content: 'x', cost_usd: 0 }), 500)) };
  const r = await debate(input, { ...slow, timeoutMs: 50 });
  check('timeout status', r.status === 'timeout', r.status);
}
{
  let touched = 0;
  const r = await debate(input, { route: async () => { touched++; return { content: '' }; }, mode: 'off' });
  check('off makes no call', touched === 0 && r.status === 'off' && r.shown === false);
}
{
  const d = deps({ sound: 'Holders own 42.5 percent.', fragile: 'Liquidity is 180000 USD.', reviewer: JSON.stringify({ text: 'Liquidity is 180000 USD against 42.5 percent concentration.', weight: ['liq-2'], unknown: [] }) }, { mode: 'on' });
  const r = await debate(input, d);
  check('on shows', r.shown === true && r.status === 'ok');
  check('never returns level or points', !('level' in r) && !('points' in r));
}

console.log(fails ? `\n${fails} FAILURES` : '\nall harness checks passed');
process.exit(fails ? 1 : 0);
