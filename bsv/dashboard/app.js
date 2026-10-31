// Treasury Guard dashboard. Reads: GET /health and GET /decisions on the watcher, eth_call / eth_getLogs /
// eth_getTransactionByHash on Base Sepolia, GET on WhatsOnChain. It never calls /cosign or /broadcast, never signs,
// never holds a key. The forgery check sends tampered copies of a real signed price to TreasuryGuard.checkPrice as a
// free eth_call (no transaction). The Owner view and "Run it live" ask the local owner action server to run the team's
// existing commands; BSV Desktop asks the owner to approve every owner transaction.
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
  const FEED = EV.base.feeds.bsvUsd;

  // Opened for a recording (?video=1 or ?fast=1): the chain reads come faster, so a live run fills in on screen.
  const FAST = params.get('video') === '1' || params.has('fast');
  const INTERVAL = FAST
    ? { health: 4000, decisions: 2000, base: 10000, logs: 12000, vault: 10000, tx: 12000, history: 30000 }
    : { health: 5000, decisions: 3000, base: 20000, logs: 30000, vault: 30000, tx: 60000, history: 60000 };
  const LOG_WINDOW_SEC = 7200n; // the API3 view shows the last two hours of accepted prices
  const LOG_MAX_PAGES = 60n;
  const LOG_FIRST_PAGES = 12n; // first load: the newest 12 pages of 200 blocks (~40 min) only
  const LOG_PAGE_GAP_MS = 700; // the public RPC rate-limits bursts

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
    history: src(INTERVAL.history),
    chain: { chainOk: null, block: null, count: null, intents: new Map(), v5: {}, v8: {}, others: {} },
    logData: { from: null, to: null, intentTx: new Map(), prices: [], intents: [], keys: new Set(), blocksPerWindow: null, secPerBlockMilli: null },
    tx: new Map(), // txid → { state, height, at, time, error }
    txJson: new Map(), // txid → WhatsOnChain transaction (mined ones are kept)
    receipts: new Map(), // intentId → txid, from the OP_RETURN receipt
    receiptOut: new Map(), // intentId → { sats, vout, payee }
    payments: new Map(), // intentId → { state, txid, sats, fee, at }
    hist: { ids: [], rows: [] }, // vault script history, classified
    vaultScript: null, // { hex, keys: { agent, watcher, owner }, hashOk }
    posts: new Map(), // handle → true | false (isPostRequest on vault 5)
    lab: { chain: null, pasted: null, mode: 'chain', error: null, pasteError: null, busy: false, results: new Map(), replay: null, runAt: 0, ranFor: null },
    selectedRun: null,
    basePolls: 0,
    seenDecisions: new Set(),
    newDecisions: new Set(),
    decisionsPrimed: false,
    video: { on: false, i: 0, captions: true }
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
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, ...children) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    for (const c of children.flat(Infinity)) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
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
  const price4 = (p) => '$' + fixed(p, 8, 4);
  const pct = (bpsHundredths) => {
    const v = BigInt(bpsHundredths);
    return (v > 0n ? '+' : '') + fixed(v, 2) + ' %';
  };
  // sats × price(8 dec) = USD × 1e16. Two significant digits, marked "≈".
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
  const short = (hex, head = 6, tail = 4) => {
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
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateTime = (ms) => new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
  const median = (xs) => {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return s[Math.floor((s.length - 1) / 2)];
  };

  // ---------------------------------------------------------------- links, small parts

  const TXID = /^[0-9a-f]{64}$/;
  const HASH = /^0x[0-9a-fA-F]{64}$/;
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const ext = (href, label, title) =>
    h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'mono', title: title || undefined }, label, h('span', { class: 'sr-only' }, ' (opens in a new tab)'));
  const wocTx = (txid) => (TXID.test(txid) ? ext(`${EV.bsv.explorer}/tx/${txid}`, short(txid), `${txid} on WhatsOnChain (BSV mainnet)`) : h('span', { class: 'mono' }, '—'));
  const baseTx = (hash) => (HASH.test(hash) ? ext(`${EV.base.explorer}/tx/${hash}`, short(hash), `${hash} on Basescan (Base Sepolia testnet)`) : h('span', { class: 'muted' }, 'not indexed'));
  const baseAddr = (a) => (ADDR.test(a) ? ext(`${EV.base.explorer}/address/${a}`, short(a), `${a} on Basescan`) : '—');
  const tag = (chain, text) => h('span', { class: `tag tag-${chain}` }, text);
  const pass = (ok, text) => h('span', { class: ok ? 'pass' : 'fail' }, text);
  const meter = (share, kind) => h('span', { class: `meter meter-${kind}`, role: 'img', 'aria-label': `${Math.round(share)} %` }, h('span', { class: 'bar-fill', dataset: { w: String(Math.max(0, Math.min(100, share))) } }));
  const tabLink = (tabName, label) => h('a', { href: `#${tabName}`, class: 'link-tab', dataset: { tab: tabName } }, label);
  const head = (id, title, ...right) => h('div', { class: 'card-head' }, h('h3', { id }, title), ...right);
  const agoSpan = (sec, prefix) => h('span', { dataset: prefix ? { agoSec: String(sec), prefix } : { agoSec: String(sec) } }, '');

  // ---------------------------------------------------------------- source badges

  const LABEL = { live: 'live', cached: 'cached', unavailable: 'unavailable', loading: 'loading' };
  const freshness = (s) => {
    if (!s.okAt) return s.status === 'error' ? 'unavailable' : 'loading';
    // One failed poll right after a good one is not shown as stale: the public endpoints drop a request now and then.
    if (Date.now() - s.okAt > s.interval * 3 + 5000) return 'cached';
    return 'live';
  };
  // A badge bound to a source: its class and "x s ago" are refreshed every second by paint().
  const srcBadge = (key, name) => h('span', { class: 'src', dataset: { src: key, srcName: name } });
  const paintSrcBadges = () => {
    for (const el of document.querySelectorAll('[data-src]')) {
      const s = S[el.dataset.src];
      if (!s) continue;
      const kind = freshness(s);
      el.className = `src src-${kind}`;
      const name = el.dataset.srcName;
      if (kind === 'live') el.textContent = `${dur((Date.now() - s.okAt) / 1000)} ago`;
      else if (kind === 'cached') el.textContent = `read ${dur((Date.now() - s.okAt) / 1000)} ago`;
      else if (kind === 'unavailable') el.textContent = 'unavailable';
      else el.textContent = 'loading';
      el.title = `Source: ${name}${s.error && kind !== 'live' ? `. Last error: ${s.error.message || s.error}` : ''}`;
    }
  };

  const txState = (txid) => {
    const t = S.tx.get(txid);
    if (!t || t.state === 'loading') return h('span', { class: 'tx-state' }, 'checking…');
    if (t.state === 'mined') return h('span', { class: 'tx-state', title: `Mined in block ${t.height} (WhatsOnChain)` }, `mined · block ${group(t.height)}`);
    if (t.state === 'unconfirmed') return h('span', { class: 'tx-state' }, 'broadcast · waiting for a block');
    if (t.state === 'unknown') return h('span', { class: 'tx-state bad' }, 'not found on WhatsOnChain');
    return h('span', { class: 'tx-state', title: t.error || '' }, 'WhatsOnChain unavailable');
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
  const histByTxid = () => new Map(S.hist.rows.map((r) => [r.txid, r]));

  // The newest signed price the contract holds, across the team vault and the API3 runner.
  const latestPrice = () => {
    const a = S.chain.v5.lastPrice;
    const b = S.chain.v8.lastPrice;
    const ok = (p) => p && p.signedAt > 0n;
    if (ok(a) && ok(b)) return a.signedAt >= b.signedAt ? a : b;
    return ok(a) ? a : ok(b) ? b : null;
  };
  const priceForUsd = () => latestPrice()?.price ?? null;

  // One row per vault-5 SPEND intent. On-chain intents, live approvals and OP_RETURN receipts are merged by intentId.
  const pipelineRows = () => {
    const ids = new Set();
    for (const [id, i] of vaultIntents()) if (i.kind === 'SPEND') ids.add(id);
    for (const d of liveDecisions()) if (d.status === 200 && d.verdict === 'APPROVE' && /^\d+$/.test(String(d.intentId))) ids.add(String(d.intentId));
    for (const id of S.receipts.keys()) ids.add(id);
    const now = nowSec();
    const hist = histByTxid();
    return [...ids].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)).map((id) => {
      const chain = S.chain.intents.get(id);
      const onChain = chain && chain.vaultId === VAULT ? chain : null;
      const dec = latestApproval(id);
      const logTx = S.logData.intentTx.get(id);
      const settleRecord = onChain && onChain.settled ? onChain.bsvTxid.slice(2).toLowerCase() : null;
      const receipt = S.receipts.get(id) || null;
      const txid = receipt || settleRecord || null;
      const mismatch = receipt && settleRecord && receipt !== settleRecord;
      const approval = dec ? { toFloat: dec.toFloat, fee: dec.fee, vaultIn: dec.vaultIn, change: dec.change } : null;
      const h0 = txid ? hist.get(txid) : null;
      const fee = approval ? BigInt(approval.fee ?? 0) : h0?.fee ?? null;
      const toAgent = r0(S.receiptOut.get(id)?.sats ?? (approval ? BigInt(approval.toFloat ?? 0) : null));
      const outflow = toAgent !== null && fee !== null ? toAgent + fee : null;
      const maxSats = onChain ? onChain.maxSats : null;
      let state;
      if (receipt) state = 'withdrawn';
      else if (settleRecord) state = 'reported';
      else if (approval) state = 'cosigned';
      else if (onChain && now < onChain.expiry) state = 'open';
      else if (onChain) state = 'expired';
      else state = 'unknown';
      return {
        id, onChain, approval, txid, mismatch, maxSats, state, fee, toAgent, outflow,
        baseCreatedTx: logTx?.txHash || null,
        settled: onChain ? onChain.settled : false,
        payment: S.payments.get(id) ?? null,
        chainOut: S.receiptOut.get(id) ?? null
      };
    });
  };
  const r0 = (x) => (x === undefined ? null : x);

  // ---------------------------------------------------------------- render: header

  const renderHeader = () => {
    const pill = $('#watcher-pill');
    const s = S.health;
    const k = freshness(s);
    const hv = s.value;
    let cls, text, title = '';
    if (k === 'live' && hv?.ok) {
      cls = 'pill-ok';
      text = 'Watcher online';
      title = `Binding: ${hv.binding}. Started ${hv.startedAt}. ${hv.decisions} decisions since start.`;
    } else if (k === 'loading') { cls = 'pill-loading'; text = 'Watcher: checking…'; }
    else {
      cls = 'pill-bad';
      text = s.okAt ? `Watcher offline · last seen ${clock(s.okAt)}` : 'Watcher offline';
      title = `${CFG.watcher}: ${s.error?.message || 'no answer'}`;
    }
    pill.className = `pill ${cls}`;
    pill.title = title;
    $('.pill-text', pill).textContent = text;

    const op = $('#owner-pill');
    const os = S.owner?.state;
    const [ocls, otext] = os === 'ready' ? ['pill-ok', 'Owner server ready']
      : os === 'no-token' ? ['pill-off', 'Owner actions not connected']
        : os === 'checking' ? ['pill-loading', 'Owner server: checking…']
          : ['pill-bad', os === 'mainnet-off' ? 'Owner server: mainnet off' : 'Owner server offline'];
    op.className = `pill ${ocls}`;
    $('.pill-text', op).textContent = otext;

    const warn = [];
    if (hv) {
      if (hv.base?.contract && hv.base.contract.toLowerCase() !== EV.base.contract.toLowerCase()) warn.push(`Watcher is bound to contract ${hv.base.contract}, not ${EV.base.contract}.`);
      if (hv.base?.vaultId && hv.base.vaultId !== String(EV.base.vaultId)) warn.push(`Watcher is bound to vault ${hv.base.vaultId}, not vault ${EV.base.vaultId}.`);
      if (hv.bsvNetwork && hv.bsvNetwork !== 'main') warn.push(`Watcher reports BSV network “${hv.bsvNetwork}”.`);
      if (hv.vaultScriptSha256 && hv.vaultScriptSha256 !== EV.bsv.vaultScriptSha256) warn.push('Watcher reports a different vault script than the configured binding.');
    }
    if (S.chain.chainOk === false) warn.push(`The Base RPC ${CFG.rpc} does not serve chain ${EV.base.chainId}; Base panels are disabled.`);
    const banner = $('#banner');
    mount(banner, stringify(warn), () => warn.map((m) => h('p', { class: 'banner-line' }, m)));
    banner.hidden = warn.length === 0;
  };

  // ---------------------------------------------------------------- render: overview lanes

  const stat = (label, value, unit, note) => h('div', { class: 'stat' },
    h('p', { class: 'stat-label' }, label),
    h('p', { class: 'stat-value' }, value, unit ? h('span', { class: 'unit' }, unit) : null),
    note ? h('p', { class: 'stat-note' }, note) : null);

  // Where the money is: owner deposits → the vault → the agent → paid for data, with the API3 limit as the gate.
  const renderLanes = (rows) => {
    const v = S.vault.value;
    const price = priceForUsd();
    const funds = S.hist.rows.filter((r) => r.kind === 'fund');
    const exits = S.hist.rows.filter((r) => r.kind === 'exit');
    const funded = funds.reduce((a, r) => a + (r.vaultOut ?? 0n), 0n);
    const back = exits.reduce((a, r) => a + (r.out ?? 0n), 0n);
    const observed = rows.filter((r) => r.chainOut !== null);
    const paid = observed.reduce((sum, r) => sum + r.chainOut.sats, 0n);
    const spent = observed.filter((r) => r.payment?.state === 'spent' && r.payment.sats !== null);
    const spentSats = spent.reduce((sum, r) => sum + r.payment.sats, 0n);
    const lp = latestPrice();
    const cfg = S.chain.v5.config;
    const rem = S.chain.v5.remaining;
    const sig = stringify([v?.total, price, funded, funds.length, back, paid, observed.length, spentSats, spent.length, lp, rem, cfg?.dailyBudgetUsd, S.chain.v5.regime]);
    mount($('#lanes'), sig, () => {
      const node = (cls, label, value, caption, extra) => h('div', { class: `mf ${cls}` },
        h('p', { class: 'mf-label' }, label),
        h('p', { class: 'mf-value' }, value ?? '—', value ? h('span', { class: 'unit' }, ' sats') : null),
        h('p', { class: 'mf-cap' }, caption), extra || null);
      const arrow = (gate) => h('div', { class: `mf-arrow${gate ? ' mf-gate' : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'mf-line' }), gate ? h('span', { class: 'mf-gate-chip' }, gate) : null);
      return [
        head('money-title', 'Where the money is', srcBadge('history', 'WhatsOnChain + Base')),
        h('div', { class: 'mflow' },
          node('mf-owner', 'Owner put in', funds.length ? group(funded) : null, funds.length ? `${funds.length} deposits${back ? ` · ${group(back)} taken back` : ''}` : 'reading BSV…'),
          arrow(),
          node('mf-vault', 'In the vault now', v ? group(v.total) : null, v && price ? `${approxUsd(v.total, price)} · agent + watcher, or the owner alone` : 'agent + watcher, or the owner alone'),
          arrow('only inside an API3 limit'),
          node('mf-agent', 'Paid to the agent', observed.length ? group(paid) : null, observed.length ? `${observed.length} withdrawals, each within its limit` : 'reading BSV…'),
          arrow(),
          node('mf-data', 'Spent on data', spent.length ? group(spentSats) : null, spent.length ? `${spent.length} payments over HTTP 402` : 'reading BSV…')),
        h('div', { class: 'gate-strip' },
          tag('api3', 'API3 · Base'),
          h('span', null, 'Daily budget ', h('strong', null, rem !== undefined && cfg ? `${usd6(rem)} of ${usd6(cfg.dailyBudgetUsd)}` : '—'), ' left'),
          h('span', null, 'BSV/USD ', h('strong', null, lp ? price4(lp.price) : '—'), lp ? [' · signed ', agoSpan(lp.signedAt)] : null),
          h('span', null, 'Market ', h('strong', null, S.chain.v5.regime ? String(S.chain.v5.regime).replace('_', ' ') : '—'), lp ? ` · 1 h ${pct(lp.change1h)}` : null))
      ];
    });
  };

  // ---------------------------------------------------------------- render: live run timeline
  // One vault-5 SPEND intent told as steps, from data already polled: Base (price, intent, settle), the watcher's
  // decisions, WhatsOnChain (withdrawal, the float output's next spend). Nothing is inferred beyond the sources.

  const decisionsFor = (id) => liveDecisions().filter((d) => String(d.intentId) === id);
  const runModel = (r) => {
    const cfg = S.chain.v5.config;
    const it = r.onChain;
    const now = Number(nowSec());
    const createdAt = it && cfg ? Number(it.expiry - cfg.intentTtl) : null;
    const open = it ? BigInt(now) < it.expiry : false;
    const decs = decisionsFor(r.id);
    const approve = decs.find((d) => d.status === 200 && d.verdict === 'APPROVE') || null;
    const refusal = !approve && decs.length ? decs[decs.length - 1] : null;
    const tx = r.txid ? S.tx.get(r.txid) : null;
    const pay = r.payment;
    const payTx = pay?.txid ? S.tx.get(pay.txid) : null;
    const earlier = r.chainOut?.payee === 'earlier';
    const steps = [];
    const add = (key, chain, label, title, state, time, detail, extra) => steps.push({ key, chain, label, title, state, time, detail, extra });

    add('price', 'api3', 'API3', 'Signed price received', it ? 'done' : 'todo', it ? Number(it.priceSignedAt) : null,
      it ? `${price4(it.price)} per BSV · CoinPaprika Airnode` : 'Waiting for a signed price');
    add('limit', 'base', 'Base', 'Spending limit set on chain', it ? 'done' : 'todo', createdAt,
      it ? `max ${group(it.maxSats)} sats (${approxUsd(it.maxSats, it.price).replace('≈ ', '≈')})` : 'Waiting for a SPEND intent',
      it && open && !r.txid ? { until: Number(it.expiry) } : null);

    if (approve) add('watcher', 'watcher', 'Watcher', 'Watcher checked and co-signed', 'done', Date.parse(approve.at) / 1000,
      `${group(approve.toFloat ?? 0)} + ${group(approve.fee ?? 0)} fee ≤ ${group(r.maxSats ?? 0)} sats`);
    else if (refusal) add('watcher', 'watcher', 'Watcher', 'Watcher refused', 'failed', Date.parse(refusal.at) / 1000,
      Array.isArray(refusal.reasons) && refusal.reasons.length ? String(refusal.reasons[0]) : `HTTP ${refusal.status}`);
    else if (r.txid) add('watcher', 'watcher', 'Watcher', 'Watcher checked and co-signed', 'done', null, 'co-signed');
    else if (it && open) add('watcher', 'watcher', 'Watcher', 'Watcher checks the transaction', 'todo', null, 'Waiting for the agent to propose a withdrawal');
    else if (it) add('watcher', 'watcher', 'Watcher', 'No withdrawal', 'failed', Number(it.expiry), 'The limit expired before a withdrawal was signed');
    else add('watcher', 'watcher', 'Watcher', 'Watcher checks the transaction', 'todo', null, '');

    const payee = r.chainOut ? (earlier ? `${group(r.chainOut.sats)} sats to the earlier agent wallet` : `${group(r.chainOut.sats)} sats to the agent`) : null;
    const feeTxt = r.fee !== null && r.fee !== undefined ? `fee ${group(r.fee)} sats` : null;
    if (r.txid && tx?.state === 'mined') add('vault', 'bsv', 'BSV', 'Money left the vault', 'done', tx.time ?? null, [payee, feeTxt].filter(Boolean).join(' · '), { txid: r.txid, mined: true });
    else if (r.txid && tx?.state === 'unconfirmed') add('vault', 'bsv', 'BSV', 'Money left the vault', 'done', null, [payee, feeTxt, '0-conf'].filter(Boolean).join(' · '), { txid: r.txid });
    else if (r.txid) add('vault', 'bsv', 'BSV', 'Money leaving the vault', 'current', null, 'Checking BSV…', { txid: r.txid });
    else if (approve) add('vault', 'bsv', 'BSV', 'Money leaving the vault', 'current', null, 'Waiting for the transaction to appear on BSV');
    else add('vault', 'bsv', 'BSV', 'Money leaves the vault', 'todo', null, '');

    const job = S.owner?.job;
    const buyMsg = job && job.kind === 'cycle' && String(job.intentId) === r.id ? job.steps?.find((x) => x.key === 'buy' && x.message && x.state !== 'running')?.message : null;
    const outcome = pay?.txid ? (EV.bsv.paymentOutcomes || {})[pay.txid] : null;
    const outcomeTxt = outcome ? (outcome.http === 200 ? 'HTTP 200' : `HTTP ${outcome.http} · no data`) : null;
    if (pay?.state === 'spent') add('pay', 'bsv', 'BSV · HTTP 402', outcome && outcome.http !== 200 ? 'Agent paid, no data returned' : outcome ? 'Agent paid for data' : 'Agent paid over HTTP 402', 'done', payTx?.state === 'mined' ? payTx.time ?? null : null,
      [buyMsg, pay.sats !== null ? `${group(pay.sats)} sats${pay.fee !== null && pay.fee !== undefined ? ` · fee ${group(pay.fee)}` : ''}` : 'amount not derivable', outcomeTxt].filter(Boolean).join(' · '), { txid: pay.txid, mined: payTx?.state === 'mined', tip: outcome ? `${outcome.merchant}; HTTP status from the agent’s log` : undefined });
    else if (earlier && pay?.state === 'unspent') add('pay', 'bsv', 'BSV · HTTP 402', 'Agent pays for data', 'skipped', null, 'This run paid the earlier agent wallet; no payment came from that output');
    else if (r.txid && pay?.state === 'unspent') add('pay', 'bsv', 'BSV · HTTP 402', 'Agent pays for data', 'current', null, 'Waiting for the agent’s model to decide and pay');
    else if (r.txid) add('pay', 'bsv', 'BSV · HTTP 402', 'Agent pays for data', 'current', null, pay?.state === 'error' ? 'WhatsOnChain unavailable, retrying' : 'Checking the float output…');
    else add('pay', 'bsv', 'BSV · HTTP 402', 'Agent pays for data', 'todo', null, '');

    if (it?.settled) add('settle', 'base', 'Base', 'Recorded on Base', 'done', null, `intent ${r.id} closed with the BSV txid`, { tip: 'Written by the agent: a record, not a cross-chain proof' });
    else if (r.txid) add('settle', 'base', 'Base', 'Recorded on Base', 'current', null, 'Waiting for the agent to record it');
    else add('settle', 'base', 'Base', 'Recorded on Base', 'todo', null, '');

    let seenCurrent = false;
    for (const s of steps) if (s.state === 'current') { if (seenCurrent) s.state = 'todo'; seenCurrent = true; }
    const failed = steps.some((s) => s.state === 'failed');
    const complete = !failed && steps.every((s) => s.state === 'done' || s.state === 'skipped');
    const status = failed ? 'stopped' : complete ? 'complete' : 'running';
    const times = steps.map((s) => s.time).filter((t) => Number.isFinite(t));
    const end = status === 'running' ? null : (times.length ? Math.max(...times) : null);
    const summary = status === 'stopped' ? (refusal ? 'refused' : 'expired')
      : pay?.state === 'spent' && pay.sats !== null ? `paid ${group(pay.sats)} sats${(EV.bsv.paymentOutcomes || {})[pay.txid]?.http && (EV.bsv.paymentOutcomes || {})[pay.txid].http !== 200 ? ' · no data' : ''}`
        : r.chainOut ? `${group(r.chainOut.sats)} to the agent` : 'in progress';
    return { id: r.id, steps, status, start: createdAt, end, outflow: r.outflow, toAgent: r.toAgent, maxSats: r.maxSats, summary };
  };

  const STEP_MARK = { done: '✓', failed: '✕', current: '', todo: '', skipped: '–' };
  // One payment as six nodes, left to right, with the amount that moved at each step. States come from runModel.
  const renderRun = (rows) => {
    const runs = rows.map(runModel);
    const el = $('#run');
    if (S.selectedRun && !runs.some((x) => x.id === S.selectedRun)) S.selectedRun = null;
    const sel = runs.find((x) => x.id === S.selectedRun) || runs[0] || null;
    const r = sel ? rows.find((x) => x.id === sel.id) : null;
    const watching = freshness(S.health) === 'live';
    const sig = stringify([runs.map((x) => [x.id, x.status, x.summary]), sel, r && [r.toAgent, r.fee, r.payment, r.txid], watching]);
    mount(el, sig, () => {
      if (!sel || !r) return [head('run-title', 'Latest payment'), h('p', { class: 'state' }, S.base.status === 'error' ? 'Base Sepolia not reachable. Retrying.' : 'Reading the latest payment…')];
      const it = r.onChain;
      const st = Object.fromEntries(sel.steps.map((x) => [x.key, x]));
      const usdMicro = it ? (it.maxSats * it.price + 5_000_000_000n) / 10_000_000_000n : null;
      const outcome = r.payment?.txid ? (EV.bsv.paymentOutcomes || {})[r.payment.txid] : null;
      const used = r.outflow ?? r.toAgent;
      const share = used !== null && used !== undefined && r.maxSats ? Number((used * 1000n) / r.maxSats) / 10 : null;
      const t = (x, prefix) => (x && Number.isFinite(x.time) ? `${x.extra?.mined ? 'mined' : prefix} ${clock(x.time * 1000)}` : '');
      const nodes = [
        ['price', 'api3', 'API3', 'Signed price', it ? price4(it.price) : '—', 'per BSV, signed by the CoinPaprika Airnode', null, t(st.price, 'signed')],
        ['limit', 'base', 'Base', 'Spending limit', it ? `${group(it.maxSats)} sats` : '—', it ? `${usd6(usdMicro)} at that price` : 'waiting for a limit', null, t(st.limit, 'set')],
        ['watcher', 'watcher', 'Watcher', st.watcher?.state === 'failed' ? 'Watcher refused' : 'Watcher check', st.watcher?.state === 'failed' ? 'refused' : used !== null && used !== undefined && r.maxSats ? `${group(used)} ≤ ${group(r.maxSats)}` : '—', st.watcher?.state === 'failed' ? st.watcher.detail : r.fee !== null && r.fee !== undefined ? `${group(r.toAgent ?? 0n)} + ${group(r.fee)} fee fits the limit` : 'co-signs only inside the limit', null, t(st.watcher, 'co-signed')],
        ['vault', 'bsv', 'BSV', 'Vault → agent', r.toAgent !== null && r.toAgent !== undefined ? `${group(r.toAgent)} sats` : '—', 'agent + watcher signatures', r.txid ? wocTx(r.txid) : null, t(st.vault, 'sent')],
        ['pay', 'bsv', 'HTTP 402', 'Agent → data API', r.payment?.state === 'spent' && r.payment.sats !== null ? `${group(r.payment.sats)} sats` : '—', outcome ? (outcome.http === 200 ? 'paid · data returned' : `paid · HTTP ${outcome.http}, no data`) : r.payment?.state === 'spent' ? 'paid over HTTP 402' : 'the agent’s model decides', r.payment?.txid ? wocTx(r.payment.txid) : null, t(st.pay, 'paid')],
        ['settle', 'base', 'Base', 'Recorded', it?.settled ? 'settled' : '—', 'BSV txid written to the intent', null, '']
      ];
      const chips = h('div', { class: 'run-chips', role: 'tablist', 'aria-label': 'Payments' }, runs.slice(0, 7).map((x) =>
        h('button', { type: 'button', class: `run-chip run-chip-${x.status}`, 'aria-pressed': x === sel ? 'true' : 'false', dataset: { run: x.id }, title: x.summary }, `#${x.id}`)));
      return [
        h('div', { class: 'card-head' },
          h('h3', { id: 'run-title' }, sel === runs[0] ? (sel.status === 'running' ? 'Happening now' : 'Latest payment') : 'Payment', h('span', { class: 'muted' }, ` · intent ${sel.id}`),
            h('span', { class: `run-status run-status-${sel.status}` }, sel.status === 'running' ? 'in progress' : sel.status === 'complete' ? 'complete' : 'stopped')),
          chips),
        h('ol', { class: 'pflow' }, nodes.map(([key, chain, label, title, value, caption, link, time], i) => {
          const state = st[key]?.state || 'todo';
          return h('li', { class: `pn pn-${chain} pn-${state}`, dataset: { i: String(i) } },
            h('div', { class: 'pn-top' }, h('span', { class: 'pn-dot', 'aria-hidden': 'true' }, state === 'done' ? '✓' : STEP_MARK[state] || String(i + 1)), tag(chain, label)),
            h('p', { class: 'pn-title' }, title),
            h('p', { class: 'pn-value' }, value),
            h('p', { class: 'pn-cap', title: key === 'settle' ? 'Written by the agent: a record, not a cross-chain proof' : undefined }, caption),
            link ? h('p', { class: 'pn-link' }, link) : null,
            time ? h('p', { class: 'pn-time' }, time) : null);
        })),
        share !== null ? h('div', { class: 'pay-limit' },
          h('p', null, h('strong', null, `${group(used)} of ${group(r.maxSats)} sats`), ` of the limit left the vault${r.outflow !== null ? ', fee included' : ''} · `, h('strong', null, `${share.toFixed(1)} %`)),
          meter(share, share <= 100 ? 'bsv' : 'bad')) : null,
        sel === runs[0] && sel.status !== 'running' ? h('p', { class: 'run-waiting' }, h('span', { class: `breath${watching ? '' : ' breath-off'}`, 'aria-hidden': 'true' }), watching ? 'Watcher online · waiting for the next request' : 'Watcher offline · showing the chain record') : null
      ];
    });
  };

  // ---------------------------------------------------------------- render: guarantees

  const renderGuarantees = (rows) => {
    const lab = labSummary();
    const within = rows.filter((r) => r.state === 'withdrawn' && r.maxSats && (r.outflow ?? r.toAgent) !== null);
    const okCount = within.filter((r) => (r.outflow ?? r.toAgent) <= r.maxSats).length;
    const maxShare = within.length ? Math.max(...within.map((r) => Number(((r.outflow ?? r.toAgent) * 1000n) / r.maxSats) / 10)) : null;
    const feesKnown = within.every((r) => r.outflow !== null);
    const exits = S.hist.rows.filter((x) => x.kind === 'exit');
    const lastExit = exits[0] || null;
    const refusals = liveDecisions().filter((d) => d.status !== 200);
    const sig = stringify([lab, within.length, okCount, maxShare, feesKnown, lastExit, refusals.length, S.history.status]);
    mount($('#guarantees'), sig, () => {
      const item = (proven, chain, chainLabel, title, proof) => h('li', { class: `guarantee${proven ? ' is-proven' : ''}` },
        h('span', { class: 'g-mark', 'aria-hidden': 'true' }, proven ? '✓' : '·'),
        h('div', null, h('p', { class: 'g-title' }, title, tag(chain, chainLabel)), h('p', { class: 'g-proof' }, proof)));
      return [
        head('guarantees-title', 'Live proof'),
        h('ul', { class: 'guarantees' },
          item(lab.done && lab.rejected === lab.total, 'api3', 'API3', 'Forged prices refused',
            lab.done ? [`${lab.validOk ? '1 valid · ' : ''}${lab.rejected} of ${lab.total} tampered copies rejected · `, tabLink('api3', 'tamper test')]
              : lab.error ? `Could not run the check: ${lab.error}` : 'Checking against the live contract…'),
          item(within.length > 0 && okCount === within.length, 'bsv', 'BSV', 'Withdrawals inside the limit',
            within.length ? `${okCount} of ${within.length} within their limit · max ${maxShare.toFixed(1)} %` : 'Reading withdrawals…'),
          item(!!lastExit, 'bsv', 'BSV', 'Owner exits alone',
            lastExit ? [wocTx(lastExit.txid), ` · ${group(lastExit.out)} sats back, owner key only`]
              : S.history.status === 'error' ? 'Vault history unavailable (WhatsOnChain).' : 'Reading the vault history…'),
          item(refusals.length > 0, 'watcher', 'Watcher', 'No second spend of a limit',
            refusals.length ? `HTTP ${refusals[refusals.length - 1].status} on a replay of intent ${refusals[refusals.length - 1].intentId}`
              : 'A second request for an intent gets HTTP 409'))
      ];
    });
  };

  // ---------------------------------------------------------------- render: watcher decisions

  const STATUS = {
    200: ['ok', 'Approved'],
    409: ['bad', 'Refused · already used'],
    422: ['bad', 'Refused · policy'],
    403: ['bad', 'Refused · bad agent signature'],
    400: ['neutral', 'Malformed request']
  };
  const decisionRow = (d, isNew) => {
    const [cls, label] = STATUS[d.status] || ['neutral', `HTTP ${d.status}`];
    const at = Date.parse(d.at);
    const reasons = Array.isArray(d.reasons) ? d.reasons.map(String) : [];
    return h('li', { class: `dec${isNew ? ' is-new' : ''}` },
      h('div', { class: 'dec-top' },
        h('time', { datetime: d.at, title: d.at }, Number.isFinite(at) ? clock(at) : '—'),
        h('span', { class: 'dec-intent' }, `intent ${String(d.intentId)}`),
        h('span', { class: `status status-${cls}` }, `${d.status} ${label}`)),
      d.status === 200 && d.verdict === 'APPROVE'
        ? h('p', { class: 'dec-detail' }, `${group(d.toFloat ?? 0)} to the agent · ${group(d.change ?? 0)} back · ${group(d.fee ?? 0)} fee`)
        : null,
      reasons.length === 1 ? h('p', { class: 'dec-reason' }, reasons[0]) : null,
      reasons.length > 1 ? h('details', { class: 'dec-reasons', dataset: { key: decKey(d) } },
        h('summary', null, reasons[0], h('span', { class: 'muted' }, ` (+${reasons.length - 1} more)`)),
        h('ul', null, reasons.slice(1).map((r) => h('li', null, r)))) : null);
  };

  const renderDecisions = () => {
    const el = $('#decisions-card');
    const live = liveDecisions().slice().reverse();
    const reached = S.decisions.okAt > 0;
    const offline = !reached && S.decisions.status === 'error';
    const startedAt = S.health.value?.startedAt;
    const counts = live.reduce((a, d) => { a[d.status === 200 ? 'ok' : 'no']++; return a; }, { ok: 0, no: 0 });
    const cosigned = S.hist.rows.filter((x) => x.kind === 'withdraw');
    const sig = stringify([live, reached, offline, startedAt, [...S.newDecisions], cosigned.map((x) => [x.txid, x.intentId, x.height])]);
    mount(el, sig, () => {
      const out = [head('decisions-title', 'Watcher decisions', srcBadge('decisions', 'watcher'))];
      if (reached) out.push(h('p', { class: 'card-sum' }, `${counts.ok} approved · ${counts.no} refused`));
      if (live.length) out.push(h('ol', { class: 'dec-list', 'aria-live': 'polite', 'aria-relevant': 'additions' }, live.map((d) => decisionRow(d, S.newDecisions.has(decKey(d))))));
      else if (reached) out.push(h('p', { class: 'empty' }, 'No requests yet.'));
      else if (offline) {
        out.push(h('p', { class: 'card-sub' }, `The watcher is not reachable from this page (${CFG.watcher}). Its co-signatures are on chain: every vault withdrawal needs one.`));
        out.push(cosigned.length ? h('ul', { class: 'chain-proof' }, cosigned.slice(0, 5).map((x) => h('li', null,
          h('span', null, x.intentId ? `Intent ${x.intentId} · co-signed` : 'Co-signed withdrawal'), h('span', null, wocTx(x.txid), h('span', { class: 'muted' }, x.height ? ` · block ${group(x.height)}` : ' · unconfirmed')))))
          : h('p', { class: 'empty' }, 'Reading co-signed withdrawals from BSV…'));
      } else out.push(h('p', { class: 'empty' }, 'Contacting the watcher…'));
      return out;
    });
  };

  // ---------------------------------------------------------------- render: API3 · signed price, limit

  const renderPrice = () => {
    const el = $('#price-card');
    const src0 = S.lab.source;
    const cfg = S.chain.v5.config;
    const lp = latestPrice();
    if (!lp) {
      mount(el, stringify(['p-empty', S.base.status]), () => [head('price-title', 'Signed price', srcBadge('base', 'Base Sepolia')),
        h('p', { class: 'state' }, S.base.status === 'error' ? 'No price loaded. Check the Base RPC in Connection details; retries are automatic.' : 'Reading the signed price from Base Sepolia…')]);
      return;
    }
    const airOk = cfg && cfg.priceAirnode.toLowerCase() === FEED.airnode.toLowerCase();
    const reqOk = cfg && cfg.priceRequestHash.toLowerCase() === FEED.requestHash.toLowerCase();
    const s = src0 && src0.signedAt === lp.signedAt ? src0 : null;
    const sigAge = s?.blockTs !== undefined && s?.blockTs !== null ? Number(s.blockTs - s.signedAt) : null;
    const dataAge = Number(lp.signedAt - lp.updatedAt);
    const maxSig = cfg ? Number(cfg.maxSignatureAge) : 300;
    const maxData = cfg ? Number(cfg.maxDataAge) : 600;
    mount(el, stringify([lp, airOk, reqOk, s?.txHash, sigAge, maxSig, maxData, S.logData.prices.length, S.logData.from !== null]), () => [
      head('price-title', 'Signed price', srcBadge('base', 'Base Sepolia')),
      h('p', { class: 'big' }, h('span', { class: 'num' }, price8(lp.price)), h('span', { class: 'unit' }, 'per BSV'),
        h('span', { class: 'usd' }, `1 h ${pct(lp.change1h)} · signed `, agoSpan(lp.signedAt))),
      h('p', { class: 'chips' },
        h('span', { class: airOk ? 'pass' : 'fail', title: `Signer ${FEED.airnode}: the CoinPaprika Airnode the vault stores` }, 'Airnode signer'),
        h('span', { class: reqOk ? 'pass' : 'fail', title: `Request ${FEED.requestHash}: the BSV/USD request the vault stores` }, 'BSV/USD request'),
        sigAge !== null ? h('span', { class: sigAge <= maxSig ? 'pass' : 'fail', title: `Signature age when accepted: ${dur(sigAge)}, limit ${dur(maxSig)}` }, `used ${dur(sigAge)} after signing`) : null,
        h('span', { class: dataAge <= maxData ? 'pass' : 'fail', title: `Price observed ${dur(dataAge)} before signing, limit ${dur(maxData)}` }, `data ${dur(dataAge)} old`)),
      priceChart(),
      s ? h('p', { class: 'note' }, `Accepted by TreasuryGuard in `, baseTx(s.txHash), ` (vault ${s.vaultId}${s.vaultId === RUNNER ? ', the API3 runner' : ''}). The contract also refuses a replay of the same signing time.`) : null
    ]);
  };

  // Every signed price TreasuryGuard accepted in the blocks read (PriceVerified events), as a line over time.
  const priceChart = () => {
    const seen = new Set();
    const pts = S.logData.prices.filter((p) => (p.vaultId === VAULT || p.vaultId === RUNNER) && !seen.has(String(p.signedAt)) && seen.add(String(p.signedAt)))
      .map((p) => ({ t: Number(p.signedAt), v: Number(p.price) / 1e8, vault: p.vaultId, tx: p.txHash })).sort((a, b) => a.t - b.t);
    if (pts.length < 2) return h('p', { class: 'state chart-wait' }, S.logData.from === null ? 'Reading accepted prices…' : 'Reading earlier prices for the chart…');
    const W = 600, H = 150, L = 6, R = 64, T = 26, B = 24;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
    const pad = Math.max((hi - lo) * 0.35, hi * 0.0004);
    lo -= pad; hi += pad;
    const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const xy = pts.map((p) => [X(p.t), Y(p.v)]);
    let d = `M${xy[0][0]},${xy[0][1]}`;
    for (let i = 1; i < xy.length; i++) { const [x0, y0] = xy[i - 1], [x1, y1] = xy[i], mx = (x0 + x1) / 2; d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`; }
    const last = pts[pts.length - 1], [lx, ly] = xy[xy.length - 1];
    const hhmm = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return h('figure', { class: 'chart' },
      h('figcaption', { class: 'chart-cap' }, `Accepted on chain · last ${dur(t1 - t0)}`),
      sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `Signed BSV/USD prices from ${hhmm(t0)} to ${hhmm(t1)}, last ${price4(BigInt(Math.round(last.v * 1e8)))}` },
        sv('defs', null, sv('linearGradient', { id: 'pg', x1: 0, y1: 0, x2: 0, y2: 1 }, sv('stop', { offset: '0%', class: 'grad-api3-top' }), sv('stop', { offset: '100%', class: 'grad-api3-bottom' }))),
        sv('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, class: 'axis' }),
        sv('path', { d: `${d} L${lx},${H - B} L${xy[0][0]},${H - B} Z`, fill: 'url(#pg)' }),
        sv('path', { d, class: 'line-api3' }),
        pts.map((p, i) => sv('circle', { cx: xy[i][0], cy: xy[i][1], r: i === pts.length - 1 ? 5 : 3.5, class: i === pts.length - 1 ? 'pt pt-last' : 'pt' },
          sv('title', null, `${hhmm(p.t)} · $${p.v.toFixed(4)} per BSV · vault ${p.vault}`))),
        sv('text', { x: Math.min(lx + 10, W - 4), y: ly + 4, class: 'chart-val' }, `$${last.v.toFixed(4)}`),
        sv('text', { x: L, y: H - 6, class: 'chart-tick' }, hhmm(t0)),
        sv('text', { x: W - R, y: H - 6, class: 'chart-tick', 'text-anchor': 'end' }, hhmm(t1))));
  };

  // A thermostat-style ring: share in percent of the arc, a value and a caption in the middle.
  const ring = (share, value, caption) => {
    const R = 52, C = 2 * Math.PI * R, arc = 0.78; // 280° of the circle, opening at the bottom
    const on = Math.max(0, Math.min(100, share)) / 100 * arc * C;
    return h('div', { class: 'ring', role: 'img', 'aria-label': `${value} ${caption} (${Math.round(share)} %)` },
      sv('svg', { viewBox: '0 0 132 132', class: 'ring-svg' },
        sv('circle', { cx: 66, cy: 66, r: R, class: 'ring-track', 'stroke-dasharray': `${arc * C} ${C}`, transform: 'rotate(130 66 66)' }),
        sv('circle', { cx: 66, cy: 66, r: R, class: 'ring-on', 'stroke-dasharray': `${on} ${C}`, transform: 'rotate(130 66 66)' })),
      h('div', { class: 'ring-text' }, h('span', { class: 'ring-val' }, value), h('span', { class: 'ring-cap' }, caption)));
  };

  // The newest vault-5 SPEND intent explains the conversion: usdAmount = maxSats × price / 1e10, maxSats rounded down.
  const renderLimit = () => {
    const el = $('#limit-card');
    const v5 = S.chain.v5;
    const cfg = v5.config;
    const spends = vaultIntents().filter(([, i]) => i.kind === 'SPEND').sort(([a], [b]) => (BigInt(b) > BigInt(a) ? 1 : -1));
    const [id, it] = spends[0] || [];
    const usdMicro = it ? (it.maxSats * it.price + 5_000_000_000n) / 10_000_000_000n : null;
    const rem = v5.remaining;
    const daily = cfg?.dailyBudgetUsd;
    const share = daily && rem !== undefined && daily > 0n ? Number((rem * 1000n) / daily) / 10 : null;
    mount(el, stringify([id, it?.maxSats, it?.price, rem, daily, cfg?.intentTtl]), () => [
      head('limit-title', 'Dollars → sats limit', srcBadge('base', 'Base Sepolia')),
      it ? [
        h('div', { class: 'formula', role: 'img', 'aria-label': `${usd6(usdMicro)} divided by ${price4(it.price)} per BSV equals ${group(it.maxSats)} sats` },
          h('span', { class: 'f-val' }, usd6(usdMicro)), h('span', { class: 'f-op' }, '÷'), h('span', { class: 'f-val' }, price4(it.price)), h('span', { class: 'f-op' }, '='), h('span', { class: 'f-val f-res' }, group(it.maxSats), h('span', { class: 'unit muted small' }, ' sats')),
          h('span', { class: 'f-cap' }, 'requested spend'), h('span', { class: 'f-cap' }), h('span', { class: 'f-cap' }, 'signed BSV/USD'), h('span', { class: 'f-cap' }), h('span', { class: 'f-cap' }, `maxSats of intent ${id}`)),
        h('p', { class: 'card-sub' }, 'submitPrice computes maxSats on chain from the signed price and debits the dollar budget at once. The watcher will not co-sign a withdrawal above it, fee included.')
      ] : h('p', { class: 'state' }, 'Reading the latest SPEND intent…'),
      daily ? h('div', { class: 'budget-ring-row' },
        ring(share ?? 0, usd6(rem ?? 0n), 'left today'),
        h('div', null,
          h('p', { class: 'check-name' }, `Daily budget ${usd6(daily)}`, h('span', { class: 'block muted small' }, 'resets 00:00 UTC')),
          h('p', { class: 'note' }, `Each SPEND intent is debited when it is created and never refunded; a new price never resets the budget. It resets at 00:00 UTC. Intents expire after ${dur(cfg.intentTtl)}.`))) : null
    ]);
  };

  // ---------------------------------------------------------------- forgery check (API3)
  // Source: the newest submitPrice on chain (its calldata holds the signed response exactly as the agent sent it).
  // Each attack changes one thing and asks TreasuryGuard.checkPrice with a free eth_call. Nothing is sent or signed.

  const ATTACKS = [
    {
      key: 'price', title: 'Lower the price',
      what: 'Halve the price inside the signed data. A lower price would give the agent twice the sats for the same dollars.',
      make: (r) => {
        const m = /("price"\s*:\s*"?)(-?[0-9.eE+]+)/.exec(r.data);
        if (!m) return null;
        const half = String(Number(m[2]) / 2);
        const data = r.data.replace(m[0], m[1] + half);
        return { resp: { ...r, data, dataHex: undefined }, from: `$${Number(m[2]).toFixed(4)}`, to: `$${(Number(m[2]) / 2).toFixed(4)}` };
      },
      why: (rv) => `The signature now recovers to ${short(rv.arg)}, not the Airnode ${short(FEED.airnode)}. Any edit to the data breaks it.`
    },
    {
      key: 'time', title: 'Make an old price look new',
      what: 'Move the signing time to now. Old prices are refused, so a cheater would re-date them.',
      make: (r) => {
        const t = nowSec();
        return { resp: { ...r, timestamp: t }, from: `signed ${clock(Number(r.timestamp) * 1000)}`, to: `signed ${clock(Number(t) * 1000)}` };
      },
      why: (rv) => `The time is part of what the Airnode signed: the signature now recovers to ${short(rv.arg)}.`
    },
    {
      key: 'feed', title: 'Claim another feed',
      what: `Present the response as an answer to a different request (${EV.base.otherRequests.btcUsd.name}). A wrong feed would set a nonsense limit.`,
      make: (r) => ({ resp: { ...r, requestHash: EV.base.otherRequests.btcUsd.requestHash }, from: 'BSV/USD', to: 'BTC/USD' }),
      why: () => `The vault stores one request hash (${short(FEED.requestHash)}) and checks it before anything else.`
    },
    {
      key: 'sig', title: 'Forge the signature',
      what: 'Change one byte of the 65-byte signature, as anyone without the Airnode’s key would have to.',
      make: (r) => {
        const s = r.signature.slice(2);
        const i = 20;
        const b = ((parseInt(s.slice(i, i + 2), 16) + 1) % 256).toString(16).padStart(2, '0');
        const sig = '0x' + s.slice(0, i) + b + s.slice(i + 2);
        return { resp: { ...r, signature: sig }, from: 'signature', to: '1 byte changed' };
      },
      why: (rv) => (/^0x0+$/.test(rv.arg || '') ? 'The bytes no longer form a valid signature, so no signer can be recovered.' : `The signature now recovers to ${short(rv.arg)}, a key nobody registered.`)
    }
  ];

  // The tamper test: the untouched response must pass, every tampered copy must be refused. All of them are checked
  // against the judge vault (same Airnode, request and age rules as vault 5, and it has never accepted a price), so the
  // untouched one is valid whenever it is younger than the signature age limit. The replay is checked on the vault that
  // already accepted it.
  // Candidates: the judge vaults and the demo copies. checkPrice is a view call, so testing on them changes nothing.
  const TEST_CANDIDATES = [EV.base.judgeVaultId, EV.base.liveJudgeVaultId, ...(EV.base.demoHedgeVaults || [])].map((v) => BigInt(v));
  let TEST_VAULT = BigInt(EV.base.judgeVaultId);
  // The first candidate whose last accepted price is older than this response, so a replay never decides the result.
  const pickTestVault = async (ts) => {
    for (const v of TEST_CANDIDATES) {
      try { const lp = await base.lastPrice(v); if (lp.signedAt < BigInt(ts)) return v; } catch { /* try the next */ }
    }
    return BigInt(EV.base.judgeVaultId);
  };
  const labSource = () => (S.lab.mode === 'paste' && S.lab.pasted ? S.lab.pasted : S.lab.chain);
  const labSummary = () => {
    const v = S.lab.results.get('valid');
    const rs = ATTACKS.map((a) => S.lab.results.get(a.key)).filter((r) => r && (r.state === 'refused' || r.state === 'accepted'));
    const rejected = rs.filter((r) => r.state === 'refused').length;
    const validOk = v?.state === 'accepted';
    const done = !!v && v.state !== 'running' && rs.length === ATTACKS.length;
    return { done, validOk, validState: v?.state ?? null, validRevert: v?.revert ?? null, rejected, total: ATTACKS.length, pass: done && validOk && rejected === ATTACKS.length, at: S.lab.runAt, error: S.lab.error };
  };
  const sigAgeLimit = () => Number(S.chain.v5.config?.maxSignatureAge ?? 300n);

  let labSourceBusy = false;
  const loadLabSource = async () => {
    const newest = S.logData.prices.slice().reverse().find((p) => p.vaultId === VAULT || p.vaultId === RUNNER);
    if (!newest || labSourceBusy || S.lab.chain?.txHash === newest.txHash) return;
    labSourceBusy = true;
    try {
      const tx = await base.getTransaction(newest.txHash);
      const dec = C.decodeSubmitPrice(tx?.input);
      if (!dec) throw new Error('the newest price was not sent with submitPrice');
      let blockTs = null;
      try { blockTs = await base.blockTimestamp(newest.blockNumber); } catch { /* acceptance age stays unknown */ }
      S.lab.chain = { ...dec.response, vaultId: dec.vaultId, txHash: newest.txHash, blockNumber: newest.blockNumber, blockTs, signedAt: newest.signedAt, price: newest.price, from: tx.from, kind: 'chain' };
      S.lab.error = null;
      // A new accepted price: test it once in the background, so the proof on the overview stays current.
      if (S.lab.mode === 'chain' && !S.lab.busy) runLab(false);
    } catch (e) {
      S.lab.error = String(e.message || e);
    } finally {
      labSourceBusy = false;
      render();
    }
  };

  // A pasted signed response: the JSON an Airnode returns (api3/src/fetch-response.ts, api3/test/fixtures/*.json).
  const parsePasted = (text) => {
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('not JSON'); }
    if (j && typeof j === 'object' && j.signedResponse) j = j.signedResponse;
    const ts = String(j?.timestamp ?? '');
    if (!HASH.test(String(j?.requestHash))) throw new Error('requestHash must be 0x + 64 hex digits');
    if (!/^\d{1,12}$/.test(ts)) throw new Error('timestamp must be whole seconds');
    if (typeof j.data !== 'string' || !j.data.length) throw new Error('data must be the signed JSON text');
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(j.signature))) throw new Error('signature must be 65 bytes of hex');
    return { requestHash: j.requestHash, timestamp: BigInt(ts), data: j.data, signature: j.signature, signedAt: BigInt(ts), vaultId: null, kind: 'paste' };
  };

  const runCheck = async (key, vaultId, resp, diff) => {
    S.lab.results.set(key, { state: 'running', diff });
    render();
    try {
      const r = await base.checkPrice(vaultId, resp);
      S.lab.results.set(key, r.accepted ? { state: 'accepted', price: r.price, diff, at: Date.now(), fresh: true } : { state: 'refused', revert: r.revert, diff, at: Date.now(), fresh: true });
    } catch (e) {
      S.lab.results.set(key, { state: 'error', error: String(e.message || e), diff });
    }
    render();
  };
  const runLab = async (staged, only) => {
    const src0 = labSource();
    if (!src0 || S.lab.busy) return;
    S.lab.busy = true;
    if (staged && !only) { S.lab.results.clear(); S.lab.replay = null; render(); await pause(350); }
    S.lab.ranFor = `${src0.kind}:${src0.timestamp}:${src0.signature}`;
    try {
      TEST_VAULT = await pickTestVault(src0.timestamp);
      if (!only || only === 'valid') {
        await runCheck('valid', TEST_VAULT, { ...src0 }, null);
        if (src0.kind === 'chain' && src0.vaultId) {
          try { const r = await base.checkPrice(src0.vaultId, { ...src0 }); S.lab.replay = r.accepted ? { accepted: true } : { revert: r.revert }; } catch { S.lab.replay = null; }
        } else S.lab.replay = null;
        if (staged) await pause(700);
      }
      for (const a of ATTACKS) {
        if (only && a.key !== only) continue;
        const made = a.make(src0);
        if (!made) { S.lab.results.set(a.key, { state: 'error', error: 'this response has no price field' }); continue; }
        await runCheck(a.key, TEST_VAULT, made.resp, made);
        if (staged) await pause(700);
      }
      if (!only) S.lab.runAt = Date.now();
    } finally {
      S.lab.busy = false;
      render();
      setTimeout(() => { for (const r of S.lab.results.values()) r.fresh = false; sigs.delete($('#lab')); render(); }, 1200);
    }
  };

  const ERR_LABEL = { SignerMismatch: 'wrong signer', WrongRequest: 'wrong feed', StaleSignature: 'too old', Replay: 'already used', InvalidAmount: 'invalid price' };
  const errLabel = (rv) => h('span', { class: 'revert', title: `Contract error: ${rv.name}${rv.arg ? `(${rv.arg})` : '()'}` }, ERR_LABEL[rv.name] || rv.name);
  // Plain words for what stopped each tampered copy; the raw contract error stays in the tooltip.
  const REASON = {
    price: 'the signature no longer matches the data',
    time: 'the signature no longer matches the time',
    feed: 'this vault only trusts its BSV/USD feed',
    sig: 'not a valid Airnode signature'
  };
  const rawErr = (rv) => (rv ? `Contract error: ${rv.name}${rv.arg ? `(${rv.arg})` : '()'}` : undefined);
  const verdict = (r, a) => {
    if (!r) return [h('p', { class: 'verdict verdict-wait' }, 'Waiting'), h('p', { class: 'verdict-cap' }, ' ')];
    if (r.state === 'running') return [h('p', { class: 'verdict verdict-run' }, 'Checking…'), h('p', { class: 'verdict-cap' }, 'asking the live contract')];
    if (r.state === 'error') return [h('p', { class: 'verdict verdict-bad', title: r.error }, 'No answer'), h('p', { class: 'verdict-cap' }, 'the RPC did not answer; run again')];
    if (!a) { // the untouched response
      if (r.state === 'accepted') return [h('p', { class: 'verdict verdict-ok' }, 'Accepted'), h('p', { class: 'verdict-cap' }, 'passes every check')];
      if (r.revert.name === 'StaleSignature') return [h('p', { class: 'verdict verdict-warn', title: rawErr(r.revert) }, 'Expired'), h('p', { class: 'verdict-cap' }, `signed over ${dur(sigAgeLimit())} ago; the next price passes`)];
      return [h('p', { class: 'verdict verdict-bad', title: rawErr(r.revert) }, 'Not accepted'), h('p', { class: 'verdict-cap' }, ERR_LABEL[r.revert.name] || r.revert.name)];
    }
    if (r.state === 'refused') return [h('p', { class: 'verdict verdict-ok', title: rawErr(r.revert) }, 'Blocked'), h('p', { class: 'verdict-cap' }, REASON[a.key] || ERR_LABEL[r.revert.name] || r.revert.name)];
    return [h('p', { class: 'verdict verdict-bad' }, 'Accepted'), h('p', { class: 'verdict-cap' }, 'this should not happen')];
  };

  const renderLab = () => {
    const el = $('#lab');
    const s = labSource();
    const sum = labSummary();
    const res = [...S.lab.results.entries()];
    const ageLeft = s ? sigAgeLimit() - Number(nowSec() - BigInt(s.timestamp)) : null;
    const fresh = ageLeft !== null && ageLeft > 0;
    mount(el, stringify([s?.signature, s?.timestamp, S.lab.mode, res, S.lab.busy, S.lab.error, S.lab.pasteError, S.lab.replay, fresh, sum]), () => {
      const out = [
        head('lab-title', 'Tamper test', h('span', { class: 'src', title: `TreasuryGuard.checkPrice on vault ${TEST_VAULT}, as a free eth_call: nothing is sent or signed` }, 'live contract')),
        h('p', { class: 'card-sub' }, 'The untouched signed price must pass; four tampered copies must be refused. A forged price is the main risk: a lower price means more sats per dollar. Vault ', String(TEST_VAULT), ' has the same Airnode, request and age rules as the team’s vault and has never accepted a price, so only the checks decide.')
      ];
      if (!s) {
        out.push(h('p', { class: 'state' }, S.lab.error ? `No signed price to test yet: ${S.lab.error}` : 'Reading the newest accepted price from Base Sepolia…'));
      } else {
        const checked = res.filter(([, r]) => r.state !== 'running').length;
        out.push(h('div', { class: 'lab-source' },
          h('div', null,
            h('p', { class: 'small muted' }, s.kind === 'chain' ? ['Real signed price from the chain · ', baseTx(s.txHash), ' · signed ', agoSpan(Number(s.timestamp))] : ['Your signed price · signed ', agoSpan(Number(s.timestamp))],
              ' · ', fresh ? h('span', { class: 'ok', dataset: { untilSec: String(Number(s.timestamp) + sigAgeLimit()) } }, '') : h('span', { class: 'warnc' }, `older than ${dur(sigAgeLimit())}`)),
            h('p', { class: 'lab-price', title: s.data || undefined }, s.price ? price8(s.price) : 'signed response', h('span', { class: 'unit muted' }, ' per BSV'))),
          h('div', { class: 'row' },
            S.lab.busy ? h('span', { class: 'note-pill' }, `Checking ${Math.min(checked + 1, ATTACKS.length + 1)} of ${ATTACKS.length + 1}…`)
              : sum.done ? h('span', { class: sum.pass ? 'pass' : 'note-pill' }, sum.validOk ? `1 accepted · ${sum.rejected} of ${sum.total} blocked` : `${sum.rejected} of ${sum.total} blocked · price expired`) : null,
            h('button', { type: 'button', class: 'btn btn-api3', id: 'lab-run-all', disabled: S.lab.busy || undefined, onclick: () => runLab(true) }, S.lab.busy ? 'Checking…' : 'Run the tamper test'))));
        const card = (key, title, diff, r, a) => {
          const good = r && ((a && r.state === 'refused') || (!a && r.state === 'accepted'));
          const bad = r && !good && r.state !== 'running' && !(!a && r.revert?.name === 'StaleSignature');
          return h('article', { class: `attack${good ? ' is-good' : ''}${bad ? ' is-bad' : ''}${r?.state === 'running' ? ' is-checking' : ''}${r?.fresh ? ' is-new' : ''}` },
            h('h4', null, title),
            h('p', { class: 'attack-diff' }, diff),
            h('div', { class: 'attack-result', 'aria-live': 'polite' }, verdict(r, a)));
        };
        const v = S.lab.results.get('valid');
        const cards = [card('valid', 'Real price, untouched', 'no change', v, null)];
        for (const a of ATTACKS) {
          const r = S.lab.results.get(a.key);
          const d = r?.diff || a.make(s);
          cards.push(card(a.key, a.title, d ? [h('del', null, d.from), ' → ', h('ins', null, d.to)] : '', r, a));
        }
        out.push(h('div', { class: 'lab-grid' }, cards));
        if (S.lab.replay?.revert) out.push(h('p', { class: 'small muted lab-replay', title: rawErr(S.lab.replay.revert) }, `Sending the same real price twice is blocked too: already used.`));
      }
      out.push(h('details', { class: 'lab-paste', dataset: { key: 'paste' }, open: S.lab.mode === 'paste' || undefined },
        h('summary', { title: 'Paste a signed response JSON, e.g. api3/cache/judge-last-price.json (written by judge.ts) or any file in api3/test/fixtures' }, 'Test your own signed response'),
        h('form', { class: 'paste-form', onsubmit: (e) => {
          e.preventDefault();
          const text = String(new FormData(e.target).get('resp') || '');
          try { S.lab.pasted = parsePasted(text); S.lab.mode = 'paste'; S.lab.pasteError = null; S.lab.results.clear(); S.lab.replay = null; runLab(true); }
          catch (err) { S.lab.pasteError = err.message; render(); }
        } },
          h('label', { class: 'sr-only', for: 'paste-resp' }, 'Signed response JSON'),
          h('textarea', { id: 'paste-resp', name: 'resp', rows: '5', spellcheck: 'false', class: 'paste-area', placeholder: '{ "requestHash": "0x…", "timestamp": "…", "data": "{\\"price\\":…}", "signature": "0x…" }' }),
          h('div', { class: 'row' },
            h('button', { type: 'submit', class: 'btn btn-api3', disabled: S.lab.busy || undefined }, 'Test my response'),
            S.lab.mode === 'paste' ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { S.lab.mode = 'chain'; S.lab.results.clear(); S.lab.replay = null; runLab(false); } }, 'Back to the newest on-chain price') : null,
            S.lab.pasteError ? h('span', { class: 'bad small' }, S.lab.pasteError) : null))));
      return out;
    });
  };

  // ---------------------------------------------------------------- render: API3 · breaker, news guard, oracle

  const renderBreaker = () => {
    const el = $('#breaker-card');
    const cfg = S.chain.v5.config;
    const lp = S.chain.v5.lastPrice?.signedAt ? S.chain.v5.lastPrice : latestPrice();
    if (!cfg || !lp) { mount(el, 'b-empty', () => [head('breaker-title', 'Crash guard'), h('p', { class: 'state' }, 'Reading the vault rules…')]); return; }
    const v = Number(lp.change1h), b = Number(cfg.breakerBps), re = Number(cfg.reentryBps);
    const lo = Math.min(b - 150, v - 100), hi = Math.max(re + 150, v + 100);
    const pos = (x) => ((x - lo) / (hi - lo)) * 100;
    const r8 = S.chain.v8.regime;
    mount(el, stringify([v, b, re, S.chain.v5.regime, r8, cfg.cooldown, cfg.breakerHedgeBps]), () => [
      head('breaker-title', 'Crash guard', srcBadge('base', 'Base Sepolia')),
      h('p', { class: 'card-sum' }, `If the signed 1-hour change falls to ${pct(cfg.breakerBps)}, the vault switches to RISK_OFF and hedges ${fixed(cfg.breakerHedgeBps, 2, 0)} %.`),
      h('p', { class: 'gauge-cap' }, 'BSV/USD change over the last hour (signed)'),
      h('p', { class: 'card-sub' }, `A signed 1-hour change at or below ${pct(cfg.breakerBps)} puts the vault in RISK_OFF and opens a hedge of ${fixed(cfg.breakerHedgeBps, 2, 0)} % (sats → dUSD), inside a band around the signed price. Back to normal only after a ${dur(cfg.cooldown)} cooldown and a signed ${pct(cfg.reentryBps)}. No language model in this path.`),
      h('div', { class: 'gauge', role: 'img', 'aria-label': `1 hour change ${pct(lp.change1h)}; breaker at ${pct(cfg.breakerBps)}` },
        h('span', { class: 'gauge-track' }),
        h('span', { class: 'gauge-zone gauge-zone-off', dataset: { w: String(pos(b)) } }),
        h('span', { class: 'gauge-zone-label', dataset: { left: String(pos(b) / 2) } }, 'RISK_OFF'),
        h('span', { class: 'gauge-tick gauge-tick-bad', dataset: { left: String(pos(b)) } }),
        h('span', { class: 'gauge-label', dataset: { left: String(pos(b)) } }, `breaker ${pct(cfg.breakerBps)}`),
        h('span', { class: 'gauge-tick', dataset: { left: String(pos(0)) } }),
        h('span', { class: 'gauge-label', dataset: { left: String(pos(0)) } }, '0 %'),
        h('span', { class: 'gauge-tick', dataset: { left: String(pos(re)) } }),
        h('span', { class: 'gauge-label', dataset: { left: String(pos(re)) } }, `re-entry ${pct(cfg.reentryBps)}`),
        h('span', { class: 'gauge-needle', dataset: { left: String(pos(v)) } }),
        h('span', { class: 'gauge-now', dataset: { left: String(pos(v)) } }, `now ${pct(lp.change1h)}`)),
      h('p', { class: 'small muted' }, 'Team vault ', regimePill(S.chain.v5.regime), ' · API3 runner ', regimePill(r8))
    ]);
  };
  const regimePill = (r) => (r ? h('span', { class: `regime-pill regime-${String(r).toLowerCase()}` }, String(r).replace('_', ' ')) : h('span', { class: 'muted' }, '—'));

  const DEMO_HEDGE_VAULTS = (EV.base.demoHedgeVaults || []).map((v) => BigInt(v));
  const HEDGE_VAULTS = [VAULT, ...DEMO_HEDGE_VAULTS];
  const DIRECTION = { SATS_TO_DUSD: 'sats → dUSD', DUSD_TO_SATS: 'dUSD → sats', NONE: '—' };
  const renderNews = () => {
    const el = $('#news-card');
    const cfg = S.chain.v5.config;
    const all = [...S.chain.intents.entries()];
    const hedges = all.filter(([, i]) => i.kind === 'SWAP' && i.source === 'EVENT' && HEDGE_VAULTS.includes(i.vaultId)).sort(([a], [b]) => (BigInt(b) > BigInt(a) ? 1 : -1));
    const regimes = HEDGE_VAULTS.filter((v) => v !== VAULT).map((v) => [v.toString(), S.chain.others[v.toString()]]);
    mount(el, stringify([[...S.posts], hedges, regimes, cfg?.eventHedgeBps, cfg?.maxPostAge]), () => [
      head('news-title', 'News guard', srcBadge('base', 'Base Sepolia')),
      h('p', { class: 'card-sum' }, `A signed post from one of these accounts can hedge at most ${cfg ? fixed(cfg.eventHedgeBps, 2, 0) : '25'} % of the vault.`),
      h('p', { class: 'card-sub' }, `A post from a whitelisted account, signed by the TwitterAPI.io Airnode, together with a fresh signed price, can hedge at most ${cfg ? fixed(cfg.eventHedgeBps, 2, 0) : '25'} % of the vault (GUARDED). Retweets and posts older than ${cfg ? dur(cfg.maxPostAge) : '30 min'} are refused, and each post counts once.`),
      h('ul', { class: 'accounts' }, EV.base.posts.accounts.map((a) => {
        const ok = S.posts.get(a.handle);
        return h('li', null, h('span', null, h('span', { class: 'handle' }, `@${a.handle}`), a.note ? h('span', { class: 'muted small' }, ` · ${a.note}`) : null),
          ok === undefined ? h('span', { class: 'muted small' }, '…') : pass(ok, ok ? 'whitelisted' : 'not whitelisted'));
      })),
      hedges.length ? h('ul', { class: 'chain-proof' }, hedges.slice(0, 4).map(([id, i]) => {
        const tx = S.logData.intentTx.get(id)?.txHash;
        return h('li', null, h('span', null, `Hedge #${id} · vault ${i.vaultId} · ${DIRECTION[i.direction] || i.direction}, at most ${fixed(i.maxBps, 2, 0)} %`), h('span', null, tx ? baseTx(tx) : nowSec() < i.expiry ? 'open' : 'expired'));
      })) : h('p', { class: 'small muted', title: `Vault 5 and its demo copies (vaults ${DEMO_HEDGE_VAULTS.join(', ')}). The watcher never co-signs a hedge, so a hedge moves no BSV.` }, 'No hedge has been triggered yet.'),
      null
    ]);
  };

  const renderOracle = () => {
    const el = $('#oracle-card');
    const prices = S.logData.prices.slice().reverse();
    const logIntents = new Map(S.logData.intents.map((i) => [i.txHash, i]));
    const lp8 = S.chain.v8.lastPrice;
    const active = lp8 && lp8.signedAt > 0n ? Number(nowSec() - lp8.signedAt) < 25 * 60 : false;
    mount(el, stringify([prices.map((p) => [p.txHash, p.vaultId]), S.logData.from, S.logData.to, active]), () => [
      head('oracle-title', 'Accepted prices', srcBadge('logs', 'PriceVerified events')),
      h('p', { class: 'card-sub' }, `Vault 8 is the API3 runner (api3/src/agent.ts): on its own key it buys a signed price over x402 about every 10 minutes and submits it, with no BSV behind it. ${active ? 'It is running now.' : 'It has not submitted in the last 25 minutes.'} Vault 5 is the team’s agent, whose limits the watcher enforces on BSV.`),
      prices.length ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Accepted prices' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Time', 'Submitted by', 'BSV/USD', '1 h', 'Spend limit', 'Base tx'].map((t, i) => h('th', { scope: 'col', class: i === 2 || i === 3 ? 'r' : undefined }, t)))),
        h('tbody', null, prices.slice(0, 8).map((p) => {
          const it = logIntents.get(p.txHash);
          return h('tr', null, h('td', null, clock(Number(p.signedAt) * 1000).slice(0, 5)), h('td', { title: `vault ${p.vaultId}` }, p.vaultId === RUNNER ? 'API3 runner' : p.vaultId === VAULT ? 'Team agent' : `vault ${p.vaultId}`),
            h('td', { class: 'r num' }, price8(p.price)), h('td', { class: 'r num' }, pct(p.change1h)),
            h('td', null, it ? `${group(it.maxSats)} sats (intent ${it.intentId})` : h('span', { class: 'muted' }, 'none')), h('td', null, baseTx(p.txHash)));
        }))))
        : h('p', { class: 'empty' }, S.logData.from !== null ? 'No price accepted in the blocks read so far.' : 'Reading recent blocks…')
    ]);
  };

  // ---------------------------------------------------------------- render: BSV · script, vault, history, costs

  const renderScript = () => {
    const el = $('#script-card');
    const vs = S.vaultScript;
    const hv = S.health.value;
    mount(el, stringify([vs, hv?.agentKey, hv?.watcherKey]), () => {
      const out = [head('script-title', 'The vault script', srcBadge('history', 'WhatsOnChain'))];
      if (!vs) { out.push(h('p', { class: 'state' }, S.history.status === 'error' ? 'Vault transactions unavailable (WhatsOnChain).' : 'Reading the vault script from BSV…')); return out; }
      const k = vs.keys;
      const key = (role, hex, match) => h('span', { class: 'key' }, h('strong', null, role), h('span', { class: 'mono' }, short(hex, 6, 4)), match === true ? h('span', { class: 'pass' }, 'matches the binding') : null);
      out.push(h('div', { class: 'script-paths' },
        h('div', { class: 'path' },
          h('div', { class: 'path-head' }, h('span', { class: 'path-title' }, 'Spend: agent and watcher together'), tag('bsv', 'every withdrawal')),
          h('div', { class: 'path-keys' }, key('agent', k.agent, hv?.agentKey ? hv.agentKey === k.agent : null), h('span', { class: 'op' }, 'AND'), key('watcher', k.watcher, hv?.watcherKey ? hv.watcherKey === k.watcher : null)),
          h('p', { class: 'small muted', title: 'The watcher co-signs only a transaction that pays the registered float at most maxSats, fee included, returns the rest to this script and carries a TGv1 receipt for the intent.' }, 'Limit: the watcher’s check against the intent on Base')),
        h('div', { class: 'path-or' }, 'OR'),
        h('div', { class: 'path' },
          h('div', { class: 'path-head' }, h('span', { class: 'path-title' }, 'Exit: the owner alone'), tag('bsv', 'always available')),
          h('div', { class: 'path-keys' }, key('owner', k.owner)),
          h('p', { class: 'small muted' }, 'No agent, no watcher, no Base'))));
      out.push(h('p', { class: 'card-sub' }, 'Script: OP_IF <agent> OP_CHECKSIGVERIFY <watcher> OP_CHECKSIG OP_ELSE <owner> OP_CHECKSIG OP_ENDIF'));
      out.push(h('p', { class: 'chips' }, pass(vs.hashOk, vs.hashOk ? 'script SHA-256 matches the binding' : 'script hash not verified'), ' ',
        hv?.agentKey ? pass(hv.agentKey === k.agent && hv.watcherKey === k.watcher, hv.agentKey === k.agent && hv.watcherKey === k.watcher ? 'keys match the running watcher' : 'keys differ from the watcher') : null));
      return out;
    });
  };

  const renderVault = () => {
    const el = $('#vault-card');
    const v = S.vault.value;
    const price = priceForUsd();
    if (!v) {
      mount(el, stringify(['v-empty', S.vault.status]), () => [head('vault-title', 'In the vault now', srcBadge('vault', 'WhatsOnChain')), h('p', { class: 'state' }, S.vault.status === 'error' ? 'No balance loaded. Retries are automatic.' : 'Reading the vault balance…')]);
      return;
    }
    mount(el, stringify([v, price]), () => [
      head('vault-title', 'In the vault', srcBadge('vault', 'WhatsOnChain')),
      h('p', { class: 'big' }, h('span', { class: 'num' }, group(v.total)), h('span', { class: 'unit' }, 'sats'), price ? h('span', { class: 'usd' }, approxUsd(v.total, price)) : null),
      h('ul', { class: 'utxos' }, v.utxos.length ? v.utxos.map((u) => h('li', null, wocTx(u.tx_hash), `:${u.tx_pos} · ${group(u.value)} sats · `,
        u.status === 'confirmed' ? `block ${group(u.height)}` : 'unconfirmed',
        u.isSpentInMempoolTx ? h('span', { class: 'warnc' }, ' · being spent') : null))
        : h('li', { class: 'muted' }, 'No coins at the vault script. The agent cannot spend until the owner funds it.')),
      h('p', { class: 'note' }, 'Every coin here is locked by the script on the left. Funding and exit: ', tabLink('owner', 'Owner'), '.')
    ]);
  };

  const KIND = {
    fund: ['hist-fund', 'Funded by the owner'],
    withdraw: ['hist-withdraw', 'Withdrawal · agent + watcher'],
    exit: ['hist-exit', 'Owner exit · owner alone'],
    other: ['', 'Other']
  };
  const renderHistory = () => {
    const el = $('#history-card');
    const rows = S.hist.rows;
    const price = priceForUsd();
    mount(el, stringify([rows, price, S.history.status, S.hist.ids.length]), () => {
      const funded = rows.filter((r) => r.kind === 'fund').reduce((a, r) => a + r.vaultOut, 0n);
      const toAgent = rows.filter((r) => r.kind === 'withdraw').reduce((a, r) => a + (r.toAgent ?? 0n), 0n);
      const back = rows.filter((r) => r.kind === 'exit').reduce((a, r) => a + (r.out ?? 0n), 0n);
      const fees = rows.reduce((a, r) => a + (r.kind !== 'fund' && r.fee !== null ? r.fee : 0n), 0n);
      const out = [head('history-title', 'Vault history', srcBadge('history', 'WhatsOnChain script history'))];
      if (!rows.length) { out.push(h('p', { class: 'state' }, S.history.status === 'error' ? 'Vault history unavailable (WhatsOnChain).' : `Reading ${S.hist.ids.length || ''} vault transactions…`)); return out; }
      out.push(h('p', { class: 'card-sum' }, `In ${group(funded)} · to the agent ${group(toAgent)} · back to the owner ${group(back)} · fees ${group(fees)} sats`));
      out.push(h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Vault history' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Transaction', 'What happened', 'Into the vault', 'Out of the vault', 'Fee', 'Block'].map((t, i) => h('th', { scope: 'col', class: i >= 2 && i <= 4 ? 'r' : undefined }, t)))),
        h('tbody', null, rows.map((r) => {
          const [cls, label] = KIND[r.kind];
          return h('tr', null,
            h('td', null, wocTx(r.txid)),
            h('td', null, h('span', { class: `hist-kind ${cls}` }, label), r.intentId ? h('span', { class: 'sub' }, `intent ${r.intentId}`) : r.kind === 'exit' ? h('span', { class: 'sub' }, 'owner key only') : null),
            h('td', { class: 'r num' }, r.vaultOut ? `+${group(r.vaultOut)}` : '—'),
            h('td', { class: 'r num' }, r.kind === 'withdraw' ? [`${group(r.toAgent ?? 0n)}`, h('span', { class: 'sub' }, 'to the agent')] : r.kind === 'exit' ? [`${group(r.out ?? 0n)}`, h('span', { class: 'sub' }, 'to the owner')] : '—'),
            h('td', { class: 'r num' }, r.kind === 'fund' ? h('span', { class: 'muted' }, 'paid by wallet') : r.fee !== null ? group(r.fee) : '—'),
            h('td', null, r.height ? group(r.height) : h('span', { class: 'muted' }, 'unconfirmed')));
        })))));
      return out;
    });
  };

  const renderCosts = (rows) => {
    const el = $('#costs');
    const price = priceForUsd();
    const wFees = S.hist.rows.filter((r) => r.kind === 'withdraw' && r.fee !== null).map((r) => r.fee);
    const pFees = rows.map((r) => r.payment).filter((p) => p?.state === 'spent' && p.fee !== null && p.fee !== undefined).map((p) => p.fee);
    const eFees = S.hist.rows.filter((r) => r.kind === 'exit' && r.fee !== null).map((r) => r.fee);
    const mw = median(wFees), mp = median(pFees), me = median(eFees);
    mount(el, stringify([mw, mp, me, wFees.length, pFees.length, price]), () => {
      const cell = (label, v) => stat(label, v !== null ? group(v) : '—', v !== null ? 'sats' : null, v !== null && price ? approxUsd(v, price) : null);
      return [
        head('costs-title', 'Fees on BSV', srcBadge('history', 'fees read from the transactions')),
        h('div', { class: 'stats' }, cell('Withdrawal', mw), cell('HTTP 402', mp), cell('Owner exit', me)),
        h('p', { class: 'note' }, 'Fee = inputs minus outputs of each transaction. Agents pay in small amounts and often, so the fee has to be far below the payment itself.')
      ];
    });
  };

  // Each co-signed withdrawal: sats paid to the agent (bar) against the limit its intent set on Base (marker).
  const renderWithdrawals = () => {
    const el = $('#withdrawals-card');
    const ws = S.hist.rows.filter((r) => r.kind === 'withdraw' && r.toAgent !== null).slice().reverse();
    const lim = (id) => { const it = id ? S.chain.intents.get(id) : null; return it && it.vaultId === VAULT ? Number(it.maxSats) : null; };
    mount(el, stringify([ws.map((r) => [r.txid, r.intentId, r.toAgent, r.fee]), ws.map((r) => lim(r.intentId))]), () => {
      const out = [head('withdrawals-title', 'Withdrawals vs limit', srcBadge('history', 'WhatsOnChain + Base'))];
      if (!ws.length) { out.push(h('p', { class: 'state' }, 'Reading withdrawals…')); return out; }
      const W = 560, H = 200, L = 40, R = 8, T = 22, B = 26;
      const max = Math.max(...ws.map((r) => Math.max(Number(r.toAgent) + Number(r.fee ?? 0n), lim(r.intentId) ?? 0)));
      const top = Math.ceil(max / 2000) * 2000;
      const Y = (v) => T + (1 - v / top) * (H - T - B);
      const slot = (W - L - R) / ws.length, bw = Math.min(46, slot * 0.56);
      const ticks = []; for (let v = 0; v <= top; v += 2000) ticks.push(v);
      out.push(h('figure', { class: 'chart' },
        sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `${ws.length} withdrawals; each stayed below its limit` },
          ticks.map((v) => [sv('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: v === 0 ? 'axis' : 'grid' }), sv('text', { x: L - 8, y: Y(v) + 4, class: 'chart-tick', 'text-anchor': 'end' }, v ? `${v / 1000}k` : '0')]),
          ws.map((r, i) => {
            const x = L + slot * i + (slot - bw) / 2, v = Number(r.toAgent), f = Number(r.fee ?? 0n), m = lim(r.intentId), newest = i === ws.length - 1;
            return sv('g', { class: newest ? 'bar bar-new' : 'bar' },
              sv('title', null, `Intent ${r.intentId ?? '?'}: ${group(r.toAgent)} sats to the agent + ${group(r.fee ?? 0n)} fee${m ? `, limit ${group(m)}` : ''}`),
              sv('rect', { x, y: Y(v + f), width: bw, height: Math.max(1, Y(0) - Y(v + f)), rx: 4, class: 'bar-fill' }),
              m ? sv('line', { x1: x - 5, x2: x + bw + 5, y1: Y(m), y2: Y(m), class: 'limit-mark' }) : null,
              newest ? sv('text', { x: x + bw / 2, y: Y(Math.max(v + f, m ?? 0)) - 8, class: 'chart-val', 'text-anchor': 'middle' }, group(v + f)) : null,
              sv('text', { x: x + bw / 2, y: H - 8, class: 'chart-tick', 'text-anchor': 'middle' }, `#${r.intentId ?? '?'}`));
          })),
        h('figcaption', { class: 'legend' }, h('span', { class: 'key-bar' }), 'sats out (incl. fee)', h('span', { class: 'key-limit' }), 'limit on Base')));
      return out;
    });
  };

  const renderPayments = (rows) => {
    const el = $('#payments-card');
    const pays = rows.filter((r) => r.payment?.state === 'spent');
    mount(el, stringify([pays.map((r) => [r.id, r.payment, S.tx.get(r.payment.txid)?.state])]), () => [
      head('payments-title', 'HTTP 402 payments', srcBadge('vault', 'WhatsOnChain')),
      h('p', { class: 'card-sub' }, 'The agent’s model decides whether a paid API serves its task; a guardian in the float wallet checks the merchant, the price and the caps. Each payment is the next spend of a withdrawal’s float output.'),
      pays.length ? h('ul', { class: 'chain-proof' }, pays.map((r) => h('li', null,
        h('span', null, `Intent ${r.id} · `, r.payment.sats !== null ? `${group(r.payment.sats)} sats` : 'paid', (() => { const o = (EV.bsv.paymentOutcomes || {})[r.payment.txid]; return o ? h('span', { class: o.http === 200 ? 'muted' : 'bad' }, o.http === 200 ? ' · HTTP 200' : ` · HTTP ${o.http}, no data`) : null; })()),
        h('span', null, wocTx(r.payment.txid)))))
        : h('p', { class: 'empty' }, 'Reading the float outputs…')
    ]);
  };

  // ---------------------------------------------------------------- render: transactions (ledger), trust

  const STATE_LABEL = {
    withdrawn: 'Withdrawal on BSV',
    reported: 'Settle recorded · BSV tx not read yet',
    cosigned: 'Co-signed · BSV tx not seen yet',
    open: 'Open',
    expired: 'Expired · nothing moved',
    unknown: 'Unknown'
  };
  const renderPipeline = (rows) => {
    const el = $('#pipeline');
    const txSig = rows.map((r) => [r.txid, S.tx.get(r.txid)?.state, r.payment, r.payment?.txid ? S.tx.get(r.payment.txid)?.state : null]);
    mount(el, stringify([rows.map((r) => [r.id, r.state, r.txid, r.mismatch, r.settled, r.maxSats, r.outflow, r.toAgent, r.baseCreatedTx, r.onChain?.expiry]), txSig]), () => [
      head('pipeline-title', 'Vault 5 intents', h('span', { class: 'src' }, srcBadge('base', 'Base'), ' · ', srcBadge('vault', 'WhatsOnChain'))),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Intent ledger' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Intent', 'Limit (Base)', 'BSV withdrawal', 'Used of limit', 'HTTP 402 payment', 'Settle'].map((t, i) => h('th', { scope: 'col', class: i === 1 || i === 3 ? 'r' : undefined }, t)))),
        h('tbody', null, rows.length ? rows.map(pipeRow) : h('tr', null, h('td', { colspan: '6', class: 'empty' }, 'No intents loaded for vault 5 yet.')))))
    ]);
  };
  const pipeRow = (r) => {
    const used = r.outflow ?? r.toAgent;
    const share = used !== null && r.maxSats ? Number((used * 1000n) / r.maxSats) / 10 : null;
    return h('tr', null,
      h('th', { scope: 'row' }, h('span', { class: 'intent-id' }, `#${r.id}`), h('span', { class: 'intent-state' }, STATE_LABEL[r.state]),
        r.state === 'open' ? h('span', { class: 'sub countdown', dataset: { untilSec: r.onChain.expiry.toString() } }, '') : null,
        r.baseCreatedTx ? h('span', { class: 'sub' }, 'created ', baseTx(r.baseCreatedTx)) : null),
      h('td', { class: 'r num' }, r.maxSats !== null ? group(r.maxSats) : '—', r.onChain ? h('span', { class: 'sub' }, `${approxUsd(r.maxSats, r.onChain.price)} at ${price4(r.onChain.price)}`) : null),
      h('td', null, r.txid ? [wocTx(r.txid), txState(r.txid), r.toAgent !== null ? h('span', { class: 'sub' }, `${group(r.toAgent)} sats to the ${r.chainOut?.payee === 'earlier' ? 'earlier agent wallet' : 'float'}${r.fee !== null ? ` · fee ${group(r.fee)}` : ''}`) : null] : h('span', { class: 'muted' }, '—'),
        r.mismatch ? h('span', { class: 'sub bad' }, 'Settle record differs from the BSV receipt') : null),
      h('td', { class: 'r' }, share !== null ? [h('span', { class: 'num' }, `${share.toFixed(1)} %`), meter(share, share <= 100 ? 'bsv' : 'bad')] : h('span', { class: 'muted' }, '—')),
      h('td', null, paymentCell(r)),
      h('td', null, r.settled ? h('span', { class: 'status status-info' }, 'recorded') : h('span', { class: 'muted' }, '—')));
  };
  const paymentCell = (r) => {
    if (!r.chainOut) return h('span', { class: 'muted' }, '—');
    const p = r.payment;
    if (!p) return h('span', { class: 'muted small' }, 'checking…');
    if (p.state === 'error') return h('span', { class: 'muted small' }, 'WhatsOnChain unavailable, retrying');
    if (p.state === 'unspent') return h('span', { class: 'muted small' }, r.chainOut.payee === 'earlier' ? 'earlier wallet output not spent' : 'not spent yet');
    return [wocTx(p.txid), txState(p.txid), p.sats !== null ? h('span', { class: 'sub' }, `${group(p.sats)} sats paid${p.fee !== null && p.fee !== undefined ? ` · fee ${group(p.fee)}` : ''}`) : null];
  };

  const renderTrust = () => {
    mount($('#trust'), 'trust-v2', () => [
      h('h4', { id: 'trust-title' }, 'API3 signatures'),
      h('p', null, 'An Airnode signature proves who said what, when, and that the data was not changed. It does not prove the price is right. That is why the larger rule-based moves use only signed price data, and a post can hedge at most 25 %.'),
      h('h4', null, 'Watcher approval'),
      h('p', null, 'Approval means the watcher co-signed one transaction. Broadcast is separate: the BSV columns show what WhatsOnChain reports.'),
      h('h4', null, 'Base settle'),
      h('p', null, 'settle(intent, txid) is a record written by the agent, not a cross-chain proof. Base does not verify BSV; enforcement lives in the BSV script and the watcher.'),
      h('h4', null, 'BSV history and fees'),
      h('p', null, 'Vault history, fees and HTTP 402 payments are read from WhatsOnChain. A payment is the next spend of a withdrawal’s float output; the float wallet’s full balance is private.')
    ]);
  };

  // ---------------------------------------------------------------- footer

  const renderFooter = () => {
    const hv = S.health.value;
    mount($('#footer'), stringify([hv?.watcherKey, hv?.agentKey, hv?.vaultScriptSha256]), () => [
      h('p', null, h('strong', null, 'This page holds no key.'), ' It reads the watcher, WhatsOnChain and Base Sepolia, and runs the forgery check as free eth_calls. Only the owner server can start a transaction, and BSV Desktop asks the owner to approve every owner transaction.'),
      h('dl', { class: 'foot-facts' },
        h('div', null, h('dt', null, 'Contract (Base Sepolia, chain 84532)'), h('dd', null, ext(`${EV.base.explorer}/address/${EV.base.contract}`, EV.base.contract))),
        h('div', null, h('dt', null, 'Vault script SHA-256'), h('dd', { class: 'mono' }, hv?.vaultScriptSha256 || EV.bsv.vaultScriptSha256, h('span', { class: 'muted' }, hv?.vaultScriptSha256 ? ' (watcher /health)' : ' (configured)'))),
        h('div', null, h('dt', null, 'Agent key'), h('dd', { class: 'mono' }, hv?.agentKey || S.vaultScript?.keys.agent || 'Not connected')),
        h('div', null, h('dt', null, 'Watcher key'), h('dd', { class: 'mono' }, hv?.watcherKey || S.vaultScript?.keys.watcher || 'Not connected'))),
      h('p', { class: 'muted small' }, 'Sources: watcher ', CFG.watcher, ' · Base RPC ', CFG.rpc, ' · ', CFG.woc, '. Keys: V video mode, ← → chapters, C captions.')
    ]);
  };

  // ---------------------------------------------------------------- owner actions (fund, exit) and "Run it live"
  // Talks only to the local owner action server (bsv/scripts/owner-serve.mjs) on the watcher laptop.

  const OWNER_API = httpUrl(params.get('ownerApi'), 'http://127.0.0.1:5820');
  const ownerToken = (() => {
    const t = params.get('owner');
    try {
      if (t && /^[0-9a-f]{16,128}$/.test(t)) sessionStorage.setItem('tg.ownerToken', t);
      if (t) { params.delete('owner'); const q = params.toString(); history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash); }
      return sessionStorage.getItem('tg.ownerToken');
    } catch { return t; }
  })();
  const ownerFetch = async (path, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(OWNER_API + path, { ...init, signal: controller.signal, cache: 'no-store', credentials: 'omit',
        headers: { 'X-Owner-Token': ownerToken || '', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; e.body = body; throw e; }
      return body;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('the owner server did not answer');
      if (e instanceof TypeError) { const x = new Error('owner server not reachable'); x.status = 0; throw x; }
      throw e;
    } finally { clearTimeout(timer); }
  };
  S.owner = { state: 'checking', health: null, job: null, error: null, confirmFund: null };
  const ownerCheck = async () => {
    if (!ownerToken) { S.owner.state = 'no-token'; render(); return; }
    try {
      S.owner.health = await ownerFetch('/owner/health');
      S.owner.state = S.owner.health.mainnetAllowed ? 'ready' : 'mainnet-off';
      if (S.owner.health.busy && (!S.owner.job || S.owner.job.state !== 'running')) followJob(S.owner.health.busy);
      else if (!S.owner.job && S.owner.health.last) S.owner.job = S.owner.health.last;
    } catch (e) {
      S.owner.state = e.status === 401 ? 'bad-token' : e.status === 403 ? 'origin' : 'offline';
      S.owner.error = e.message;
    }
    render();
  };
  let jobTimer = null;
  const stepDone = (j, key) => j?.steps?.find((x) => x.key === key)?.state === 'done';
  // When a step of the server's job finishes, refresh the matching chain reads now instead of on the next poll.
  const nudge = (prev, j) => {
    const newly = (key) => stepDone(j, key) && !stepDone(prev, key);
    if (newly('intent') || newly('settle')) { basePoller?.now(); logPoller?.now(); }
    if (newly('withdraw') || newly('fund') || newly('exit')) { vaultPoller?.now(); basePoller?.now(); historyPoller?.now(); }
    if (newly('buy') && j.intentId) { S.payments.delete(String(j.intentId)); readPayment(String(j.intentId)); }
  };
  const followJob = (job) => {
    S.owner.job = job;
    clearTimeout(jobTimer);
    const tick = async () => {
      try {
        const j = await ownerFetch(`/owner/jobs/${encodeURIComponent(S.owner.job.id)}`);
        nudge(S.owner.job, j);
        S.owner.job = j;
        if (j.state === 'running') jobTimer = setTimeout(tick, 1500);
        else { vaultPoller?.now(); historyPoller?.now(); ownerCheck(); }
      } catch { jobTimer = setTimeout(tick, 3000); }
      render();
    };
    jobTimer = setTimeout(tick, 1200);
    render();
  };
  const ownerAction = async (path, body) => {
    S.owner.error = null;
    try { followJob(await ownerFetch(path, { method: 'POST', body: JSON.stringify(body) })); }
    catch (e) { S.owner.error = e.message; if (e.body?.job) followJob(e.body.job); render(); }
  };

  // [tone, short text, how-to for the tooltip]
  const HOWTO = 'On the watcher laptop: CONFIRM_MAINNET=1 npm run owner-serve, then open the link it prints (see bsv/README.md).';
  const ownerStateLine = () => ({
    checking: ['muted', 'Checking…', ''],
    'no-token': ['muted', 'Owner server not connected', HOWTO],
    'bad-token': ['bad', 'Owner link expired', `Open the link printed by the owner server again. ${HOWTO}`],
    origin: ['bad', 'Wrong dashboard address', `Open the dashboard at http://localhost:8765 (this page is ${location.origin}).`],
    offline: ['bad', 'Owner server offline', `Nothing answers at ${OWNER_API}. ${HOWTO}`],
    'mainnet-off': ['bad', 'Mainnet actions off', `The owner server runs without mainnet. ${HOWTO}`],
    ready: ['ok', 'Connected', 'Every owner transaction still needs your approval in BSV Desktop.']
  })[S.owner.state];

  const JOB_TITLE = { fund: (j) => `Owner funds the vault · ${group(j.sats ?? 0)} sats`, exit: () => 'Owner exit', cycle: (j) => `Agent run${j.intentId ? ` · intent ${j.intentId}` : ''}`, refusal: (j) => `Replay of intent ${j.intentId}` };
  const JOB_MARK = { done: '✓', failed: '✕', skipped: '–', todo: '', running: '' };
  // Each server step as one node of the live stepper: a short title, the chain it happens on.
  const STEP_UI = {
    fund: ['Owner funds the vault', 'bsv', 'BSV'],
    intent: ['Signed price → limit', 'api3', 'API3 · Base'],
    withdraw: ['Watcher co-signs · vault pays', 'bsv', 'BSV'],
    buy: ['AI agent pays for data', 'bsv', 'HTTP 402'],
    settle: ['Recorded on Base', 'base', 'Base'],
    refusal: ['Replay refused', 'watcher', 'Watcher'],
    exit: ['Owner takes it back', 'bsv', 'BSV']
  };
  const jobView = (j) => {
    const steps = j.steps || [];
    return h('div', { class: `owner-job owner-job-${j.state}`, role: 'status' },
      h('p', { class: 'owner-job-title' }, j.state === 'running' ? h('span', { class: 'breath', 'aria-hidden': 'true' }) : null,
        (JOB_TITLE[j.kind] || (() => j.kind))(j), h('span', { class: 'muted' }, j.state === 'running' ? ' · live' : ` · ${j.state}`)),
      h('ol', { class: `stepper stepper-${steps.length}` }, steps.map((st) => {
        const [title, chain, label] = STEP_UI[st.key] || [st.label, 'watcher', ''];
        const msg = st.state === 'todo' ? '' : String(st.message || '');
        return h('li', { class: `sp sp-${chain} sp-${st.state}`, title: st.label },
          h('span', { class: 'sp-dot', 'aria-hidden': 'true' }, JOB_MARK[st.state] ?? ''),
          h('p', { class: 'sp-title' }, title, h('span', { class: 'sr-only' }, ` (${st.state})`)),
          label ? tag(chain, label) : null,
          msg ? h('p', { class: 'sp-msg', title: msg }, msg.length > 90 ? `${msg.slice(0, 88)}…` : msg) : null,
          st.txid && TXID.test(st.txid) ? h('p', { class: 'step-link' }, wocTx(st.txid)) : null,
          st.baseTx && HASH.test(st.baseTx) ? h('p', { class: 'step-link' }, baseTx(st.baseTx)) : null);
      })));
  };

  // The live demo panel: real transactions, started here, every step shown as it lands.
  const renderAgentBar = () => {
    const el = $('#agent-controls');
    const o = S.owner;
    if (!ownerToken) { el.hidden = true; return; }
    el.hidden = false;
    const ready = o.state === 'ready';
    const busy = o.job?.state === 'running';
    const left = o.health?.agentCyclesLeft;
    const used = pipelineRows().find((r) => r.state === 'withdrawn');
    const vaultEmpty = S.vault.value && S.vault.value.total === 0n;
    const [tone, line, howto] = ownerStateLine();
    mount(el, stringify([o.state, o.job, left, used?.id, o.error, vaultEmpty]), () => [
      h('div', { class: 'agent-bar' },
        h('div', null,
          h('p', { class: 'agent-bar-title' }, 'Live demo', h('span', { class: `owner-state owner-state-${tone}`, title: howto || undefined }, h('span', { class: 'dot', 'aria-hidden': 'true' }), line)),
          h('p', { class: 'muted small' }, vaultEmpty ? 'The vault is empty: fund it first.' : 'Real BSV mainnet and Base Sepolia transactions.')),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', disabled: !ready || busy || undefined, title: 'BSV Desktop asks you to approve the deposit', onclick: () => ownerAction('/owner/fund', { sats: 5000 }) }, 'Fund 5,000 sats'),
          h('button', { type: 'button', class: 'btn btn-primary', disabled: !ready || busy || left === 0 || vaultEmpty || undefined, title: left !== undefined ? `${left} run${left === 1 ? '' : 's'} left on this server` : undefined, onclick: () => ownerAction('/agent/cycle', {}) }, 'Run the agent'),
          h('button', { type: 'button', class: 'btn', disabled: !ready || busy || !used || undefined, title: used ? `Ask the watcher to co-sign intent ${used.id} again` : 'No used intent yet', onclick: () => used && ownerAction('/agent/refusal', { intentId: used.id }) }, used ? `Replay #${used.id}` : 'Replay'))),
      o.error ? h('p', { class: 'owner-conn owner-conn-bad' }, o.error) : null,
      o.job && ['cycle', 'refusal', 'fund'].includes(o.job.kind) ? jobView(o.job) : null
    ]);
  };

  const renderOwnerTab = () => {
    const el = $('#tab-owner');
    const o = S.owner;
    const ready = o.state === 'ready';
    const busy = o.job?.state === 'running';
    const cap = o.health?.fundCap ?? 50000;
    const vault = S.vault.value;
    const [tone, line, howto] = ownerStateLine();
    const exits = S.hist.rows.filter((r) => r.kind === 'exit');
    mount(el, stringify([o, vault?.total, cap, exits]), () => {
      const fundSats = o.confirmFund;
      const status = h('p', { class: `owner-state owner-state-${tone}`, title: howto || undefined }, h('span', { class: 'dot', 'aria-hidden': 'true' }), line);
      return [
        h('div', { class: 'page-head', id: 'owner-head' },
          h('p', { class: 'kicker chain-kicker chain-bsv' }, h('span', { class: 'chain-dot' }), 'BSV · mainnet'),
          h('h2', null, 'Exit alone, any time.')),
        o.error ? h('p', { class: 'owner-conn owner-conn-bad' }, o.error) : null,
        o.job && (o.job.kind === 'fund' || o.job.kind === 'exit') ? jobView(o.job) : null,
        h('div', { class: 'grid-2', id: 'owner-main' },
          h('article', { class: 'card owner-card' },
            head('fund-title', 'Fund the vault', status),
            h('p', { class: 'card-sub' }, `Sends sats from BSV Desktop into the vault script, up to ${group(cap)} sats per deposit. BSV Desktop asks you to approve it.`),
            h('p', { class: 'big' }, h('span', { class: 'num' }, vault ? group(vault.total) : '—'), h('span', { class: 'unit' }, 'sats in the vault')),
            fundSats
              ? h('div', { class: 'owner-confirm' },
                h('p', null, `Send ${group(fundSats)} sats to the vault?`),
                h('div', { class: 'row' },
                  h('button', { type: 'button', class: 'btn btn-primary', disabled: !ready || busy || undefined, onclick: () => { S.owner.confirmFund = null; ownerAction('/owner/fund', { sats: fundSats }); } }, 'Yes, fund it'),
                  h('button', { type: 'button', class: 'btn', onclick: () => { S.owner.confirmFund = null; render(); } }, 'Cancel')))
              : h('form', { class: 'row', onsubmit: (e) => {
                e.preventDefault();
                const n = Number(new FormData(e.target).get('sats'));
                if (!Number.isSafeInteger(n) || n < 1 || n > cap) { S.owner.error = `Enter 1 to ${group(cap)} sats.`; render(); return; }
                S.owner.error = null; S.owner.confirmFund = n; render();
              } },
                h('label', { class: 'sr-only', for: 'fund-sats' }, 'Sats to deposit'),
                h('input', { id: 'fund-sats', name: 'sats', type: 'number', min: '1', max: String(cap), step: '1', value: '5000', inputmode: 'numeric', class: 'owner-input', disabled: !ready || busy || undefined }),
                h('button', { type: 'submit', class: 'btn btn-primary', disabled: !ready || busy || undefined }, 'Fund'))),
          h('article', { class: 'card owner-card owner-danger' },
            head('exit-title', 'Take everything back', status.cloneNode(true)),
            h('p', { class: 'card-sub' }, 'Sends every coin in the vault back to BSV Desktop, signed by the owner alone. Afterwards the agent cannot spend until the vault is funded again.'),
            h('p', { class: 'big' }, h('span', { class: 'num' }, vault ? group(vault.total) : '—'), h('span', { class: 'unit' }, 'sats back to you')),
            h('form', { class: 'row', onsubmit: (e) => {
              e.preventDefault();
              if (String(new FormData(e.target).get('confirm')).trim() !== 'EXIT') { S.owner.error = 'Type EXIT to confirm.'; render(); return; }
              ownerAction('/owner/exit', { confirm: 'EXIT' });
            } },
              h('label', { class: 'sr-only', for: 'exit-confirm' }, 'Type EXIT to confirm'),
              h('input', { id: 'exit-confirm', name: 'confirm', type: 'text', placeholder: 'Type EXIT', autocomplete: 'off', class: 'owner-input', disabled: !ready || busy || undefined }),
              h('button', { type: 'submit', class: 'btn btn-danger', disabled: !ready || busy || undefined }, 'Exit')))),
        h('section', { class: 'card card-wide', id: 'exit-proof' },
          head('exit-proof-title', 'Proven on mainnet', srcBadge('history', 'WhatsOnChain')),
          exits.length ? h('ul', { class: 'chain-proof' }, exits.map((x) => h('li', null,
            h('span', null, h('strong', null, `${group(x.out ?? 0n)} sats`), ' back to the owner · fee ', x.fee !== null ? group(x.fee) : '—', ' · owner key only'),
            h('span', null, wocTx(x.txid)))))
            : h('p', { class: 'state' }, S.history.status === 'error' ? 'Vault history unavailable.' : 'Reading…'))
      ];
    });
  };

  // ---------------------------------------------------------------- video mode: chapters
  // V toggles it. ← / → (or PageUp / PageDown) move between chapters; each opens its view, scrolls to the panel and
  // highlights it. C hides the captions. The captions name what is on screen; numbers in them are live.

  // Nine chapters for a 2:30 video, in the order the judging briefing asks for: the problem (0:00–0:20), the live core
  // flow (0:20–1:50), the partner technology and its proof (1:50–2:20), what comes next (2:20–2:30).
  const CHAPTERS = [
    { t: '0:00', tab: 'overview', target: '#overview-head', chain: 'watcher', label: 'Problem', title: 'A wallet key is a blank cheque',
      say: () => 'AI agents now pay for APIs and data on their own. Give one a key and one prompt injection empties the wallet. Treasury Guard gives it a dollar budget instead.' },
    { t: '0:15', tab: 'overview', target: '#lanes', chain: 'watcher', label: 'Design', title: 'API3 on Base decides, BSV holds and moves the money',
      say: () => { const v = S.vault.value; return `Signed prices and the daily budget live on Base Sepolia. ${v ? `${group(v.total)} sats sit` : 'The sats sit'} in a script on BSV mainnet that the agent cannot spend alone.`; } },
    { t: '0:25', tab: 'overview', target: '#run', chain: 'bsv', label: 'Live', title: 'The agent pays for data, end to end',
      say: () => 'The agent asks for budget with a fresh signed price. Live: limit on Base → the watcher checks and co-signs → sats leave the vault → the agent’s model decides and pays over HTTP 402 → recorded on Base.' },
    { t: '1:05', tab: 'overview', target: '#decisions-card', chain: 'watcher', label: 'Live', title: 'A replay is refused',
      say: () => 'The agent asks the watcher to sign the same intent again: refused with HTTP 409, nothing moves. Each limit pays out once.' },
    { t: '1:15', tab: 'api3', target: '#lab', chain: 'api3', label: 'API3', title: 'Tamper test: one valid, four rejected',
      say: () => { const l = labSummary(); return `The signed price must come from the CoinPaprika Airnode, for this request, within five minutes.${l.done ? ` Live result: ${l.validOk ? '1 valid' : 'valid case not fresh'}, ${l.rejected} of ${l.total} rejected.` : ''}`; } },
    { t: '1:45', tab: 'bsv', target: '#script-card', chain: 'bsv', label: 'BSV', title: 'Non-custodial: two keys, or the owner alone',
      say: () => 'The coin enforces agent AND watcher, or the owner alone. The watcher enforces the limit: it can block, never take.' },
    { t: '1:55', tab: 'owner', target: '#exit-proof', chain: 'bsv', label: 'BSV', title: 'The owner exits alone',
      say: () => { const x = S.hist.rows.find((r) => r.kind === 'exit'); return `One owner signature takes every coin back, with no agent, watcher or Base.${x ? ` Proven on mainnet: ${short(x.txid)}.` : ''}`; } },
    { t: '2:05', tab: 'bsv', target: '#costs', chain: 'bsv', label: 'BSV', title: 'Why BSV: payments cost less than they buy',
      say: () => { const w = median(S.hist.rows.filter((r) => r.kind === 'withdraw' && r.fee !== null).map((r) => r.fee)); const p = priceForUsd(); return `A vault withdrawal costs ${w !== null ? `${group(w)} sats${p ? ` (${approxUsd(w, p)})` : ''}` : 'a few dozen sats'}, so an agent can pay per call.`; } },
    { t: '2:20', tab: 'overview', target: '#guarantees', chain: 'watcher', label: 'Next', title: 'What comes next',
      say: () => 'Fund the vault from USDC on Base, k-of-n independent watchers, and live swaps at the signed rate.' }
  ];

  const isTyping = (t) => t && (t.closest('input, textarea, select, [contenteditable="true"]'));
  const setVideo = (on) => {
    S.video.on = on;
    document.documentElement.classList.toggle('video', on);
    $('#video-toggle').setAttribute('aria-pressed', String(on));
    $('#chapter-bar').hidden = !on || !S.video.captions;
    try { sessionStorage.setItem('tg.video', on ? '1' : '0'); } catch { /* storage unavailable */ }
    if (on) goChapter(S.video.i, true);
    renderChapterBar();
  };
  const spotlight = (el) => {
    el.classList.remove('spotlight');
    void el.offsetWidth;
    el.classList.add('spotlight');
    setTimeout(() => el.classList.remove('spotlight'), 2700);
  };
  const goChapter = (i, quiet) => {
    S.video.i = Math.max(0, Math.min(CHAPTERS.length - 1, i));
    const ch = CHAPTERS[S.video.i];
    if (currentTab() !== ch.tab) showTab(ch.tab);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = $(ch.target);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: el.offsetHeight > innerHeight * 0.75 ? 'start' : 'center' });
      if (!quiet) spotlight(el);
    }));
    renderChapterBar();
  };
  const renderChapterBar = () => {
    const bar = $('#chapter-bar');
    if (!S.video.on) return;
    const ch = CHAPTERS[S.video.i];
    const say = ch.say();
    mount(bar, stringify([S.video.i, say]), () => [
      // The suggested start times (ch.t) stay out of the picture: in an edited video they would not match the clock.
      h('span', { class: 'ch-count' }, `${S.video.i + 1}/${CHAPTERS.length}`),
      h('div', { class: 'ch-text', title: 'Click to show or hide the caption', onclick: () => bar.classList.toggle('compact') }, h('p', { class: 'ch-title' }, tag(ch.chain, ch.label), ch.title), h('p', { class: 'ch-say' }, say)),
      h('div', { class: 'ch-nav' },
        h('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': 'Previous chapter', disabled: S.video.i === 0 || undefined, onclick: () => goChapter(S.video.i - 1) }, '←'),
        h('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': 'Next chapter', disabled: S.video.i === CHAPTERS.length - 1 || undefined, onclick: () => goChapter(S.video.i + 1) }, '→')),
      h('div', { class: 'ch-dots', 'aria-hidden': 'true' }, CHAPTERS.map((_, i) => h('span', { class: i <= S.video.i ? 'on' : undefined })))
    ]);
  };
  const initVideo = () => {
    $('#video-toggle').addEventListener('click', () => setVideo(!S.video.on));
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      if (e.key === 'v' || e.key === 'V') { e.preventDefault(); setVideo(!S.video.on); return; }
      if (!S.video.on) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goChapter(S.video.i + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goChapter(S.video.i - 1); }
      else if (e.key === 'Escape') setVideo(false);
      else if (e.key === 'c' || e.key === 'C') { S.video.captions = !S.video.captions; $('#chapter-bar').hidden = !S.video.captions; }
      else if (/^[1-9]$/.test(e.key)) goChapter(Number(e.key) - 1);
    });
    const q = params.get('video');
    let on = q === '1';
    if (q === null) { try { on = sessionStorage.getItem('tg.video') === '1'; } catch { /* storage unavailable */ } }
    if (on) setVideo(true);
  };

  // ---------------------------------------------------------------- render loop and tick

  let pending = false;
  const render = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const rows = pipelineRows();
      const tab = currentTab();
      renderHeader();
      if (tab === 'overview') { renderLanes(rows); renderRun(rows); renderGuarantees(rows); renderDecisions(); renderAgentBar(); }
      if (tab === 'api3') { renderPrice(); renderLimit(); renderLab(); renderBreaker(); renderNews(); renderOracle(); }
      if (tab === 'bsv') { renderScript(); renderVault(); renderWithdrawals(); renderHistory(); renderCosts(rows); renderPayments(rows); }
      if (tab === 'owner') renderOwnerTab();
      if (tab === 'evidence') { renderPipeline(rows); renderTrust(); }
      renderFooter();
      renderChapterBar();
      paint();
    });
  };
  // Explanatory paragraphs stay in the page but out of sight: their text moves into an (i) next to the card title.
  const tuckExplanations = () => {
    for (const el of document.querySelectorAll('.card-sub, .note, .attack-what, .why')) {
      if (el.hidden) continue;
      const box = el.closest('.attack-result') || el.closest('.attack, .card, .lane');
      const anchor = el.classList.contains('why') ? box : box?.querySelector('.card-head h3, h4, .lane-head h3');
      el.hidden = true;
      if (!anchor) continue;
      const text = el.textContent.trim();
      if (!text) continue;
      if (el.classList.contains('why')) { anchor.title = anchor.title ? `${anchor.title}\n${text}` : text; continue; }
      let info = anchor.querySelector(':scope > .info');
      if (!info) { info = h('span', { class: 'info', tabindex: '0', role: 'note' }, 'i'); anchor.append(info); }
      if (!(info.title || '').includes(text)) info.title = info.title ? `${info.title}\n\n${text}` : text;
      info.setAttribute('aria-label', info.title);
    }
  };
  // Widths, positions and relative times are set here instead of inline styles (CSP: style-src 'self').
  const paint = () => {
    tuckExplanations();
    for (const el of document.querySelectorAll('[data-w]')) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`;
    for (const el of document.querySelectorAll('[data-left]')) el.style.left = `${Math.max(0, Math.min(100, Number(el.dataset.left)))}%`;
    const now = Date.now() / 1000;
    for (const el of document.querySelectorAll('[data-ago-sec]')) {
      const t = Number(el.dataset.agoSec);
      el.textContent = `${el.dataset.prefix || ''}${dur(now - t)} ago`;
      el.title = new Date(t * 1000).toISOString();
    }
    for (const el of document.querySelectorAll('[data-elapsed-from]')) el.textContent = `running for ${dur(now - Number(el.dataset.elapsedFrom))}`;
    for (const el of document.querySelectorAll('[data-until-sec]')) {
      const left = Number(el.dataset.untilSec) - now;
      el.textContent = left > 0 ? `expires in ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : 'expired';
    }
    paintSrcBadges();
  };
  setInterval(() => { paint(); renderHeader(); }, 1000);

  // ---------------------------------------------------------------- tabs

  const TABS = ['overview', 'api3', 'bsv', 'owner', 'evidence'];
  const ALIAS = { agent: 'api3', hedges: 'api3' };
  const currentTab = () => TABS.find((t) => !$(`#tab-${t}`).hidden) || 'overview';
  const showTab = (name, focus) => {
    name = ALIAS[name] || name;
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
    if (name === 'api3') { fetchOtherRegimes(); logPoller?.now(); loadPosts(); }
    if (name === 'evidence') fetchEvidenceTx();
    if (name === 'owner' || name === 'overview') ownerCheck();
    window.scrollTo({ top: 0 });
    render();
  };
  const initTabs = () => {
    const list = $('.tabs');
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[role="tab"]');
      if (b) { showTab(b.id.replace('tab-btn-', '')); if (S.video.on) b.blur(); }
    });
    list.addEventListener('keydown', (e) => {
      if (S.video.on) return; // arrows move chapters in video mode
      const i = TABS.indexOf(currentTab());
      let n = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % TABS.length;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
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

  const initControls = () => {
    const stored = (() => { try { return localStorage.getItem('tg.theme'); } catch { return null; } })();
    const q = params.get('theme');
    const theme = q === 'dark' || q === 'light' ? q : stored || 'dark';
    const apply = (t) => {
      document.documentElement.dataset.theme = t;
      const b = $('#theme-toggle');
      b.setAttribute('aria-pressed', String(t === 'dark'));
      b.title = t === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
      $('.theme-label', b).textContent = t === 'dark' ? 'Light theme' : 'Dark theme';
    };
    apply(theme);
    $('#theme-toggle').addEventListener('click', () => {
      const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      apply(t);
      try { localStorage.setItem('tg.theme', t); } catch { /* storage unavailable */ }
    });
  };

  // ---------------------------------------------------------------- data loading

  const update = (key) => (r) => {
    const s = S[key];
    if (r.ok) { s.status = 'live'; s.okAt = r.at; s.error = null; s.retryInMs = 0; }
    else { s.status = 'error'; s.error = r.error; s.retryInMs = r.retryInMs; }
    render();
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (S.newDecisions.size) setTimeout(() => { S.newDecisions.clear(); sigs.delete($('#decisions-card')); render(); }, 2500);
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
    const full = S.basePolls++ % 3 === 0 || currentTab() !== 'overview';
    // The vaults' state first (price, budget, regime): it is what every view shows at the top.
    for (const [key, v] of [['v5', VAULT], ['v8', RUNNER]]) {
      if (!S.chain[key].config) S.chain[key].config = await base.getVaultConfig(v);
      const [lp, rg, rem] = await Promise.all([base.lastPrice(v), base.regime(v), base.remainingUsdToday(v)]);
      Object.assign(S.chain[key], { lastPrice: lp, regime: rg, remaining: rem });
    }
    render();
    // Then the intents, newest first; a failed read stops this pass but keeps what was read (the public RPC
    // answers HTTP 429 now and then).
    for (let i = count; i >= 1n; i--) {
      const id = i.toString();
      const known = S.chain.intents.get(id);
      if (known && known.settled) continue;
      if (known && !full && nowSec() >= known.expiry) continue;
      try { S.chain.intents.set(id, await base.getIntent(i)); } catch { break; }
    }
    if (currentTab() === 'api3') fetchOtherRegimes();
    for (const [id, i] of vaultIntents()) if (i.settled && !S.receipts.has(id)) readReceipt(i.bsvTxid.slice(2));
    return true;
  };

  let regimesBusy = false;
  const fetchOtherRegimes = async () => {
    if (regimesBusy) return;
    regimesBusy = true;
    try {
      for (const v of DEMO_HEDGE_VAULTS) S.chain.others[v.toString()] = await base.regime(v);
    } catch { /* shown as — until the next refresh */ } finally { regimesBusy = false; }
    render();
  };
  let postsBusy = false;
  const loadPosts = async () => {
    if (postsBusy || S.posts.size === EV.base.posts.accounts.length) return;
    postsBusy = true;
    try {
      for (const a of EV.base.posts.accounts) S.posts.set(a.handle, await base.isPostRequest(VAULT, a.requestHash));
    } catch { /* retried when the view opens again */ } finally { postsBusy = false; }
    render();
  };

  // Bounded log scan: the newest pages first, then forward from the last block read.
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
  const windowBlocks = async (headBlock) => {
    if (!S.logData.blocksPerWindow) {
      const back = 5000n;
      const [t1, t0] = await Promise.all([base.blockTimestamp(headBlock), base.blockTimestamp(headBlock - back)]);
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
    const headBlock = S.chain.block;
    const win = await windowBlocks(headBlock);
    const wanted = currentTab() === 'api3' ? win : (LOG_FIRST_PAGES * 200n < win ? LOG_FIRST_PAGES * 200n : win);
    if (S.logData.to === null || headBlock - S.logData.to > win) {
      S.logData.to = headBlock;
      S.logData.from = headBlock + 1n;
    } else if (headBlock > S.logData.to) {
      mergeLogs(await base.contractLogs(S.logData.to + 1n, headBlock));
      S.logData.to = headBlock;
    }
    const floor = headBlock - wanted + 1n;
    while (S.logData.from > floor) {
      const end = S.logData.from - 1n;
      const start = end - 199n > floor ? end - 199n : floor;
      mergeLogs(await base.contractLogs(start, end));
      S.logData.from = start;
      loadLabSource();
      render();
      if (S.logData.from > floor) await pause(LOG_PAGE_GAP_MS);
    }
    loadLabSource();
    return true;
  };

  // WhatsOnChain transactions: mined ones are kept for the session, unconfirmed ones re-read after 20 s.
  const getTx = async (txid) => {
    const cur = S.txJson.get(txid);
    const t = S.tx.get(txid);
    if (cur && (t?.state === 'mined' || Date.now() - (t?.at ?? 0) < 20000)) return cur;
    const tx = await woc.tx(txid);
    S.txJson.set(txid, tx);
    noteTx(txid, tx);
    return tx;
  };
  const noteTx = (txid, tx) => {
    const height = Number(tx?.blockheight);
    const conf = Number(tx?.confirmations);
    const mined = Number.isInteger(height) && height > 0 && Number.isFinite(conf) && conf >= 1;
    const t = Number(tx?.blocktime || tx?.time);
    S.tx.set(txid, { state: mined ? 'mined' : 'unconfirmed', height: mined ? height : null, at: Date.now(), time: Number.isFinite(t) && t > 0 ? t : null });
  };

  const loadVault = async () => {
    const r = await woc.scriptUnspent(WOC_SCRIPT_HASH);
    const list = Array.isArray(r?.result) ? r.result : Array.isArray(r) ? r : null;
    if (!list) throw new Error('unexpected WhatsOnChain answer');
    const utxos = list.filter((u) => TXID.test(u.tx_hash) && Number.isSafeInteger(u.value) && u.value >= 0);
    const total = utxos.filter((u) => !u.isSpentInMempoolTx).reduce((a, u) => a + BigInt(u.value), 0n);
    S.vault.value = { utxos, total };
    const known = new Set(S.receipts.values());
    for (const u of utxos) if (!known.has(u.tx_hash)) readReceipt(u.tx_hash);
    return true;
  };

  // Every transaction that touched the vault script, classified from the transactions themselves:
  //   withdraw: spends a vault coin with <watcherSig> <agentSig> OP_1 (and carries the TGv1 receipt)
  //   exit:     spends a vault coin with <ownerSig> OP_0
  //   fund:     pays the vault script without spending a vault coin
  // Fees are inputs minus outputs where every input is a known vault coin.
  const loadHistory = async () => {
    const r = await woc.scriptHistory(WOC_SCRIPT_HASH);
    const list = Array.isArray(r?.result) ? r.result : Array.isArray(r) ? r : null;
    if (!list) throw new Error('unexpected WhatsOnChain history answer');
    S.hist.ids = list.filter((x) => TXID.test(x?.tx_hash)).map((x) => ({ txid: x.tx_hash, height: Number(x.height) || 0 }));
    for (const { txid } of S.hist.ids) {
      if (!S.txJson.has(txid) || S.tx.get(txid)?.state !== 'mined') { await getTx(txid); render(); }
    }
    await classifyHistory();
    return true;
  };
  const classifyHistory = async () => {
    const txs = S.hist.ids.map(({ txid }) => [txid, S.txJson.get(txid)]).filter(([, t]) => t);
    // Find the vault script once, from any output that decodes as the vault template and hashes to the binding.
    if (!S.vaultScript) {
      for (const [, t] of txs) {
        for (const o of t.vout ?? []) {
          const hex = o?.scriptPubKey?.hex;
          const keys = hex ? C.decodeVaultScript(hex) : null;
          if (!keys) continue;
          const sha = await C.sha256Hex(hex).catch(() => null);
          if (sha === null || sha === EV.bsv.vaultScriptSha256) { S.vaultScript = { hex, keys, hashOk: sha === EV.bsv.vaultScriptSha256 }; break; }
        }
        if (S.vaultScript) break;
      }
    }
    const vhex = S.vaultScript?.hex;
    if (!vhex) return;
    const vaultOut = new Map(); // "txid:n" → sats
    for (const [txid, t] of txs) for (const o of t.vout ?? []) if (o?.scriptPubKey?.hex === vhex) vaultOut.set(`${txid}:${o.n}`, C.satsOf(o.value));
    const rows = [];
    for (const { txid, height } of S.hist.ids) {
      const t = S.txJson.get(txid);
      if (!t) continue;
      const ins = t.vin ?? [];
      const outs = t.vout ?? [];
      const vIns = ins.filter((i) => vaultOut.has(`${i.txid}:${i.vout}`));
      const paths = vIns.map((i) => C.unlockPath(i.scriptSig?.hex));
      const vOut = outs.filter((o) => o?.scriptPubKey?.hex === vhex).reduce((a, o) => a + (C.satsOf(o.value) ?? 0n), 0n);
      const outTotal = outs.reduce((a, o) => a + (C.satsOf(o.value) ?? 0n), 0n);
      const inTotal = vIns.reduce((a, i) => a + (vaultOut.get(`${i.txid}:${i.vout}`) ?? 0n), 0n);
      const allKnown = ins.length > 0 && vIns.length === ins.length;
      const fee = allKnown ? inTotal - outTotal : null;
      const rc = C.findReceipt(t);
      let kind = 'other';
      if (vIns.length && paths.every((p) => p === 'owner')) kind = 'exit';
      else if (vIns.length && (rc || paths.every((p) => p === 'cosign'))) kind = 'withdraw';
      else if (!vIns.length && vOut > 0n) kind = 'fund';
      const toAgent = kind === 'withdraw' ? outs.filter((o) => o?.scriptPubKey?.hex === EV.bsv.floatScript || o?.scriptPubKey?.hex === EV.bsv.earlierFloatScript).reduce((a, o) => a + (C.satsOf(o.value) ?? 0n), 0n) : null;
      const intentId = rc && rc.vaultId === VAULT ? rc.intentId.toString() : null;
      rows.push({ txid, height: height || Number(t.blockheight) || 0, kind, vaultOut: kind === 'fund' ? vOut : kind === 'withdraw' ? null : null, change: kind === 'withdraw' ? vOut : null, out: kind === 'exit' ? outTotal : null, toAgent, fee, intentId });
      if (intentId && !S.receipts.has(intentId)) readReceipt(txid);
    }
    rows.sort((a, b) => (b.height || 1e12) - (a.height || 1e12));
    S.hist.rows = rows;
  };

  const receiptTried = new Set();
  const readReceipt = async (txid) => {
    if (receiptTried.has(txid)) return;
    receiptTried.add(txid);
    try {
      const tx = await getTx(txid);
      const rc = C.findReceipt(tx);
      if (rc && rc.chainId === BigInt(EV.base.chainId) && rc.contract === EV.base.contract.toLowerCase() && rc.vaultId === VAULT) {
        const id = rc.intentId.toString();
        S.receipts.set(id, txid);
        for (const o of tx.vout ?? []) {
          const hex = o?.scriptPubKey?.hex;
          const payee = hex === EV.bsv.floatScript ? 'current' : EV.bsv.earlierFloatScript && hex === EV.bsv.earlierFloatScript ? 'earlier' : null;
          if (payee && Number.isFinite(o.value) && Number.isInteger(o.n)) {
            S.receiptOut.set(id, { sats: C.satsOf(o.value), vout: o.n, payee });
            break;
          }
        }
        render();
        if (S.receiptOut.has(id)) readPayment(id);
      }
    } catch { receiptTried.delete(txid); }
  };

  // The agent's HTTP 402 payment is the next spend of the float output. In every payment so far it has one input
  // (that output) and two outputs: output 0 pays the merchant, output 1 is change. Any other shape: no amount.
  const paymentBusy = new Set();
  const readPayment = async (id) => {
    const out = S.receiptOut.get(id);
    const txid = S.receipts.get(id);
    if (!out || !txid || paymentBusy.has(id)) return;
    const cur = S.payments.get(id);
    if (cur && (cur.state === 'spent' || Date.now() - cur.at < INTERVAL.tx / 2)) return;
    paymentBusy.add(id);
    try {
      let spender = null;
      try {
        const r = await woc.spentBy(txid, out.vout);
        spender = typeof r?.txid === 'string' && TXID.test(r.txid) ? r.txid : null;
        if (!spender) throw new Error('unexpected /spent answer');
      } catch (e) {
        if (e.status === 404) { S.payments.set(id, { state: 'unspent', txid: null, sats: null, fee: null, at: Date.now() }); return; }
        throw e;
      }
      const tx = await getTx(spender);
      const ins = tx?.vin ?? [];
      const outs = tx?.vout ?? [];
      const spendsIt = ins.some((i) => i?.txid === txid && i?.vout === out.vout);
      const first = outs.find((o) => o?.n === 0);
      const simple = spendsIt && ins.length === 1;
      const sats = simple && outs.length === 2 && Number.isFinite(first?.value) ? C.satsOf(first.value) : null;
      const fee = simple ? out.sats - outs.reduce((a, o) => a + (C.satsOf(o.value) ?? 0n), 0n) : null;
      S.payments.set(id, { state: 'spent', txid: spender, sats, fee, at: Date.now() });
    } catch (e) {
      S.payments.set(id, { state: 'error', txid: null, sats: null, fee: null, at: Date.now(), error: String(e.message || e) });
    } finally {
      paymentBusy.delete(id);
      render();
    }
  };

  const fetchTx = async (txid) => {
    if (!TXID.test(txid)) return;
    const cur = S.tx.get(txid);
    if (cur && cur.state === 'mined') return;
    if (cur && cur.state !== 'loading' && Date.now() - cur.at < INTERVAL.tx) return;
    if (!cur) S.tx.set(txid, { state: 'loading', at: Date.now() });
    try { await getTx(txid); }
    catch (e) { S.tx.set(txid, { state: e.status === 404 ? 'unknown' : 'error', at: Date.now(), error: String(e.message || e) }); }
    finally { render(); }
  };
  const coreTxids = () => {
    const ids = [];
    for (const id of S.receipts.values()) ids.push(id);
    for (const [, i] of vaultIntents()) if (i.settled) ids.push(i.bsvTxid.slice(2));
    for (const p of S.payments.values()) if (p.txid) ids.push(p.txid);
    return [...new Set(ids)];
  };
  const fetchCoreTx = async () => {
    for (const id of coreTxids()) await fetchTx(id);
    for (const id of S.receiptOut.keys()) await readPayment(id);
  };
  const fetchEvidenceTx = async () => { for (const id of coreTxids()) await fetchTx(id); };

  // ---------------------------------------------------------------- start

  let logPoller = null;
  let vaultPoller = null;
  let basePoller = null;
  let historyPoller = null;
  const start = () => {
    $('#run').addEventListener('click', (e) => {
      const b = e.target.closest('[data-run]');
      if (!b) return;
      const first = $('#run [data-run]');
      S.selectedRun = first && first.dataset.run === b.dataset.run ? null : b.dataset.run;
      render();
    });
    initControls();
    initTabs();
    initVideo();
    render();
    C.poll(loadHealth, INTERVAL.health, update('health'));
    C.poll(loadDecisions, INTERVAL.decisions, update('decisions'));
    basePoller = C.poll(loadBase, INTERVAL.base, update('base'), { maxBackoffMs: 30000 });
    setTimeout(() => { logPoller = C.poll(loadLogs, INTERVAL.logs, update('logs')); }, 2500);
    vaultPoller = C.poll(loadVault, INTERVAL.vault, update('vault'));
    setTimeout(() => { historyPoller = C.poll(loadHistory, INTERVAL.history, update('history')); }, 1200);
    setTimeout(() => loadPosts(), 4000);
    setInterval(() => { if (ownerToken && S.owner.job?.state !== 'running') ownerCheck(); }, 5000);
    setTimeout(() => C.poll(fetchCoreTx, INTERVAL.tx, () => render()), 4000);
  };

  if (params.has('debug')) window.__tg = S;
  if (!EV || !C) {
    document.body.prepend(Object.assign(document.createElement('p'), { className: 'banner banner-warn', textContent: 'Dashboard files are missing (config.js or chain.js).' }));
    return;
  }
  start();
})();
