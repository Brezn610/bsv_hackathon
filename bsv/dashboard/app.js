// Treasury Guard dashboard. Read-only: GET /health and GET /decisions on the watcher, eth_call / eth_getLogs on Base
// Sepolia, GET on WhatsOnChain. It never calls /cosign or /broadcast, never signs, never holds a key.
// All external text is rendered with textContent. Contract values and sats stay BigInt / integers.
'use strict';

(function () {
  const EV = window.TG_CONFIG;
  const C = window.TGChain;

  // ---------------------------------------------------------------- configuration

  const params = new URLSearchParams(location.search);
  const httpUrl = (value, fallback) => {
    if (!value) return fallback;
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
      return u.href.replace(/\/+$/, '');
    } catch { return fallback; }
  };
  const CFG = {
    watcher: httpUrl(params.get('watcher'), 'http://127.0.0.1:4810'),
    rpc: httpUrl(params.get('rpc'), EV.base.rpcDefault),
    woc: httpUrl(params.get('woc'), EV.bsv.api)
  };
  const VAULT = BigInt(EV.base.vaultId);
  const RUNNER = BigInt(EV.base.runnerVaultId);
  const WOC_SCRIPT_HASH = C.reverseHex(EV.bsv.vaultScriptSha256);

  const INTERVAL = { health: 5000, decisions: 3000, base: 20000, logs: 30000, vault: 30000, tx: 60000 };
  // Log window, by time: the block rate is measured once (Base Sepolia produces several blocks per second).
  const LOG_WINDOW_SEC = 1800n;
  const LOG_MAX_PAGES = 60n; // never more than 60 eth_getLogs calls of 200 blocks for the first scan

  const base = C.createBase(CFG.rpc, EV.base.contract);
  const woc = C.createWoc(CFG.woc);
  const watcher = C.createWatcher(CFG.watcher);

  // ---------------------------------------------------------------- state

  const src = (interval) => ({ interval, status: 'loading', okAt: 0, error: null, value: undefined });
  const S = {
    health: src(INTERVAL.health),
    decisions: src(INTERVAL.decisions),
    base: src(INTERVAL.base),
    logs: src(INTERVAL.logs),
    vault: src(INTERVAL.vault),
    chain: { chainOk: null, block: null, count: null, intents: new Map(), v5: {}, v8: {}, others: {} },
    logData: { from: null, to: null, intentTx: new Map(), prices: [], intents: [], keys: new Set(), blocksPerWindow: null, secPerBlockMilli: null },
    tx: new Map(), // txid → { state: 'loading'|'mined'|'unconfirmed'|'unknown'|'error', height, at, error }
    receipts: new Map(), // intentId string → txid, from OP_RETURN of a vault UTXO's transaction
    receiptOut: new Map(), // intentId string → sats paid to the Agent Float script in that transaction
    seenDecisions: new Set(),
    newDecisions: new Set(),
    decisionsPrimed: false
  };

  // ---------------------------------------------------------------- DOM helpers

  const $ = (sel, root = document) => root.querySelector(sel);
  const h = (tag, props, ...children) => {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };
  const sigs = new WeakMap();
  // Replaces the children of `el` only when the panel's data signature changed: no flicker, no lost focus.
  const mount = (el, signature, build) => {
    if (!el || sigs.get(el) === signature) return;
    const openKeys = new Set([...el.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
    sigs.set(el, signature);
    el.replaceChildren(...[build()].flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
    for (const d of el.querySelectorAll('details[data-key]')) if (openKeys.has(d.dataset.key)) d.open = true;
  };
  const stringify = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Map ? [...x] : x));

  // ---------------------------------------------------------------- formatting (exact)

  const group = (n) => {
    const s = BigInt(n).toString();
    const neg = s.startsWith('-');
    const d = neg ? s.slice(1) : s;
    return (neg ? '−' : '') + d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
  const sats = (n) => `${group(n)} sats`;
  const fixed = (n, decimals, keep = decimals) => {
    const v = BigInt(n);
    const neg = v < 0n;
    const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
    let frac = s.slice(-decimals);
    const int = s.slice(0, -decimals) || '0';
    if (keep < decimals) frac = frac.slice(0, keep);
    return (neg ? '−' : '') + group(int) + (frac ? '.' + frac : '');
  };
  const trimZeros = (s, min = 2) => {
    const [i, f = ''] = s.split('.');
    let t = f.replace(/0+$/, '');
    if (t.length < min) t = f.slice(0, min).padEnd(min, '0');
    return t ? `${i}.${t}` : i;
  };
  const usd6 = (micro) => '$' + trimZeros(fixed(micro, 6));
  const price8 = (p) => '$' + fixed(p, 8);
  const pct = (bpsHundredths) => {
    const v = BigInt(bpsHundredths);
    return (v > 0n ? '+' : '') + fixed(v, 2) + ' %';
  };
  // sats × price(8 dec) = USD × 1e16. Truncates to two significant digits, marked "≈".
  const approxUsd = (satsN, priceN) => {
    const v = BigInt(satsN) * BigInt(priceN);
    if (v === 0n) return '$0';
    const s = v.toString().padStart(17, '0');
    const int = s.slice(0, -16).replace(/^0+(?=\d)/, '');
    const frac = s.slice(-16);
    if (int !== '0') return `≈ $${group(int)}.${frac.slice(0, 2)}`;
    const first = frac.search(/[1-9]/);
    return `≈ $0.${frac.slice(0, first + 2)}`;
  };
  const short = (hex, head = 8, tail = 4) => {
    const s = String(hex).replace(/^0x/, '');
    const pre = String(hex).startsWith('0x') ? '0x' : '';
    return s.length <= head + tail + 1 ? pre + s : `${pre}${s.slice(0, head)}…${s.slice(-tail)}`;
  };
  const dur = (sec) => {
    sec = Math.max(0, Math.round(Number(sec)));
    if (sec < 90) return `${sec} s`;
    const m = Math.floor(sec / 60);
    if (m < 90) return `${m} min`;
    const hh = Math.floor(m / 60);
    if (hh < 48) return `${hh} h ${m % 60} min`;
    return `${Math.floor(hh / 24)} d`;
  };
  const ago = (ms) => `${dur((Date.now() - ms) / 1000)} ago`;
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateTime = (ms) => new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

  // ---------------------------------------------------------------- links

  const TXID = /^[0-9a-f]{64}$/;
  const HASH = /^0x[0-9a-fA-F]{64}$/;
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const ext = (href, label, title) =>
    h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'mono', title: title || undefined }, label, h('span', { class: 'sr-only' }, ' (opens in a new tab)'));
  const wocTx = (txid) => (TXID.test(txid) ? ext(`${EV.bsv.explorer}/tx/${txid}`, short(txid), `${txid} on WhatsOnChain (BSV mainnet)`) : h('span', { class: 'mono' }, '—'));
  const baseTx = (hash) => (HASH.test(hash) ? ext(`${EV.base.explorer}/tx/${hash}`, short(hash), `${hash} on Basescan (Base Sepolia testnet)`) : h('span', { class: 'muted' }, 'not indexed'));
  const baseAddr = (a) => (ADDR.test(a) ? ext(`${EV.base.explorer}/address/${a}`, short(a, 6, 4), `${a} on Basescan`) : '—');

  // ---------------------------------------------------------------- source badges

  const LABEL = { live: 'Live', cached: 'Cached', recorded: 'Recorded', simulated: 'Simulated', unavailable: 'Unavailable', loading: 'Loading' };
  const freshness = (s) => {
    if (!s.okAt) return s.status === 'error' ? 'unavailable' : 'loading';
    if (s.status === 'error' || Date.now() - s.okAt > s.interval * 2.5) return 'cached';
    return 'live';
  };
  const badge = (kind, detail) => h('span', { class: `src src-${kind}` }, LABEL[kind] ?? kind, detail ? h('span', { class: 'src-detail' }, ` · ${detail}`) : null);
  // A badge bound to a source: its class and "x s ago" are refreshed every second by tick().
  const srcBadge = (key, name) => h('span', { class: 'src', dataset: { src: key, srcName: name } });
  const paintSrcBadges = () => {
    for (const el of document.querySelectorAll('[data-src]')) {
      const s = S[el.dataset.src];
      if (!s) continue;
      const kind = freshness(s);
      el.className = `src src-${kind}`;
      let detail = el.dataset.srcName;
      if (kind === 'live' || kind === 'cached') detail += ` · ${ago(s.okAt)}`;
      if (kind === 'unavailable' && s.error) detail += ` · ${s.retryInMs ? `retrying in ${Math.round(s.retryInMs / 1000)} s` : 'retrying'}`;
      el.textContent = LABEL[kind];
      el.append(h('span', { class: 'src-detail' }, ` · ${detail}`));
      el.title = s.error && kind !== 'live' ? `Last error: ${s.error.message || s.error}` : '';
    }
  };

  const txState = (txid) => {
    const t = S.tx.get(txid);
    if (!t || t.state === 'loading') return h('span', { class: 'tx-state tx-loading' }, 'checking…');
    if (t.state === 'mined') return h('span', { class: 'tx-state tx-mined', title: `Mined in block ${t.height} (WhatsOnChain, checked ${clock(t.at)})` }, `mined · block ${group(t.height)}`);
    if (t.state === 'unconfirmed') return h('span', { class: 'tx-state tx-zero', title: `WhatsOnChain reports no block yet (checked ${clock(t.at)})` }, 'broadcast (0-conf)');
    if (t.state === 'unknown') return h('span', { class: 'tx-state tx-error' }, 'not found on WhatsOnChain');
    return h('span', { class: 'tx-state tx-error', title: t.error || '' }, 'WhatsOnChain unavailable');
  };

  // ---------------------------------------------------------------- derived data

  const vaultIntents = () => [...S.chain.intents.entries()].filter(([, i]) => i.vaultId === VAULT);

  const liveDecisions = () => (Array.isArray(S.decisions.value) ? S.decisions.value : []);
  const decKey = (d) => `${d.at}|${d.intentId}|${d.status}`;
  const latestApproval = (id) => {
    let found = null;
    for (const d of liveDecisions()) if (String(d.intentId) === id && d.status === 200 && d.verdict === 'APPROVE') found = d;
    return found;
  };

  // One row per vault-5 intent. On-chain intents, live approvals and OP_RETURN receipts are merged by
  // intentId, so a withdrawal is counted once however many sources report it.
  const pipelineRows = () => {
    const ids = new Set();
    for (const [id] of vaultIntents()) ids.add(id);
    for (const d of liveDecisions()) if (d.status === 200 && d.verdict === 'APPROVE' && /^\d+$/.test(String(d.intentId))) ids.add(String(d.intentId));
    for (const id of S.receipts.keys()) ids.add(id);
    const now = nowSec();
    return [...ids].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)).map((id) => {
      const rec = null;
      const chain = S.chain.intents.get(id);
      const onChain = chain && chain.vaultId === VAULT ? chain : null;
      const dec = latestApproval(id);
      const logTx = S.logData.intentTx.get(id);
      const settleRecord = onChain && onChain.settled ? onChain.bsvTxid.slice(2).toLowerCase() : null;
      const receipt = S.receipts.get(id) || null;
      const txid = receipt || settleRecord || null;
      const txSource = receipt ? 'OP_RETURN receipt on BSV' : settleRecord ? 'settle record on Base' : null;
      const mismatch = receipt && settleRecord && receipt !== settleRecord;
      const approval = dec ? { toFloat: dec.toFloat, fee: dec.fee, vaultIn: dec.vaultIn, change: dec.change, proposalId: dec.proposalId, from: 'live' } : null;
      const maxSats = onChain ? onChain.maxSats : null;
      let state;
      if (receipt) state = 'withdrawn';
      else if (settleRecord) state = 'reported';
      else if (approval) state = 'cosigned';
      else if (onChain && onChain.kind === 'SWAP') state = 'swap';
      else if (onChain && now < onChain.expiry) state = 'open';
      else if (onChain) state = 'expired';
      else state = 'unknown';
      return {
        id, rec, onChain, approval, txid, txSource, mismatch, maxSats, state,
        baseCreatedTx: logTx?.txHash || null,
        settled: onChain ? onChain.settled : false,
        settleTx: null,
        payment: null,
        chainOut: S.receiptOut.get(id) ?? null
      };
    });
  };

  // ---------------------------------------------------------------- render: header

  const renderHeader = () => {
    const pill = $('#watcher-pill');
    const s = S.health;
    const k = freshness(s);
    const hv = s.value;
    let cls, text, title = '';
    if (k === 'live' && hv?.ok) {
      cls = 'pill-ok';
      const skew = Number(hv.clockSkewSec);
      text = `Watcher online · ${hv.binding} · clock skew ${skew > 0 ? '+' : ''}${skew} s · since ${clock(Date.parse(hv.startedAt))}`;
      title = `Watcher at ${CFG.watcher}. Started ${hv.startedAt}. ${hv.decisions} decisions since start.`;
    } else if (k === 'loading') { cls = 'pill-loading'; text = 'Watcher: checking…'; }
    else {
      cls = 'pill-bad';
      text = s.okAt ? `Watcher offline · last seen ${clock(s.okAt)}` : 'Watcher offline';
      title = `${CFG.watcher}: ${s.error?.message || 'no answer'}`;
    }
    pill.className = `pill ${cls}`;
    pill.title = title;
    $('.pill-text', pill).textContent = text;

    const warn = [];
    if (hv) {
      if (hv.base?.contract && hv.base.contract.toLowerCase() !== EV.base.contract.toLowerCase()) warn.push(`Watcher is bound to contract ${hv.base.contract}, not ${EV.base.contract}.`);
      if (hv.base?.vaultId && hv.base.vaultId !== String(EV.base.vaultId)) warn.push(`Watcher is bound to vault ${hv.base.vaultId}, not vault ${EV.base.vaultId}.`);
      if (hv.bsvNetwork && hv.bsvNetwork !== 'main') warn.push(`Watcher reports BSV network “${hv.bsvNetwork}”.`);
      if (hv.vaultScriptSha256 && hv.vaultScriptSha256 !== EV.bsv.vaultScriptSha256) warn.push('Watcher reports a different vault script than the configured binding.');
    }
    if (S.chain.chainOk === false) warn.push(`The Base RPC ${CFG.rpc} does not serve chain ${EV.base.chainId}; Base panels are disabled.`);
    const banner = $('#banner');
    const msgs = [];
    for (const w of warn) msgs.push(['warn', w]);
    mount(banner, stringify(msgs), () => msgs.map(([kind, m]) => h('p', { class: `banner-line banner-${kind}` }, m)));
    banner.hidden = msgs.length === 0;
  };

  // ---------------------------------------------------------------- render: flow strip



  const STEPS = [
    ['price', 'API3 signed price', 'base'],
    ['intent', 'Base intent', 'base'],
    ['watcher', 'Watcher check', 'watcher'],
    ['vault', 'BSV vault', 'bsv'],
    ['float', 'Agent Float', 'bsv'],
    ['pay', 'HTTP 402 payment', 'bsv']
  ];
  const renderFlow = () => {
    const live = liveDecisions();
    const last = live.length ? live[live.length - 1] : null;
    let reach, stop = null, caption;
    if (last) {
      if (last.status === 200) { reach = 2; caption = `Latest watcher decision: intent ${last.intentId} co-signed at ${clock(Date.parse(last.at))}. Approval alone does not establish broadcast or payment.`; }
      else { reach = 2; stop = 2; caption = `Latest live decision: intent ${last.intentId} refused (${last.status}) at ${clock(Date.parse(last.at))}. Nothing was signed.`; }
    } else {
      const latest = pipelineRows().find((r) => r.state === 'withdrawn');
      if (latest && !latest.rec) {
        reach = 4;
        caption = `Latest run: intent ${latest.id}, live from both chains. Its 402 purchase is not publicly visible.`;
      } else {
        reach = -1;
        caption = 'Waiting for a transaction from the connected sources. No payment has been verified by this dashboard.';
      }
    }
    const fromChain = !last && reach >= 0;
    const isNew = last && S.newDecisions.has(decKey(last));
    mount($('#flow'), stringify([reach, stop, caption, isNew, fromChain]), () => [
      ...STEPS.map(([key, label, chain], i) => {
        const st = stop === i ? 'stop' : i <= reach ? 'done' : 'todo';
        return h('li', { class: `flow-step flow-${chain} is-${st}${isNew && i <= reach ? ' is-new' : ''}` },
          h('span', { class: 'flow-num', 'aria-hidden': 'true' }, String(i + 1)),
          h('span', { class: 'flow-label' }, label),
          h('span', { class: 'sr-only' }, st === 'done' ? ' (reached)' : st === 'stop' ? ' (refused here)' : ' (not reached)'));
      }),
      h('li', { class: 'flow-caption' }, last ? srcBadge('decisions', 'watcher') : fromChain ? srcBadge('base', 'chain') : h('span', { class: 'muted' }, 'No activity loaded'), ' ', caption)
    ]);
  };

  // ---------------------------------------------------------------- render: Decide lane

  const intentForPrice = (lp) => {
    if (!lp) return null;
    for (const [id, i] of vaultIntents()) if (i.priceSignedAt === lp.signedAt) return { id, intent: i };
    return null;
  };

  const renderPrice = () => {
    const el = $('#price-card');
    const v5 = S.chain.v5;
    const lp = v5.lastPrice;
    const cfg = v5.config;
    const feed = EV.base.feeds.bsvUsd;
    const head = h('div', { class: 'card-head' }, h('h3', { id: 'price-title' }, 'Signed BSV/USD price'), srcBadge('base', 'Base Sepolia'));
    if (!lp || !lp.signedAt) {
      const msg = S.base.status === 'error' ? 'Base RPC unavailable. No price loaded.' : 'Waiting for signed-price data from Base Sepolia…';
      mount(el, stringify(['p-empty', msg]), () => [head, h('p', { class: 'state' }, msg)]);

      return;
    }
    const obs = lp.signedAt - lp.updatedAt;
    const match = intentForPrice(lp);
    const createdAt = match && cfg ? match.intent.expiry - cfg.intentTtl : null;
    const acc = createdAt !== null ? createdAt - lp.signedAt : null;
    const airOk = cfg && cfg.priceAirnode.toLowerCase() === feed.airnode.toLowerCase();
    const reqOk = cfg && cfg.priceRequestHash.toLowerCase() === feed.requestHash.toLowerCase();
    const txHash = match ? S.logData.intentTx.get(match.id)?.txHash : null;
    const sig = stringify([lp, cfg, match?.id, txHash, airOk, reqOk]);
    mount(el, sig, () => [head,
      h('p', { class: 'big' }, h('span', { class: 'num' }, price8(lp.price)), h('span', { class: 'unit' }, ' per BSV'),
        h('span', { class: `delta ${lp.change1h < 0n ? 'down' : 'up'}` }, ` ${lp.change1h < 0n ? '▼' : '▲'} ${pct(lp.change1h < 0n ? -lp.change1h : lp.change1h).replace('+', '')} 1 h`)),
      h('dl', { class: 'facts' },
        h('div', null, h('dt', null, 'Signed'), h('dd', null, h('span', { dataset: { agoSec: lp.signedAt.toString() } }))),
        h('div', null, h('dt', null, 'Observed'), h('dd', null, h('span', { dataset: { agoSec: lp.updatedAt.toString() } }))),
        h('div', null, h('dt', null, 'Observed → signed'), h('dd', null, h('span', { class: 'num' }, dur(obs)), ' ', check(cfg && obs <= cfg.maxDataAge, `≤ ${cfg ? dur(cfg.maxDataAge) : '600 s'}`))),
        h('div', null, h('dt', null, 'Signed → accepted on Base'), h('dd', null, acc !== null ? [h('span', { class: 'num' }, dur(acc)), ' ', check(acc <= cfg.maxSignatureAge, `≤ ${dur(cfg.maxSignatureAge)}`)] : h('span', { class: 'muted' }, 'n/a (price-only submission)')))),
      h('p', { class: 'small' }, 'Accepted ', createdAt !== null ? h('span', { dataset: { agoSec: createdAt.toString() } }, '') : h('span', { dataset: { agoSec: lp.signedAt.toString(), prefix: 'signed ' } }, ''),
        txHash ? [' in ', baseTx(txHash)] : null, match ? ` · created SPEND intent ${match.id}` : ''),
      h('p', { class: 'small' }, feed.name, ' Airnode ', baseAddr(feed.airnode), ' ', check(airOk && reqOk, airOk && reqOk ? 'signer and request match vault 5' : 'differs from the vault config')),
      h('p', { class: 'note' }, h('span', null, 'No valid signature → no intent → no BSV moves.'), h('a', { href: '#tamper', class: 'jump' }, 'Try to cheat it ↓'))]);
  };
  const check = (ok, text) => h('span', { class: ok ? 'ok' : 'bad' }, ok ? '✓ ' : '✗ ', text);

  const renderBudget = () => {
    const el = $('#budget-card');
    const v5 = S.chain.v5;
    const cfg = v5.config;
    const head = h('div', { class: 'card-head' }, h('h3', { id: 'budget-title' }, 'Today’s budget · vault 5'), srcBadge('base', 'Base Sepolia'));
    if (!cfg || v5.remaining === undefined) {
      const msg = S.base.status === 'error' ? 'Base RPC unavailable. No budget loaded.' : 'Waiting for vault budget data…';
      mount(el, stringify(['b-empty', msg]), () => [head, h('p', { class: S.base.status === 'error' ? 'state state-error' : 'state' }, msg)]);
      return;
    }
    const rem = v5.remaining, daily = cfg.dailyBudgetUsd;
    const pctLeft = daily > 0n ? Number((rem * 1000n) / daily) / 10 : 0;
    mount(el, stringify([rem, daily, v5.regime, cfg]), () => [head,
      h('div', { class: 'budget-row' },
        h('p', { class: 'big' }, h('span', { class: 'num' }, usd6(rem)), h('span', { class: 'unit' }, ` left of ${usd6(daily)}`)),
        h('span', { class: `regime regime-${String(v5.regime).toLowerCase()}`, title: `Set by the contract from the signed 1 h change. Breaker ${pct(cfg.breakerBps)} → RISK_OFF, re-entry ${pct(cfg.reentryBps)}, cooldown ${dur(cfg.cooldown)}, hedge caps ${fixed(cfg.breakerHedgeBps, 2, 0)} % / ${fixed(cfg.eventHedgeBps, 2, 0)} %.` }, v5.regime)),
      h('div', { class: 'bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pctLeft), 'aria-label': 'Daily budget remaining' },
        h('span', { class: 'bar-fill bar-base', style: undefined, dataset: { w: String(pctLeft) } })),
      h('p', { class: 'muted small' }, `Spent today ${usd6(daily - rem)} · resets 00:00 UTC · intents expire after ${dur(cfg.intentTtl)}`),
      h('p', { class: 'small' }, h('a', { href: '#agent', class: 'link-tab', dataset: { tab: 'agent' } }, runnerLine()))]);
  };
  const runnerLine = () => {
    const lp = S.chain.v8.lastPrice;
    if (!lp || !lp.signedAt) return 'Autonomous runner (vault 8, no BSV funds) →';
    return `Autonomous runner (vault 8, no BSV funds): last signed price ${dur(Number(nowSec() - lp.signedAt))} ago →`;
  };

  // ---------------------------------------------------------------- render: Enforce lane

  const STATUS = {
    200: ['ok', 'Approved'],
    409: ['warn', 'Already used'],
    422: ['bad', 'Policy refusal'],
    403: ['bad', 'Forged or missing agent signature'],
    400: ['neutral', 'Malformed request']
  };
  const decisionRow = (d, kind, isNew) => {
    const [cls, label] = STATUS[d.status] || ['neutral', `HTTP ${d.status}`];
    const at = Date.parse(d.at);
    const reasons = Array.isArray(d.reasons) ? d.reasons.map(String) : [];
    return h('li', { class: `dec dec-${cls}${kind === 'recorded' ? ' dec-recorded' : ''}${isNew ? ' is-new' : ''}` },
      h('div', { class: 'dec-top' },
        h('time', { class: 'mono', datetime: d.at, title: d.at }, Number.isFinite(at) ? (kind === 'recorded' ? dateTime(at) : clock(at)) : '—'),
        h('span', { class: 'dec-intent' }, `intent ${String(d.intentId)}`),
        h('span', { class: `status status-${cls}` }, `${d.status} ${label}`)),
      d.status === 200 && d.verdict === 'APPROVE'
        ? h('p', { class: 'dec-detail mono' }, `${group(d.vaultIn ?? 0)} in → ${group(d.toFloat ?? 0)} to float · ${group(d.change ?? 0)} back · ${group(d.fee ?? 0)} fee`,
          d.proposalId ? h('span', { class: 'proposal', title: 'Txid of the transaction before unlocking scripts. It is not the final BSV txid.' }, ` · proposal ${short(String(d.proposalId))} (not the BSV txid)`) : null)
        : null,
      reasons.length === 1 ? h('p', { class: 'dec-reason' }, reasons[0]) : null,
      reasons.length > 1 ? h('details', { class: 'dec-reasons', dataset: { key: decKey(d) } },
        h('summary', null, reasons[0], h('span', { class: 'muted' }, ` (+${reasons.length - 1} more)`)),
        h('ul', null, reasons.slice(1).map((r) => h('li', null, r)))) : null);
  };

  const renderDecisions = () => {
    const el = $('#decisions-card');
    const live = liveDecisions().slice().reverse();
    const fr = freshness(S.decisions);
    const reached = S.decisions.okAt > 0;
    const startedAt = S.health.value?.startedAt;
    const counts = live.reduce((a, d) => { a[d.status === 200 ? 'ok' : 'no']++; return a; }, { ok: 0, no: 0 });
    const sig = stringify([live, fr === 'live', reached, startedAt, [...S.newDecisions], S.decisions.status]);
    mount(el, sig, () => {
      const out = [h('div', { class: 'card-head' }, h('h3', { id: 'decisions-title' }, 'Watcher decisions'), srcBadge('decisions', 'watcher /decisions'))];
      if (reached) out.push(h('p', { class: 'muted small' }, `${counts.ok} approved · ${counts.no} refused since the watcher started${startedAt ? ` (${clock(Date.parse(startedAt))})` : ''}`));
      const list = h('ol', { class: 'dec-list', 'aria-live': 'polite', 'aria-relevant': 'additions' });
      {
        if (live.length) list.append(...live.map((d) => decisionRow(d, 'live', S.newDecisions.has(decKey(d)))));
        else if (reached) list.append(h('li', { class: 'empty' }, 'Waiting for the next agent request. New approvals and refusals will appear here.'));
        else if (S.decisions.status === 'error') list.append(h('li', { class: 'empty empty-bad' }, `Watcher unreachable at ${CFG.watcher}. Live decisions appear here when it is running.`));
        else list.append(h('li', { class: 'empty' }, 'Contacting the watcher…'));
      }
      out.push(list);
      return out;
    });
  };

  // ---------------------------------------------------------------- render: Move lane

  const renderVault = () => {
    const el = $('#vault-card');
    const v = S.vault.value;
    const hv = S.health.value;
    const price = S.chain.v5.lastPrice?.price;
    const head = h('div', { class: 'card-head' }, h('h3', { id: 'vault-title' }, 'Vault balance'), srcBadge('vault', 'WhatsOnChain'));
    const hashCheck = hv?.vaultScriptSha256
      ? (C.reverseHex(hv.vaultScriptSha256) === WOC_SCRIPT_HASH ? check(true, 'script hash matches the watcher’s binding') : check(false, 'script hash differs from the watcher’s binding'))
      : h('span', { class: 'muted' }, 'Configured script hash; watcher binding not checked yet');
    if (!v) {
      const msg = S.vault.status === 'error' ? 'WhatsOnChain unavailable. No balance loaded.' : 'Waiting for vault balance from WhatsOnChain…';
      mount(el, stringify(['v-empty', msg]), () => [head, h('p', { class: S.vault.status === 'error' ? 'state state-error' : 'state' }, msg), h('p', { class: 'small' }, hashCheck)]);
      return;
    }
    mount(el, stringify([v, hv?.vaultScriptSha256, price]), () => [head,
      h('p', { class: 'big' }, h('span', { class: 'num' }, group(v.total)), h('span', { class: 'unit' }, ' sats'), price ? h('span', { class: 'usd' }, ` ${approxUsd(v.total, price)}`) : null),
      h('ul', { class: 'utxos' }, v.utxos.length ? v.utxos.map((u) => h('li', null, wocTx(u.tx_hash), `:${u.tx_pos} · ${group(u.value)} sats · `,
        h('span', { class: u.status === 'confirmed' ? 'ok' : 'warnc' }, u.status === 'confirmed' ? `confirmed · block ${group(u.height)}` : 'unconfirmed'),
        u.isSpentInMempoolTx ? h('span', { class: 'warnc' }, ' · being spent in mempool (excluded)') : null))
        : h('li', { class: 'muted' }, 'No unspent coins at the vault script.')),
      h('p', { class: 'small' }, hashCheck)]);
  };

  const renderFlows = (rows) => {
    const observed = rows.filter((r) => r.chainOut !== null);
    const paid = observed.reduce((sum, r) => sum + r.chainOut, 0n);
    mount($('#flows-card'), stringify([paid, observed.length]), () => [
      h('div', { class: 'card-head' }, h('h3', { id: 'flows-title' }, 'Agent funding & purchases')),
      h('p', { class: 'big num' }, observed.length ? sats(paid) : '—'),
      h('p', { class: 'muted small' }, observed.length ? `Paid to the float in ${observed.length} observed BSV transactions.` : 'No withdrawal into the float has been read from BSV.'),
      h('p', { class: 'state' }, 'HTTP 402 purchases: not connected. A payment receipt source is required to show actual purchases.'),
      h('p', { class: 'muted small' }, 'The full float wallet balance is not public.')
    ]);
  };

  // ---------------------------------------------------------------- render: pipeline

  const STATE_LABEL = {
    withdrawn: ['ok', 'Withdrawal observed'],
    reported: ['info', 'Settlement reported · BSV not verified'],
    cosigned: ['warn', 'Co-signed · BSV txid not seen yet'],
    open: ['info', 'Open'],
    expired: ['neutral', 'Expired · no withdrawal observed'],
    swap: ['neutral', 'SWAP · the watcher never co-signs swaps'],
    unknown: ['neutral', 'Unknown']
  };
  const txFreshness = (rows) => {
    const states = rows.flatMap((r) => [r.txid, r.payment?.txid]).filter(Boolean).map((id) => S.tx.get(id)?.state);
    if (states.some((x) => x === 'error')) return 'unavailable';
    if (!states.length || states.some((x) => !x || x === 'loading')) return 'loading';
    return 'live';
  };
  const renderPipeline = (rows) => {
    const el = $('#pipeline');
    const txSig = rows.map((r) => [r.txid, S.tx.get(r.txid)?.state, r.payment ? S.tx.get(r.payment.txid)?.state : null]);
    const sig = stringify([rows.map((r) => [r.id, r.state, r.txid, r.mismatch, r.settled, r.maxSats, r.approval, r.baseCreatedTx, r.onChain?.expiry, r.chainOut]), txSig, S.base.okAt > 0]);
    mount(el, sig, () => {
      const head = h('div', { class: 'card-head' },
        h('h3', { id: 'pipeline-title' }, 'Intent → withdrawal → payment', h('span', { class: 'muted' }, ' · vault 5 only')),
        h('span', { class: 'head-badges' }, srcBadge('base', 'Base'), ' ', badge(txFreshness(rows), 'tx status: WhatsOnChain')));
      const sub = h('p', { class: 'muted' }, 'Compare each observed withdrawal with its intent limit (outflow includes the fee). A Base settle is a record written by the API3 agent, not cross-chain proof.');
      const table = h('table', { class: 'pipe' },
        h('caption', { class: 'sr-only' }, 'Vault 5 SPEND intents and what happened to each'),
        h('thead', null, h('tr', null, ['Intent', 'Limit (maxSats)', 'Watcher', 'BSV withdrawal', 'Outflow incl. fee ÷ limit', 'HTTP 402 from it', 'Base settle'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows.length ? rows.map(pipeRow) : h('tr', null, h('td', { colspan: '7', class: 'empty' }, 'No vault-5 intents found.'))));
      return [head, sub, h('div', { class: 'table-wrap' }, table)];
    });
  };
  const pipeRow = (r) => {
    const [cls, label] = STATE_LABEL[r.state];
    const outflow = r.approval ? BigInt(r.approval.toFloat ?? 0) + BigInt(r.approval.fee ?? 0) : null;
    const share = outflow !== null && r.maxSats ? Number((outflow * 1000n) / r.maxSats) / 10 : null;
    const usd = r.onChain && r.maxSats ? approxUsd(r.maxSats, r.onChain.price) : null;
    const payeeWord = r.rec && r.rec.payee !== 'Agent Float wallet' ? 'agent wallet' : 'float';
    let watcherCell;
    if (r.rec) watcherCell = [h('span', { class: 'status status-ok' }, '200 Approved'), h('span', { class: 'muted small block' }, r.rec.watcher)];
    else if (r.approval) watcherCell = [h('span', { class: 'status status-ok' }, '200 Approved'), h('span', { class: 'muted small block' }, 'live feed')];
    else if (r.state === 'withdrawn') watcherCell = [h('span', { class: 'status status-ok' }, 'Co-signed'), h('span', { class: 'muted small block', title: 'The vault pays out only with the agent’s and the watcher’s signatures, or the owner’s alone (which carries no TGv1 receipt).' }, 'shown by the payout')];
    else watcherCell = h('span', { class: 'muted small' }, r.state === 'swap' ? 'not eligible' : 'no approval seen');
    return h('tr', { class: `row-${cls}` },
      h('th', { scope: 'row' },
        h('span', { class: 'intent-id' }, `#${r.id}`), h('span', { class: `status status-${cls}` }, label),
        h('span', { class: 'small block' },
          r.state === 'open' ? h('span', { class: 'countdown', dataset: { untilSec: r.onChain.expiry.toString() } }, '') : null,
          r.state === 'open' && r.baseCreatedTx ? ' · ' : null,
          r.baseCreatedTx ? h('span', { class: 'nowrap' }, 'created ', baseTx(r.baseCreatedTx)) : null)),
      h('td', { class: 'num', title: r.onChain ? `Signed price ${price8(r.onChain.price)} per BSV` : '' }, r.maxSats !== null ? group(r.maxSats) : '—',
        usd ? h('span', { class: 'muted small block' }, usd) : null),
      h('td', null, watcherCell),
      h('td', null, r.txid ? [wocTx(r.txid), r.txSource === 'recorded run' ? null : h('span', { class: 'muted small' }, ` via ${r.txSource}`), h('span', { class: 'block' }, txState(r.txid))] : h('span', { class: 'muted' }, '—'),
        r.mismatch ? h('span', { class: 'bad small block' }, '✗ settle record differs from the recorded txid') : null),
      h('td', null, outflow !== null && r.maxSats ? [
        h('span', { class: 'num', title: `${group(r.approval.toFloat)} to ${payeeWord} + ${group(r.approval.fee)} fee` }, `${group(outflow)} / ${group(r.maxSats)}`),
        h('span', { class: 'bar bar-sm', role: 'img', 'aria-label': `${share} % of the limit used` }, h('span', { class: `bar-fill ${share <= 100 ? 'bar-ok' : 'bar-bad'}`, dataset: { w: String(Math.min(share, 100)) } }))
      ] : r.chainOut ? [h('span', { class: 'num' }, `${group(r.chainOut)} to float`), h('span', { class: 'muted small block' }, 'read from the BSV tx · fee not shown')]
        : h('span', { class: 'muted' }, '—')),
      h('td', null, r.payment ? [wocTx(r.payment.txid), ' ', txState(r.payment.txid),
        r.rec.model ? h('details', { class: 'small', dataset: { key: `why-${r.id}` } },
          h('summary', null, `${group(r.payment.sats)} sats · HTTP ${r.payment.http} · ${r.rec.model.by} chose BUY`),
          h('p', null, r.rec.model.reason), h('p', { class: 'muted' }, `Merchant: ${r.payment.merchant}. The guardian’s rules approved it; the payment is real.`))
          : h('span', { class: 'muted small block' }, `${group(r.payment.sats)} sats · HTTP ${r.payment.http}`)]
        : r.rec ? h('span', { class: 'muted small', title: r.rec.paymentNote || '' }, 'none from this withdrawal') : h('span', { class: 'muted small' }, 'not visible from public data')),
      h('td', null, r.settled === true || r.settled === 'recorded'
        ? [h('span', { class: 'status status-info' }, 'recorded'), r.settleTx ? [' ', baseTx(r.settleTx)] : null, r.settled === 'recorded' ? h('span', { class: 'muted small block' }, 'from RESULTS.md') : null]
        : h('span', { class: 'muted' }, 'not settled')));
  };
  // ---------------------------------------------------------------- render: trust

  const renderTrust = () => {
    mount($('#trust'), 'live-only', () => [
      h('div', { class: 'card-head' }, h('h3', { id: 'trust-title' }, 'Validation status')),
      h('p', { class: 'state' }, 'End-to-end testing pending. No bundled test results or example transactions are shown.'),
      h('h4', null, 'Owner-only exit'),
      h('p', { class: 'muted small' }, 'A design capability; no exit transaction has been verified by this dashboard.'),
      h('h4', null, 'Reading the evidence'),
      h('p', { class: 'muted small' }, 'Watcher approval means co-signing, not broadcast. A Base settlement is an agent-written record, not cross-chain verification. BSV status comes from WhatsOnChain.')
    ]);
  };

  // ---------------------------------------------------------------- render: vault 8 tab

  const renderAgentTab = () => {
    const el = $('#tab-agent');
    const v8 = S.chain.v8;
    const lp = v8.lastPrice;
    const cfg = v8.config;
    const prices = S.logData.prices.filter((p) => p.vaultId === RUNNER).slice().reverse();
    const intents8 = [...S.chain.intents.entries()].filter(([, i]) => i.vaultId === RUNNER);
    const logIntents = new Map(S.logData.intents.filter((i) => i.vaultId === RUNNER).map((i) => [i.txHash, i]));
    const sig = stringify([lp, cfg, v8.regime, v8.remaining, prices, intents8, S.logData.from, S.logData.to, S.logs.status]);
    mount(el, sig, () => {
      const active = lp && lp.signedAt > 0n ? Number(nowSec() - lp.signedAt) < 25 * 60 : false;
      return [
        h('h2', { class: 'tab-title' }, 'Autonomous agent · vault 8'),
        h('p', { class: 'lede small' }, 'The API3 runner (api3/src/agent.ts) buys a signed BSV/USD price over x402 and submits it on its own, about every 10 minutes. Vault 8 has ', h('strong', null, 'no BSV funds'), ': its activity is separate from vault 5. Nothing here is counted in vault 5.'),
        h('div', { class: 'grid-3' },
          h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Last signed price'), srcBadge('base', 'Base Sepolia')),
            lp && lp.signedAt > 0n ? [
              h('p', { class: 'big' }, h('span', { class: 'num' }, price8(lp.price)), h('span', { class: 'unit' }, ' per BSV')),
              h('dl', { class: 'facts' },
                h('div', null, h('dt', null, 'Signed'), h('dd', null, h('span', { dataset: { agoSec: lp.signedAt.toString() } }, ''))),
                h('div', null, h('dt', null, 'Observed'), h('dd', null, h('span', { dataset: { agoSec: lp.updatedAt.toString() } }, ''))),
                h('div', null, h('dt', null, 'Observed → signed'), h('dd', null, dur(lp.signedAt - lp.updatedAt), ' ', check(cfg && lp.signedAt - lp.updatedAt <= cfg.maxDataAge, 'limit 600 s')))),
              h('p', { class: active ? 'ok small' : 'warnc small' }, active ? 'Runner active: a price was accepted in the last 25 min.' : 'Runner idle: no accepted price in the last 25 min.')
            ] : h('p', { class: 'state' }, S.base.status === 'error' ? 'Base RPC unavailable.' : 'Reading vault 8…')),
          h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Budget and regime'), srcBadge('base', 'Base Sepolia')),
            cfg && v8.remaining !== undefined ? [
              h('p', { class: 'big' }, h('span', { class: 'num' }, usd6(v8.remaining)), h('span', { class: 'unit' }, ` left of ${usd6(cfg.dailyBudgetUsd)}`)),
              h('p', null, h('span', { class: `regime regime-${String(v8.regime).toLowerCase()}` }, v8.regime)),
              h('p', { class: 'muted small' }, 'Agent ', baseAddr(cfg.agent), ' · its own key, never the vault-5 agent.')
            ] : h('p', { class: 'state' }, '—')),
          h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Intents of vault 8')),
            intents8.length ? h('ul', { class: 'plain small' }, intents8.map(([id, i]) => h('li', null, `#${id} · ${i.kind} · max ${group(i.maxSats)} sats · `, i.settled ? 'settled' : nowSec() < i.expiry ? 'open' : 'expired', ' · never co-signed')))
              : h('p', { class: 'state' }, 'None read yet.'))),
        h('section', { class: 'card card-wide' },
          h('div', { class: 'card-head' }, h('h3', null, 'Recent cycles on chain'), srcBadge('logs', 'PriceVerified events')),
          h('p', { class: 'muted small' }, S.logData.from !== null && S.logData.from <= S.logData.to
            ? `Blocks ${group(S.logData.from)}–${group(S.logData.to)}${S.logData.secPerBlockMilli ? `, about the last ${dur(Number(((S.logData.to - S.logData.from + 1n) * S.logData.secPerBlockMilli) / 1000n))}` : ''}, read in pages of 200 blocks (the public RPC’s limit). Older cycles: Basescan.`
            : 'Reading recent blocks…'),
          prices.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'pipe' },
            h('thead', null, h('tr', null, ['Signed', 'Price', '1 h change', 'Spend intent', 'Base tx'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, prices.slice(0, 20).map((p) => {
              const it = logIntents.get(p.txHash);
              return h('tr', null, h('td', { class: 'mono' }, dateTime(Number(p.signedAt) * 1000)), h('td', { class: 'num' }, price8(p.price)), h('td', { class: 'num' }, pct(p.change1h)),
                h('td', null, it ? `#${it.intentId} · ${group(it.maxSats)} sats` : h('span', { class: 'muted' }, 'price only')), h('td', null, baseTx(p.txHash)));
            }))))
            : S.logData.from !== null && S.logData.from <= S.logData.to ? h('p', { class: 'empty' }, 'No vault-8 price was accepted in this window yet.') : null)
      ];
    });
  };

  // ---------------------------------------------------------------- render: hedges tab

  const renderHedgesTab = () => {
    const el = $('#tab-hedges');
    const all = [...S.chain.intents.entries()];
    const hedges = all.filter(([, i]) => i.source !== 'BUDGET' || i.kind === 'SWAP');
    const regimes = S.chain.others;
    const sig = stringify([all.length, hedges, regimes, S.chain.v5.regime, S.chain.v8.regime]);
    mount(el, sig, () => [
      h('h2', { class: 'tab-title' }, 'Event hedges'),
      h('p', { class: 'lede small' }, 'A signed post from a whitelisted account, with a fresh signed price, can move a vault to GUARDED and create a SWAP hedge of at most 25 %. A −5 % signed 1 h move triggers RISK_OFF with a 50 % hedge. The watcher never co-signs SWAP intents, so hedges move no BSV in this submission.'),
      h('div', { class: 'grid-2' },
        h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Hedge intents on the contract'), srcBadge('base', 'Base Sepolia')),
          !all.length ? h('p', { class: 'state' }, S.base.status === 'error' ? 'Base RPC unavailable.' : 'Reading intents…')
              : hedges.length ? h('ul', { class: 'plain small' }, hedges.map(([id, i]) => h('li', null, `#${id} · vault ${i.vaultId} · ${i.kind} ${i.direction} · source ${i.source} · max ${fixed(i.maxBps, 2, 0)} % · `, nowSec() < i.expiry ? 'open' : 'expired')))
                : h('p', { class: 'empty' }, `No hedge intent exists yet: all ${all.length} intents on the contract are BUDGET spends.`)),
        h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Regimes'), srcBadge('base', 'Base Sepolia')),
          h('ul', { class: 'plain' }, [['5', 'team vault', S.chain.v5.regime], ['6', 'judge vault (video)', regimes[6]], ['7', 'judge vault (live judging)', regimes[7]], ['8', 'API3 runner', S.chain.v8.regime]].map(([v, what, r]) =>
            h('li', null, `Vault ${v} · ${what} · `, r ? h('span', { class: `regime regime-${String(r).toLowerCase()}` }, r) : h('span', { class: 'muted' }, '—')))),
          h('p', { class: 'muted small' }, 'No bundled test results are shown.')))
    ]);
  };

  // ---------------------------------------------------------------- render: evidence tab

  const evidenceRows = () => pipelineRows().flatMap((r) => [
    ...(r.baseCreatedTx ? [{ what: `Intent ${r.id} created`, net: 'Base Sepolia · testnet', base: r.baseCreatedTx, detail: 'Read from contract events' }] : []),
    ...(r.txid ? [{ what: `Intent ${r.id} BSV transaction`, net: 'BSV · mainnet', txid: r.txid, detail: r.txSource }] : [])
  ]);

  const renderEvidenceTab = () => {
    const el = $('#tab-evidence');
    const rows = evidenceRows();
    const sig = stringify([rows, rows.map((x) => S.tx.get(x.txid)?.state)]);
    mount(el, sig, () => [
      h('h2', { class: 'tab-title' }, 'All evidence'),
      h('p', { class: 'lede small' }, 'Transactions discovered from connected sources. No bundled transaction history is included.'),
      h('section', { class: 'card card-wide' }, h('div', { class: 'table-wrap' }, h('table', { class: 'pipe' },
        h('thead', null, h('tr', null, ['What', 'Network', 'Transaction', 'Status', 'Detail'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows.length ? rows.map((x) => h('tr', null, h('th', { scope: 'row' }, x.what), h('td', null, x.net), h('td', null, x.txid ? wocTx(x.txid) : baseTx(x.base)),
          h('td', null, x.txid ? txState(x.txid) : h('span', { class: 'muted small' }, 'see Basescan')), h('td', { class: 'small' }, x.detail))) : h('tr', null, h('td', { colspan: '5', class: 'empty' }, 'No transactions loaded. Waiting for connected sources.')))))),
      h('p', { class: 'muted small' }, 'Source: ', ext('https://github.com/eujinnl/bsv_hackathon/blob/main/bsv/docs/evidence/RESULTS.md', 'bsv/docs/evidence/RESULTS.md'), '. Documentation only; no results are imported.')
    ]);
  };

  // ---------------------------------------------------------------- footer

  const renderFooter = () => {
    const hv = S.health.value;
    const sig = stringify([hv?.watcherKey, hv?.agentKey, hv?.vaultScriptSha256]);
    mount($('#footer'), sig, () => [
      h('p', null, h('strong', null, 'Read-only: this page cannot move money.'), ' It sends GET requests to the watcher and WhatsOnChain and read-only eth_call / eth_getLogs to Base Sepolia. It holds no key.'),
      h('dl', { class: 'foot-facts' },
        h('div', null, h('dt', null, 'Contract (Base Sepolia, chain 84532)'), h('dd', null, ext(`${EV.base.explorer}/address/${EV.base.contract}`, EV.base.contract))),
        h('div', null, h('dt', null, 'Vault script SHA-256'), h('dd', { class: 'mono' }, hv?.vaultScriptSha256 || EV.bsv.vaultScriptSha256, h('span', { class: 'muted' }, hv?.vaultScriptSha256 ? ' (watcher /health)' : ' (configured)' ))),
        h('div', null, h('dt', null, 'Agent key'), h('dd', { class: 'mono' }, hv?.agentKey || 'Not connected')),
        h('div', null, h('dt', null, 'Watcher key'), h('dd', { class: 'mono' }, hv?.watcherKey || 'Not connected'))),
      h('p', { class: 'muted small' }, 'Sources: watcher ', h('span', { class: 'mono' }, CFG.watcher), ' · Base RPC ', h('span', { class: 'mono' }, CFG.rpc), ' · ', h('span', { class: 'mono' }, CFG.woc), ' · ',
        ext('https://github.com/eujinnl/bsv_hackathon/blob/main/bsv/docs/evidence/RESULTS.md', 'RESULTS.md'), ' · ', ext('https://github.com/eujinnl/bsv_hackathon/pull/2', 'PR #2'))
    ]);
  };

  // ---------------------------------------------------------------- render loop and tick

  let pending = false;
  const render = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const rows = pipelineRows();
      renderHeader(); renderFlow(); renderPrice(); renderBudget(); renderDecisions(); renderVault(); renderFlows(rows); renderPipeline(rows); renderTrust();
      const tab = currentTab();
      if (tab === 'agent') renderAgentTab();
      if (tab === 'hedges') renderHedgesTab();
      if (tab === 'evidence') renderEvidenceTab();
      renderFooter();
      paint();
    });
  };
  // Widths and relative times are set here instead of inline styles (CSP: style-src 'self').
  const paint = () => {
    for (const el of document.querySelectorAll('.bar-fill[data-w]')) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`;
    const now = Date.now() / 1000;
    for (const el of document.querySelectorAll('[data-ago-sec]')) {
      const t = Number(el.dataset.agoSec);
      el.textContent = `${el.dataset.prefix || ''}${dur(now - t)} ago`;
      el.title = new Date(t * 1000).toISOString();
    }
    for (const el of document.querySelectorAll('[data-until-sec]')) {
      const left = Number(el.dataset.untilSec) - now;
      el.textContent = left > 0 ? `expires in ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : 'expired';
    }
    paintSrcBadges();
  };
  setInterval(() => { paint(); renderHeader(); }, 1000);

  // ---------------------------------------------------------------- tabs

  const TABS = ['overview', 'agent', 'hedges', 'evidence'];
  const currentTab = () => TABS.find((t) => !$(`#tab-${t}`).hidden) || 'overview';
  const showTab = (name, focus) => {
    if (!TABS.includes(name)) name = 'overview';
    for (const t of TABS) {
      const btn = $(`#tab-btn-${t}`);
      const on = t === name;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      $(`#tab-${t}`).hidden = !on;
      if (on && focus) btn.focus();
    }
    if (name !== 'overview' && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    if (name === 'overview' && location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (name === 'evidence') fetchEvidenceTx();
    if (name === 'hedges') fetchOtherRegimes();
    render();
  };
  const initTabs = () => {
    const list = $('.tabs');
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[role="tab"]');
      if (b) showTab(b.id.replace('tab-btn-', ''));
    });
    list.addEventListener('keydown', (e) => {
      const i = TABS.indexOf(currentTab());
      let n = null;
      if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
      if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
      if (e.key === 'Home') n = 0;
      if (e.key === 'End') n = TABS.length - 1;
      if (n !== null) { e.preventDefault(); showTab(TABS[n], true); }
    });
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a.link-tab');
      if (a) { e.preventDefault(); showTab(a.dataset.tab, true); }
    });
    showTab(location.hash.slice(1) || 'overview');
  };

  // ---------------------------------------------------------------- theme and mode

  const initControls = () => {
    const stored = (() => { try { return localStorage.getItem('tg.theme'); } catch { return null; } })();
    const q = params.get('theme');
    const theme = q === 'dark' || q === 'light' ? q : stored || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const apply = (t) => {
      document.documentElement.dataset.theme = t;
      const b = $('#theme-toggle');
      b.setAttribute('aria-pressed', String(t === 'dark'));
      b.textContent = t === 'dark' ? 'Light theme' : 'Dark theme';
    };
    apply(theme);
    $('#theme-toggle').addEventListener('click', () => {
      const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      apply(t);
      try { localStorage.setItem('tg.theme', t); } catch { /* storage unavailable */ }
    });

  };

  // ---------------------------------------------------------------- caches

  const cache = {
    get: () => null,
    set: () => {}
  };
  const reviveIntent = (o) => ({ ...o, vaultId: BigInt(o.vaultId), maxSats: BigInt(o.maxSats), maxBps: BigInt(o.maxBps), minOut: BigInt(o.minOut), maxOut: BigInt(o.maxOut), expiry: BigInt(o.expiry), price: BigInt(o.price), priceSignedAt: BigInt(o.priceSignedAt) });
  const reviveConfig = (o) => { const r = { ...o }; for (const k of ['dailyBudgetUsd', 'maxSignatureAge', 'maxDataAge', 'maxPostAge', 'cooldown', 'intentTtl', 'breakerBps', 'reentryBps', 'breakerHedgeBps', 'eventHedgeBps', 'slippageBps']) r[k] = BigInt(o[k]); return r; };
  const CACHE_NS = `tg.${EV.base.contract.toLowerCase()}`;

  // ---------------------------------------------------------------- data loading

  const update = (key) => (r) => {
    const s = S[key];
    if (r.ok) { s.status = 'live'; s.okAt = r.at; s.error = null; s.retryInMs = 0; }
    else { s.status = 'error'; s.error = r.error; s.retryInMs = r.retryInMs; }
    render();
  };

  const loadHealth = async () => {
    const v = await watcher.health();
    if (!v || typeof v !== 'object') throw new Error('unexpected /health answer');
    S.health.value = v;
    return v;
  };

  const loadDecisions = async () => {
    const v = await watcher.decisions();
    if (!Array.isArray(v)) throw new Error('unexpected /decisions answer');
    const rows = v.filter((d) => d && typeof d === 'object' && typeof d.at === 'string' && Number.isInteger(d.status));
    S.newDecisions.clear();
    for (const d of rows) {
      const k = decKey(d);
      if (!S.seenDecisions.has(k)) { S.seenDecisions.add(k); if (S.decisionsPrimed) S.newDecisions.add(k); }
    }
    S.decisionsPrimed = true;
    S.decisions.value = rows;
    if (S.newDecisions.size) setTimeout(() => { S.newDecisions.clear(); sigs.delete($('#decisions-card')); sigs.delete($('#flow')); render(); }, 2500);
    return rows;
  };

  const loadBase = async () => {
    if (S.chain.chainOk === null) {
      const id = await base.chainId();
      S.chain.chainOk = id === BigInt(EV.base.chainId);
    }
    if (!S.chain.chainOk) throw new Error(`RPC is not chain ${EV.base.chainId}`);
    const [block, count] = await Promise.all([base.blockNumber(), base.intentCount()]);
    S.chain.block = block;
    S.chain.count = count;
    for (let i = 1n; i <= count; i++) {
      const id = i.toString();
      const known = S.chain.intents.get(id);
      if (known && known.settled) continue;
      const cached = cache.get(`${CACHE_NS}.intent.${id}`);
      if (!known && cached) { S.chain.intents.set(id, reviveIntent(cached)); continue; }
      // Unsettled intents are re-read: settle can still change them. Expired unsettled ones change only via settle.
      const it = await base.getIntent(i);
      S.chain.intents.set(id, it);
      if (it.settled) cache.set(`${CACHE_NS}.intent.${id}`, it);
    }
    for (const [key, v] of [['v5', VAULT], ['v8', RUNNER]]) {
      const cfgKey = `${CACHE_NS}.config.${v}`;
      if (!S.chain[key].config) {
        const c = cache.get(cfgKey);
        S.chain[key].config = c ? reviveConfig(c) : await base.getVaultConfig(v);
        if (!c) cache.set(cfgKey, S.chain[key].config);
      }
      const [lp, rg, rem] = await Promise.all([base.lastPrice(v), base.regime(v), base.remainingUsdToday(v)]);
      Object.assign(S.chain[key], { lastPrice: lp, regime: rg, remaining: rem });
    }
    // A settled vault-5 intent: read its BSV transaction for the receipt and float output.
    for (const [id, i] of vaultIntents()) if (i.settled && !S.receipts.has(id)) readReceipt(i.bsvTxid.slice(2));
    return true;
  };

  const fetchOtherRegimes = async () => {
    if (S.chain.othersLoaded) return;
    S.chain.othersLoaded = true;
    try {
      for (const v of [6, 7]) S.chain.others[v] = await base.regime(BigInt(v));
    } catch { S.chain.othersLoaded = false; }
    render();
  };

  // Bounded log scan. First: the last ~30 min, newest page first, at most LOG_MAX_PAGES pages of 200 blocks.
  // Then: forward from the last block read. After a long sleep it restarts from the window instead of catching up.
  const mergeLogs = (logs) => {
    for (const l of logs) {
      const key = `${l.txHash}|${l.type}|${l.type === 'intent' ? l.intentId : l.vaultId}`;
      if (S.logData.keys.has(key)) continue;
      S.logData.keys.add(key);
      if (l.type === 'intent') {
        S.logData.intentTx.set(l.intentId.toString(), { txHash: l.txHash, block: l.blockNumber });
        S.logData.intents.push(l);
      } else S.logData.prices.push(l);
    }
    const byBlock = (a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0);
    S.logData.prices.sort(byBlock);
    S.logData.intents.sort(byBlock);
  };
  const windowBlocks = async (head) => {
    if (!S.logData.blocksPerWindow) {
      const back = 5000n;
      const [t1, t0] = await Promise.all([base.blockTimestamp(head), base.blockTimestamp(head - back)]);
      const secs = t1 > t0 ? t1 - t0 : 1n;
      let n = (LOG_WINDOW_SEC * back) / secs;
      if (n > LOG_MAX_PAGES * 200n) n = LOG_MAX_PAGES * 200n;
      if (n < 200n) n = 200n;
      S.logData.blocksPerWindow = n;
      S.logData.secPerBlockMilli = (secs * 1000n) / back;
    }
    return S.logData.blocksPerWindow;
  };
  const loadLogs = async () => {
    if (!S.chain.block) throw new Error('waiting for the Base block number');
    const head = S.chain.block;
    const win = await windowBlocks(head);
    if (S.logData.to === null || head - S.logData.to > win) {
      // First scan (or after a long sleep): newest page first, so recent cycles show up at once.
      const floor = head - win + 1n;
      S.logData.to = head;
      S.logData.from = head + 1n;
      for (let end = head; end >= floor; end -= 200n) {
        const start = end - 199n > floor ? end - 199n : floor;
        mergeLogs(await base.contractLogs(start, end));
        S.logData.from = start;
        render();
      }
      return true;
    }
    if (head > S.logData.to) {
      mergeLogs(await base.contractLogs(S.logData.to + 1n, head));
      S.logData.to = head;
    }
    return true;
  };

  const loadVault = async () => {
    const r = await woc.scriptUnspent(WOC_SCRIPT_HASH);
    const list = Array.isArray(r?.result) ? r.result : Array.isArray(r) ? r : null;
    if (!list) throw new Error('unexpected WhatsOnChain answer');
    const utxos = list.filter((u) => TXID.test(u.tx_hash) && Number.isSafeInteger(u.value) && u.value >= 0);
    const total = utxos.filter((u) => !u.isSpentInMempoolTx).reduce((a, u) => a + BigInt(u.value), 0n);
    S.vault.value = { utxos, total };
    // A vault coin made by an unknown transaction: read its OP_RETURN receipt to link it to an intent.
    const known = new Set(S.receipts.values());
    for (const u of utxos) if (!known.has(u.tx_hash)) readReceipt(u.tx_hash);
    return true;
  };
  const receiptTried = new Set();
  const readReceipt = async (txid) => {
    if (receiptTried.has(txid)) return;
    receiptTried.add(txid);
    try {
      const tx = await woc.tx(txid);
      noteTx(txid, tx);
      const rc = C.findReceipt(tx);
      if (rc && rc.chainId === BigInt(EV.base.chainId) && rc.contract === EV.base.contract.toLowerCase() && rc.vaultId === VAULT) {
        const id = rc.intentId.toString();
        S.receipts.set(id, txid);
        // The float output, read from the transaction itself (WhatsOnChain gives BSV as a decimal; sats are integers).
        let toFloat = 0n;
        for (const o of tx.vout ?? []) {
          if (o?.scriptPubKey?.hex === EV.bsv.floatScript && Number.isFinite(o.value)) toFloat += BigInt(Math.round(o.value * 1e8));
        }
        if (toFloat > 0n) S.receiptOut.set(id, toFloat);
        render();
      }
    } catch { receiptTried.delete(txid); }
  };

  const noteTx = (txid, tx) => {
    const height = Number(tx?.blockheight);
    const conf = Number(tx?.confirmations);
    const mined = Number.isInteger(height) && height > 0 && Number.isFinite(conf) && conf >= 1;
    const entry = { state: mined ? 'mined' : 'unconfirmed', height: mined ? height : null, at: Date.now() };
    S.tx.set(txid, entry);
    if (mined) cache.set(`tg.tx.${txid}`, entry);
  };
  // Confirmation states are cached only until the next refresh, including mined transactions.
  const txQueue = new Set();
  const fetchTx = async (txid) => {
    if (!TXID.test(txid) || txQueue.has(txid)) return;
    const cached = cache.get(`tg.tx.${txid}`);
    if (cached && cached.state === 'mined' && Date.now() - cached.at < INTERVAL.tx) { S.tx.set(txid, cached); return; }
    const cur = S.tx.get(txid);
    if (cur && cur.state !== 'loading' && Date.now() - cur.at < INTERVAL.tx) return;
    txQueue.add(txid);
    if (!cur) S.tx.set(txid, { state: 'loading', at: Date.now() });
    try {
      noteTx(txid, await woc.tx(txid));
    } catch (e) {
      S.tx.set(txid, { state: e.status === 404 ? 'unknown' : 'error', at: Date.now(), error: String(e.message || e) });
    } finally {
      txQueue.delete(txid);
      render();
    }
  };
  const coreTxids = () => {
    const ids = [];
    for (const id of S.receipts.values()) ids.push(id);
    for (const [, i] of vaultIntents()) if (i.settled) ids.push(i.bsvTxid.slice(2));
    return [...new Set(ids)];
  };
  const fetchCoreTx = async () => { for (const id of coreTxids()) await fetchTx(id); };
  const fetchEvidenceTx = async () => {
    for (const r of evidenceRows()) if (r.txid) await fetchTx(r.txid);
  };

  // ---------------------------------------------------------------- start

  const start = () => {
    initControls();
    initTabs();
    render();
    C.poll(loadHealth, INTERVAL.health, update('health'));
    C.poll(loadDecisions, INTERVAL.decisions, update('decisions'));
    C.poll(loadBase, INTERVAL.base, update('base'));
    // Logs wait for the first block number, then follow it; started a little later to spread the first requests.
    setTimeout(() => C.poll(loadLogs, INTERVAL.logs, update('logs')), 3000);
    C.poll(loadVault, INTERVAL.vault, update('vault'));
    setTimeout(() => C.poll(fetchCoreTx, INTERVAL.tx, () => render()), 1500);
  };

  if (!EV || !C) {
    document.body.prepend(Object.assign(document.createElement('p'), { className: 'banner banner-warn', textContent: 'Dashboard files are missing (config.js or chain.js).' }));
    return;
  }
  start();
})();
