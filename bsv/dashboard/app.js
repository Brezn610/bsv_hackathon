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
  const LOG_MAX_PAGES = 60n; // the full ~30 min window: at most 60 eth_getLogs calls, only when the vault-8 tab is open
  const LOG_FIRST_PAGES = 10n; // first load: the newest 10 pages of 200 blocks only
  const LOG_PAGE_GAP_MS = 400; // pacing between log pages, so the public RPC never sees a burst

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
    receiptOut: new Map(), // intentId string → { sats, vout, payee: 'current'|'earlier' }: the float output of that withdrawal
    selectedRun: null, // null follows the newest run
    payments: new Map(), // intentId string → { state: 'unspent'|'spent'|'error', txid, sats, at }: next spend of the float output
    basePolls: 0,
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

  const LABEL = { live: 'Live', cached: 'Cached', unavailable: 'Unavailable', loading: 'Loading' };
  const freshness = (s) => {
    if (!s.okAt) return s.status === 'error' ? 'unavailable' : 'loading';
    if (s.status === 'error' || Date.now() - s.okAt > s.interval * 2.5) return 'cached';
    return 'live';
  };
  const badge = (kind, detail) => h('span', { class: `src src-${kind}` }, detail ? `${detail}, ${(LABEL[kind] ?? kind).toLowerCase()}` : LABEL[kind] ?? kind);
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
      el.textContent = kind === 'live' ? detail.replaceAll(' · ', ', ') : `${detail.replaceAll(' · ', ', ')} — ${LABEL[kind].toLowerCase()}`;
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
    // The ledger is the SPEND/BSV side: vault-5 SPEND intents only. Hedges (SWAP) are in the Event hedges view.
    for (const [id, i] of vaultIntents()) if (i.kind === 'SPEND') ids.add(id);
    for (const d of liveDecisions()) if (d.status === 200 && d.verdict === 'APPROVE' && /^\d+$/.test(String(d.intentId))) ids.add(String(d.intentId));
    for (const id of S.receipts.keys()) ids.add(id);
    const now = nowSec();
    return [...ids].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)).map((id) => {
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
        id, onChain, approval, txid, txSource, mismatch, maxSats, state,
        baseCreatedTx: logTx?.txHash || null,
        settled: onChain ? onChain.settled : false,
        settleTx: null,
        payment: S.payments.get(id) ?? null,
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
      text = 'Watcher connected';
      title = `Binding: ${hv.binding}. Clock skew: ${skew} s. Started ${hv.startedAt}. ${hv.decisions} decisions since start.`;
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
      if (last.status === 200) {
        const row = pipelineRows().find((r) => r.id === String(last.intentId));
        const paid = row?.payment?.state === 'spent' && row.payment.sats !== null;
        reach = paid ? 5 : row?.state === 'withdrawn' ? 4 : 2;
        caption = paid ? `Latest watcher decision: intent ${last.intentId} co-signed at ${clock(Date.parse(last.at))}; the float output was then spent: ${group(row.payment.sats)} sats paid over HTTP 402.`
          : row?.state === 'withdrawn' ? `Latest watcher decision: intent ${last.intentId} co-signed at ${clock(Date.parse(last.at))}; the withdrawal is on BSV, its float output is not spent yet.`
            : `Latest watcher decision: intent ${last.intentId} co-signed at ${clock(Date.parse(last.at))}. Approval alone does not establish broadcast or payment.`;
      }
      else { reach = 2; stop = 2; caption = `Latest live decision: intent ${last.intentId} refused (${last.status}) at ${clock(Date.parse(last.at))}. Nothing was signed.`; }
    } else {
      const latest = pipelineRows().find((r) => r.state === 'withdrawn');
      if (latest) {
        const paid = latest.payment?.state === 'spent' && latest.payment.sats !== null;
        reach = paid ? 5 : 4;
        caption = paid ? `Latest run: intent ${latest.id}, live from both chains. The next spend of its float output paid ${group(latest.payment.sats)} sats over HTTP 402.`
          : `Latest run: intent ${latest.id}, live from both chains. Its float output is not spent yet.`;
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
      h('li', { class: 'flow-caption' }, last ? srcBadge('decisions', 'watcher') : fromChain ? srcBadge('base', 'chain') : h('span', { class: 'muted' }, 'No activity loaded'), '. ', caption)
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
      const msg = S.base.status === 'error' ? 'No price loaded. Check the Base RPC in Connection details; retries are automatic.' : 'Waiting for signed-price data from Base Sepolia…';
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
        h('span', { class: `delta ${lp.change1h < 0n ? 'down' : 'up'}` }, ` ${lp.change1h < 0n ? 'down' : 'up'} ${pct(lp.change1h < 0n ? -lp.change1h : lp.change1h).replace('+', '')} 1 h`)),
      h('dl', { class: 'facts' },
        h('div', null, h('dt', null, 'Signed'), h('dd', null, h('span', { dataset: { agoSec: lp.signedAt.toString() } }))),
        h('div', null, h('dt', null, 'Observed'), h('dd', null, h('span', { dataset: { agoSec: lp.updatedAt.toString() } }))),
        h('div', null, h('dt', null, 'Observation to signature'), h('dd', null, h('span', null, dur(obs)), ' ', check(cfg && obs <= cfg.maxDataAge, `≤ ${cfg ? dur(cfg.maxDataAge) : '600 s'}`))),
        h('div', null, h('dt', null, 'Signature to acceptance'), h('dd', null, acc !== null ? [h('span', null, dur(acc)), ' ', check(acc <= cfg.maxSignatureAge, `≤ ${dur(cfg.maxSignatureAge)}`)] : h('span', { class: 'muted' }, 'n/a (price-only submission)')))),
      h('p', { class: 'small' }, 'Accepted ', createdAt !== null ? h('span', { dataset: { agoSec: createdAt.toString() } }, '') : h('span', { dataset: { agoSec: lp.signedAt.toString(), prefix: 'signed ' } }, ''),
        txHash ? [' in ', baseTx(txHash)] : null, match ? ` · created SPEND intent ${match.id}` : ''),
      h('p', { class: 'small' }, feed.name, ' Airnode ', baseAddr(feed.airnode), ' ', check(airOk && reqOk, airOk && reqOk ? 'signer and request match vault 5' : 'differs from the vault config')),
      h('p', { class: 'note' }, 'The contract requires a valid signature before creating a spending intent.')]);
  };
  const check = (ok, text) => h('span', { class: 'verification-note' }, ok ? 'Pass: ' : 'Check failed: ', text);

  const renderBudget = () => {
    const el = $('#budget-card');
    const v5 = S.chain.v5;
    const cfg = v5.config;
    const head = h('div', { class: 'card-head' }, h('h3', { id: 'budget-title' }, 'Daily budget'), srcBadge('base', 'Base Sepolia'));
    if (!cfg || v5.remaining === undefined) {
      const msg = S.base.status === 'error' ? 'No budget loaded. Check the Base RPC in Connection details; retries are automatic.' : 'Waiting for vault budget data…';
      mount(el, stringify(['b-empty', msg]), () => [head, h('p', { class: S.base.status === 'error' ? 'state state-error' : 'state' }, msg)]);
      return;
    }
    const rem = v5.remaining, daily = cfg.dailyBudgetUsd;
    const pctLeft = daily > 0n ? Number((rem * 1000n) / daily) / 10 : 0;
    mount(el, stringify([rem, daily, v5.regime, cfg]), () => [head,
      h('div', { class: 'budget-row' },
        h('p', { class: 'big' }, h('span', { class: 'num' }, usd6(rem)), h('span', { class: 'unit' }, ` left of ${usd6(daily)}`)),
        h('span', { class: `regime regime-${String(v5.regime).toLowerCase()}`, title: `Set by the contract from the signed 1 h change. Breaker ${pct(cfg.breakerBps)} enters RISK_OFF, re-entry ${pct(cfg.reentryBps)}, cooldown ${dur(cfg.cooldown)}, hedge caps ${fixed(cfg.breakerHedgeBps, 2, 0)} % / ${fixed(cfg.eventHedgeBps, 2, 0)} %.` }, String(v5.regime).toLowerCase().replaceAll('_', ' '))),
      h('div', { class: 'bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pctLeft), 'aria-label': 'Daily budget remaining' },
        h('span', { class: 'bar-fill bar-base', style: undefined, dataset: { w: String(pctLeft) } })),
      h('p', { class: 'muted small' }, `Spent today ${usd6(daily - rem)} · resets 00:00 UTC · intents expire after ${dur(cfg.intentTtl)}`),
      h('p', { class: 'small' }, h('a', { href: '#agent', class: 'link-tab', dataset: { tab: 'agent' } }, runnerLine()))]);
  };
  const runnerLine = () => {
    const lp = S.chain.v8.lastPrice;
    if (!lp || !lp.signedAt) return 'View agent activity in vault 8 (no BSV funds)';
    return `Autonomous runner (vault 8, no BSV funds): last signed price ${dur(Number(nowSec() - lp.signedAt))} ago`;
  };

  // ---------------------------------------------------------------- render: Enforce lane

  const STATUS = {
    200: ['ok', 'Approved'],
    409: ['warn', 'Already used'],
    422: ['bad', 'Policy refusal'],
    403: ['bad', 'Forged or missing agent signature'],
    400: ['neutral', 'Malformed request']
  };
  const decisionRow = (d, isNew) => {
    const [cls, label] = STATUS[d.status] || ['neutral', `HTTP ${d.status}`];
    const at = Date.parse(d.at);
    const reasons = Array.isArray(d.reasons) ? d.reasons.map(String) : [];
    return h('li', { class: `dec dec-${cls}${isNew ? ' is-new' : ''}` },
      h('div', { class: 'dec-top' },
        h('time', { datetime: d.at, title: d.at }, Number.isFinite(at) ? clock(at) : '—'),
        h('span', { class: 'dec-intent' }, `intent ${String(d.intentId)}`),
        h('span', { class: `status status-${cls}` }, `${d.status} ${label}`)),
      d.status === 200 && d.verdict === 'APPROVE'
        ? h('p', { class: 'dec-detail' }, h('span', { class: 'num' }, group(d.toFloat ?? 0)), ' sats to float; ', h('span', { class: 'num' }, group(d.change ?? 0)), ' change; ', h('span', { class: 'num' }, group(d.fee ?? 0)), ' fee. Vault input: ', h('span', { class: 'num' }, group(d.vaultIn ?? 0)), '.',
          d.proposalId ? h('span', { class: 'proposal mono', title: 'Txid of the transaction before unlocking scripts. It is not the final BSV txid.' }, ` · proposal ${short(String(d.proposalId))} (not the BSV txid)`) : null)
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
        if (live.length) list.append(...live.map((d) => decisionRow(d, S.newDecisions.has(decKey(d)))));
        else if (reached) list.append(h('li', { class: 'empty' }, 'No requests since the watcher started. Submit a withdrawal from your agent to see its decision here.'));
        else if (S.decisions.status === 'error') list.append(h('li', { class: 'empty empty-bad' }, `Watcher not reachable at ${CFG.watcher}. Start it with npm run tg -- watcher-serve.`));
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
      const msg = S.vault.status === 'error' ? 'No balance loaded. Check the WhatsOnChain connection; retries are automatic.' : 'Waiting for vault balance from WhatsOnChain…';
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
    const paid = observed.reduce((sum, r) => sum + r.chainOut.sats, 0n);
    const earlier = observed.filter((r) => r.chainOut.payee === 'earlier');
    const earlierSats = earlier.reduce((sum, r) => sum + r.chainOut.sats, 0n);
    const spent = observed.filter((r) => r.payment?.state === 'spent' && r.payment.sats !== null);
    const spentSats = spent.reduce((sum, r) => sum + r.payment.sats, 0n);
    const pending = observed.some((r) => !r.payment || r.payment.state === 'error');
    mount($('#flows-card'), stringify([paid, observed.length, earlierSats, spentSats, spent.length, pending]), () => [
      h('div', { class: 'card-head' }, h('h3', { id: 'flows-title' }, 'Paid to the agent')),
      h('p', { class: 'big' }, h('span', { class: 'num' }, observed.length ? group(paid) : '—'), observed.length ? h('span', { class: 'unit' }, ' sats') : null),
      h('p', { class: 'muted small' }, observed.length
        ? `Out of the vault in ${observed.length} observed BSV withdrawals${earlier.length ? `, including ${group(earlierSats)} sats to the earlier float (agent wallet)` : ''}.`
        : 'No withdrawal into the float has been read from BSV.'),
      h('h4', null, 'Spent over HTTP 402'),
      h('p', { class: 'big' }, h('span', { class: 'num' }, spent.length ? group(spentSats) : '—'), spent.length ? h('span', { class: 'unit' }, ' sats') : null),
      h('p', { class: 'muted small' }, spent.length
        ? `${spent.length} payments: the next spend of each float output, read from WhatsOnChain${pending ? '; still checking the rest' : ''}.`
        : pending ? 'Checking whether the float outputs have been spent…' : 'No float output has been spent yet.'),
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
    const txSig = rows.map((r) => [r.txid, S.tx.get(r.txid)?.state, r.payment, r.payment?.txid ? S.tx.get(r.payment.txid)?.state : null]);
    const sig = stringify([rows.map((r) => [r.id, r.state, r.txid, r.mismatch, r.settled, r.maxSats, r.approval, r.baseCreatedTx, r.onChain?.expiry, r.chainOut]), txSig, S.base.okAt > 0]);
    mount(el, sig, () => {
      const head = h('div', { class: 'card-head' },
        h('h3', { id: 'pipeline-title' }, 'Transaction ledger', h('span', { class: 'muted' }, ' · vault 5 only')),
        h('span', { class: 'head-badges' }, srcBadge('base', 'Base'), ' ', badge(txFreshness(rows), 'tx status: WhatsOnChain')));
      const sub = h('p', { class: 'muted' }, 'Compare each observed withdrawal with its intent limit (outflow includes the fee). A Base settle is a record written by the API3 agent, not cross-chain proof.');
      const table = h('table', { class: 'pipe' },
        h('caption', { class: 'sr-only' }, 'Vault 5 SPEND intents and what happened to each'),
        h('thead', null, h('tr', null, ['Intent', 'Limit, sats', 'Watcher', 'BSV transaction', 'Outflow / limit, sats', 'HTTP 402', 'Base settlement'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows.length ? rows.map(pipeRow) : h('tr', null, h('td', { colspan: '7', class: 'empty' }, 'No intents loaded for vault 5. Check the Base connection in Connection details.'))));
      return [head, sub, h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Scrollable transaction table' }, table)];
    });
  };
  const paymentCell = (r) => {
    if (!r.chainOut) return h('span', { class: 'muted small' }, '—');
    const p = r.payment;
    const earlier = r.chainOut.payee === 'earlier';
    if (!p) return h('span', { class: 'muted small' }, 'checking…');
    if (p.state === 'error') return h('span', { class: 'bad small' }, 'WhatsOnChain unavailable, retrying');
    if (p.state === 'unspent') return h('span', { class: 'muted small' }, earlier ? 'agent-wallet output not spent yet' : 'float output not spent yet');
    return [wocTx(p.txid), ' ', txState(p.txid),
      p.sats !== null ? h('span', { class: 'num block' }, `${group(p.sats)} sats paid`) : h('span', { class: 'muted small block' }, 'amount not derivable from this transaction’s shape'),
      h('span', { class: 'muted small block' }, earlier ? 'next spend of the agent-wallet output' : 'next spend of the float output (the agent’s HTTP 402 payment)')];
  };
  const pipeRow = (r) => {
    const [cls, label] = STATE_LABEL[r.state];
    const outflow = r.approval ? BigInt(r.approval.toFloat ?? 0) + BigInt(r.approval.fee ?? 0) : null;
    const share = outflow !== null && r.maxSats ? Number((outflow * 1000n) / r.maxSats) / 10 : null;
    const usd = r.onChain && r.maxSats ? approxUsd(r.maxSats, r.onChain.price) : null;
    let watcherCell;
    if (r.approval) watcherCell = [h('span', { class: 'status status-ok' }, 'Approved'), h('span', { class: 'muted small block' }, 'watcher response')];
    else if (r.state === 'withdrawn') watcherCell = [h('span', { class: 'status status-ok' }, 'Co-signed'), h('span', { class: 'muted small block', title: 'The vault pays out only with the agent’s and the watcher’s signatures, or the owner’s alone (which carries no TGv1 receipt).' }, 'shown by the payout')];
    else watcherCell = h('span', { class: 'muted small' }, r.state === 'swap' ? 'not eligible' : 'no approval seen');
    return h('tr', { class: `row-${cls}` },
      h('th', { scope: 'row' },
        h('span', { class: 'intent-id' }, `#${r.id}`), h('span', { class: 'intent-state' }, label),
        h('span', { class: 'small block' },
          r.state === 'open' ? h('span', { class: 'countdown', dataset: { untilSec: r.onChain.expiry.toString() } }, '') : null,
          r.state === 'open' && r.baseCreatedTx ? ' · ' : null,
          r.baseCreatedTx ? h('span', { class: 'nowrap' }, 'created ', baseTx(r.baseCreatedTx)) : null)),
      h('td', { class: 'num', title: r.onChain ? `Signed price ${price8(r.onChain.price)} per BSV` : '' }, r.maxSats !== null ? group(r.maxSats) : '—',
        usd ? h('span', { class: 'muted small block' }, usd) : null),
      h('td', null, watcherCell),
      h('td', null, r.txid ? [wocTx(r.txid), h('span', { class: 'muted small' }, ` via ${r.txSource}`), h('span', { class: 'block' }, txState(r.txid))] : h('span', { class: 'muted' }, '—'),
        r.mismatch ? h('span', { class: 'bad small block' }, 'Settlement record differs from the BSV receipt') : null),
      h('td', null, outflow !== null && r.maxSats ? [
        h('span', { class: 'num', title: `${group(r.approval.toFloat)} to float + ${group(r.approval.fee)} fee` }, `${group(outflow)} / ${group(r.maxSats)}`),
        h('span', { class: 'bar bar-sm', role: 'img', 'aria-label': `${share} % of the limit used` }, h('span', { class: `bar-fill ${share <= 100 ? 'bar-ok' : 'bar-bad'}`, dataset: { w: String(Math.min(share, 100)) } }))
      ] : r.chainOut ? (r.chainOut.payee === 'earlier'
        ? [h('span', { class: 'num' }, `paid ${group(r.chainOut.sats)} sats`), h('span', { class: 'muted small block' }, 'to the earlier float (agent wallet), before rebind-float')]
        : [h('span', { class: 'num' }, `${group(r.chainOut.sats)} to float`), h('span', { class: 'muted small block' }, 'read from the BSV tx · fee not shown')])
        : h('span', { class: 'muted' }, '—')),
      h('td', null, paymentCell(r)),
      h('td', null, r.settled === true
        ? h('span', { class: 'status status-info' }, 'record on Base')
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
                h('div', null, h('dt', null, 'Observation to signature'), h('dd', null, dur(lp.signedAt - lp.updatedAt), ' ', check(cfg && lp.signedAt - lp.updatedAt <= cfg.maxDataAge, 'limit 600 s')))),
              h('p', { class: active ? 'ok small' : 'warnc small' }, active ? 'Runner active: a price was accepted in the last 25 min.' : 'Runner idle: no accepted price in the last 25 min.')
            ] : h('p', { class: 'state' }, S.base.status === 'error' ? 'Base RPC unavailable.' : 'Reading vault 8…')),
          h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Budget and regime'), srcBadge('base', 'Base Sepolia')),
            cfg && v8.remaining !== undefined ? [
              h('p', { class: 'big' }, h('span', { class: 'num' }, usd6(v8.remaining)), h('span', { class: 'unit' }, ` left of ${usd6(cfg.dailyBudgetUsd)}`)),
              h('p', null, h('span', { class: `regime regime-${String(v8.regime).toLowerCase()}` }, String(v8.regime).toLowerCase().replaceAll('_', ' '))),
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
          prices.length ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Scrollable transaction table' }, h('table', { class: 'pipe' },
            h('thead', null, h('tr', null, ['Signed', 'Price', '1 h change', 'Spend intent', 'Base tx'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, prices.slice(0, 20).map((p) => {
              const it = logIntents.get(p.txHash);
              return h('tr', null, h('td', null, dateTime(Number(p.signedAt) * 1000)), h('td', { class: 'num' }, price8(p.price)), h('td', { class: 'num' }, pct(p.change1h)),
                h('td', null, it ? `#${it.intentId} · ${group(it.maxSats)} sats` : h('span', { class: 'muted' }, 'price only')), h('td', null, baseTx(p.txHash)));
            }))))
            : S.logData.from !== null && S.logData.from <= S.logData.to ? h('p', { class: 'empty' }, 'No vault-8 price was accepted in this window yet.') : null)
      ];
    });
  };

  // ---------------------------------------------------------------- render: hedges tab

  const DEMO_HEDGE_VAULTS = (EV.base.demoHedgeVaults || []).map((v) => BigInt(v));
  const vaultLabel = (v) => {
    if (v === VAULT) return 'team vault';
    if (DEMO_HEDGE_VAULTS.includes(v)) return 'demo copy of vault 5 (no BSV behind it)';
    if (v === BigInt(EV.base.judgeVaultId)) return 'judge vault (video)';
    if (v === BigInt(EV.base.liveJudgeVaultId)) return 'judge vault (live judging)';
    if (v === RUNNER) return 'API3 runner (no BSV funds)';
    return 'retired vault';
  };
  const DIRECTION = { SATS_TO_DUSD: 'sats → dUSD (hedge)', DUSD_TO_SATS: 'dUSD → sats (re-entry)', NONE: '—' };
  // The Event hedges view covers vault 5 and its demo copies only.
  const HEDGE_VAULTS = [VAULT, ...DEMO_HEDGE_VAULTS];
  const regimeVaults = () => HEDGE_VAULTS;
  const regimeOf = (v) => (v === VAULT ? S.chain.v5.regime : v === RUNNER ? S.chain.v8.regime : S.chain.others[v.toString()]);

  const renderHedgesTab = () => {
    const el = $('#tab-hedges');
    const all = [...S.chain.intents.entries()];
    // Event hedges only: SWAP intents with source EVENT, on vault 5 or its demo copies (9-12), newest first.
    const hedges = all.filter(([, i]) => i.kind === 'SWAP' && i.source === 'EVENT' && HEDGE_VAULTS.includes(i.vaultId))
      .sort(([a], [b]) => (BigInt(b) > BigInt(a) ? 1 : -1));
    const regimes = regimeVaults().map((v) => [v.toString(), regimeOf(v)]);
    const sig = stringify([all.length, hedges, regimes, hedges.map(([id]) => S.logData.intentTx.get(id)?.txHash)]);
    mount(el, sig, () => [
      h('h2', { class: 'tab-title' }, 'Event hedges'),
      h('p', { class: 'lede small' }, 'A signed post from a whitelisted account, with a fresh signed price, can move a vault to GUARDED and create a SWAP hedge of at most 25 %. Shown here: event hedges (SWAP, source EVENT) on vault 5 and on vaults 9–12, demo copies of vault 5 where the API3 side hedges while SPEND intents stay on vault 5. The watcher never co-signs SWAP intents, so hedges move no BSV.'),
      h('div', { class: 'grid-2' },
        h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Event hedges · vaults 5, 9–12'), srcBadge('base', 'Base Sepolia')),
          !all.length ? h('p', { class: 'state' }, S.base.status === 'error' ? 'Base RPC unavailable.' : 'Reading intents…')
            : hedges.length ? h('ul', { class: 'plain small hedges' }, hedges.map(([id, i]) => {
              const tx = S.logData.intentTx.get(id)?.txHash;
              const open = nowSec() < i.expiry;
              return h('li', null,
                h('strong', null, `#${id} · vault ${i.vaultId}`), h('span', { class: 'muted' }, ` · ${vaultLabel(i.vaultId)}`),
                h('span', { class: 'block' }, `SWAP ${DIRECTION[i.direction] || i.direction} · at most ${fixed(i.maxBps, 2, 0)} % of the vault`),
                h('span', { class: 'block muted' }, `price band ${price8(i.minOut)} – ${price8(i.maxOut)} per BSV`),
                h('span', { class: 'block' }, open ? h('span', { class: 'countdown', dataset: { untilSec: i.expiry.toString() } }, '') : 'expired', tx ? [' · ', baseTx(tx)] : null));
            }))
              : h('p', { class: 'empty' }, `No event hedge on vault 5 or vaults 9–12 yet (${all.length} intents read). A new one appears here within about 20 s.`)),
        h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Regimes'), srcBadge('base', 'Base Sepolia')),
          h('ul', { class: 'plain' }, regimes.map(([v, r]) =>
            h('li', null, `Vault ${v} · ${vaultLabel(BigInt(v))} · `, r ? h('span', { class: `regime regime-${String(r).toLowerCase()}` }, r) : h('span', { class: 'muted' }, '—')))),
          h('p', { class: 'muted small' }, 'Read while this tab is open, every Base refresh.')))
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
      h('h2', { class: 'tab-title' }, 'Transaction references'),
      h('p', { class: 'lede small' }, 'Transactions discovered from connected sources. No bundled transaction history is included.'),
      h('section', { class: 'card card-wide' }, h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Scrollable transaction table' }, h('table', { class: 'pipe' },
        h('thead', null, h('tr', null, ['What', 'Network', 'Transaction', 'Status', 'Detail'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows.length ? rows.map((x) => h('tr', null, h('th', { scope: 'row' }, x.what), h('td', null, x.net), h('td', null, x.txid ? wocTx(x.txid) : baseTx(x.base)),
          h('td', null, x.txid ? txState(x.txid) : h('span', { class: 'muted small' }, 'see Basescan')), h('td', { class: 'small' }, x.detail))) : h('tr', null, h('td', { colspan: '5', class: 'empty' }, 'No transactions loaded. Waiting for connected sources.')))))),
      h('p', { class: 'muted small' }, 'Sources: Base Sepolia contract events and WhatsOnChain transaction responses.')
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
      h('p', { class: 'muted small' }, 'Sources: watcher ', h('span', null, CFG.watcher), ' · Base RPC ', h('span', null, CFG.rpc), ' · ', h('span', null, CFG.woc))
    ]);
  };

  // ---------------------------------------------------------------- render: live run timeline
  // One vault-5 SPEND intent told as steps, from the data already polled: Base (price, intent, settle), the watcher's
  // decisions, WhatsOnChain (withdrawal, block, the float output's next spend). Times are when each step happened on
  // chain where known, otherwise when the dashboard saw it. Nothing here is inferred beyond what the sources return.
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
    const add = (key, title, state, time, detail, extra) => steps.push({ key, title, state, time, detail, extra });

    add('price', 'Signed price received', it ? 'done' : 'todo', it ? Number(it.priceSignedAt) : null,
      it ? `${price8(it.price)} per BSV, signed by the ${EV.base.feeds.bsvUsd.name} Airnode` : 'Waiting for a signed BSV/USD price');
    add('limit', 'Spending limit set on Base', it ? 'done' : 'todo', createdAt,
      it ? `Up to ${group(it.maxSats)} sats (${approxUsd(it.maxSats, it.price).replace('≈ ', '≈')})` : 'Waiting for a SPEND intent',
      it && open && !r.txid ? { until: Number(it.expiry) } : null);

    if (approve) add('watcher', 'Watcher checked the transaction', 'done', Date.parse(approve.at) / 1000,
      `Approved: ${group(approve.toFloat ?? 0)} sats to the agent, ${group(approve.fee ?? 0)} fee`);
    else if (refusal) add('watcher', 'Watcher refused', 'failed', Date.parse(refusal.at) / 1000,
      Array.isArray(refusal.reasons) && refusal.reasons.length ? String(refusal.reasons[0]) : `HTTP ${refusal.status}`);
    else if (r.txid) add('watcher', 'Watcher checked the transaction', 'done', null, 'Co-signed: the vault can only pay out with the watcher’s signature');
    else if (it && open) add('watcher', 'Watcher checks the transaction', 'todo', null, 'Waiting for the agent to propose a withdrawal');
    else if (it) add('watcher', 'No withdrawal', 'failed', Number(it.expiry), 'The limit expired before a withdrawal was signed');
    else add('watcher', 'Watcher checks the transaction', 'todo', null, '');

    const payee = r.chainOut ? (earlier ? `${group(r.chainOut.sats)} sats to the earlier float (agent wallet)` : `${group(r.chainOut.sats)} sats to the agent’s float`) : null;
    if (r.txid && tx?.state === 'mined') add('vault', 'Money left the vault', 'done', tx.time ?? null, [payee, `mined in block ${group(tx.height)}`].filter(Boolean).join(' · '), { txid: r.txid });
    else if (r.txid && tx?.state === 'unconfirmed') add('vault', 'Money leaving the vault', 'current', tx.time ?? null, [payee, 'broadcast, waiting for a block…'].filter(Boolean).join(' · '), { txid: r.txid });
    else if (r.txid) add('vault', 'Money leaving the vault', 'current', null, 'Checking BSV…', { txid: r.txid });
    else if (approve) add('vault', 'Money leaving the vault', 'current', null, 'Waiting for the transaction to appear on BSV');
    else add('vault', 'Money leaves the vault', 'todo', null, '');

    if (pay?.state === 'spent') add('pay', 'Agent paid for data (HTTP 402)', 'done', payTx?.time ?? null,
      pay.sats !== null ? `${group(pay.sats)} sats paid from the float${payTx?.state === 'mined' ? ` · mined in block ${group(payTx.height)}` : ''}` : 'The float output was spent; the amount is not derivable', { txid: pay.txid });
    else if (earlier && pay?.state === 'unspent') add('pay', 'Agent pays for data (HTTP 402)', 'skipped', null, 'This run paid the earlier agent wallet; no payment came from that output');
    else if (r.txid && pay?.state === 'unspent') add('pay', 'Agent pays for data (HTTP 402)', 'current', null, 'Waiting for the agent to buy');
    else if (r.txid) add('pay', 'Agent pays for data (HTTP 402)', 'current', null, pay?.state === 'error' ? 'WhatsOnChain unavailable, retrying' : 'Checking the float output…');
    else add('pay', 'Agent pays for data (HTTP 402)', 'todo', null, '');

    if (it?.settled) add('settle', 'Recorded on Base', 'done', null, 'Written by the API3 agent; a record, not cross-chain proof');
    else if (r.txid) add('settle', 'Recorded on Base', 'current', null, 'Waiting for the API3 agent to record it');
    else add('settle', 'Recorded on Base', 'todo', null, '');

    // Only the first unfinished step "breathes"; later unfinished ones wait quietly.
    let seenCurrent = false;
    for (const s of steps) if (s.state === 'current') { if (seenCurrent) s.state = 'todo'; seenCurrent = true; }
    const failed = steps.some((s) => s.state === 'failed');
    const complete = !failed && steps.every((s) => s.state === 'done' || s.state === 'skipped');
    const status = failed ? 'stopped' : complete ? 'complete' : 'running';
    const times = steps.map((s) => s.time).filter((t) => Number.isFinite(t));
    const end = status === 'running' ? null : (times.length ? Math.max(...times) : null);
    const outflow = r.approval ? BigInt(r.approval.toFloat ?? 0) + BigInt(r.approval.fee ?? 0) : r.chainOut ? r.chainOut.sats : null;
    const summary = status === 'stopped' ? (refusal ? 'refused' : 'expired')
      : pay?.state === 'spent' && pay.sats !== null ? `paid ${group(pay.sats)} sats`
        : r.chainOut ? `${group(r.chainOut.sats)} to the agent` : 'in progress';
    return { id: r.id, steps, status, start: createdAt, end, outflow, outflowExact: !!r.approval, maxSats: r.maxSats, summary };
  };

  const STEP_MARK = { done: '✓', failed: '!', current: '', todo: '', skipped: '–' };
  const renderRun = (rows) => {
    const runs = rows.map(runModel);
    const listEl = $('#run-list');
    const tlEl = $('#run-timeline');
    if (!listEl || !tlEl) return;
    if (S.selectedRun && !runs.some((x) => x.id === S.selectedRun)) S.selectedRun = null;
    const sel = runs.find((x) => x.id === S.selectedRun) || runs[0] || null;
    const watching = freshness(S.health) === 'live';
    mount(listEl, stringify([runs.map((x) => [x.id, x.status, x.summary, x.start]), sel?.id]), () => runs.length
      ? runs.map((x) => h('li', null, h('button', { type: 'button', class: `run-item run-${x.status}`, 'aria-current': x === sel ? 'true' : undefined, dataset: { run: x.id } },
        h('span', { class: 'run-item-id' }, `#${x.id}`),
        h('span', { class: 'run-item-sum' }, x.status === 'running' ? 'in progress' : x.summary),
        x.start ? h('span', { class: 'run-item-when', dataset: { agoSec: String(x.start) } }, '') : null)))
      : h('li', { class: 'run-empty' }, S.base.status === 'error' ? 'Base not reachable' : 'Loading runs…'));
    mount(tlEl, stringify([sel, watching, runs[0]?.status]), () => {
      if (!sel) return h('p', { class: 'run-waiting' }, S.base.status === 'error' ? 'Base Sepolia is not reachable, so no run can be shown. Retrying.' : 'Reading the latest request from Base Sepolia…');
      const latest = sel === runs[0];
      const head = h('div', { class: 'run-head' },
        h('div', null,
          h('p', { class: 'run-kicker' }, latest ? (sel.status === 'running' ? 'Happening now' : 'Latest run') : 'Earlier run'),
          h('h3', { id: 'run-heading' }, `Intent ${sel.id}`, h('span', { class: `run-status run-status-${sel.status}` }, sel.status === 'running' ? 'in progress' : sel.status === 'complete' ? 'complete' : 'stopped'))),
        sel.start ? h('p', { class: 'run-clock' }, sel.status === 'running'
          ? h('span', { dataset: { elapsedFrom: String(sel.start) } }, '')
          : sel.end ? `took ${dur(sel.end - sel.start)}` : '') : null);
      const list = h('ol', { class: 'steps' }, sel.steps.map((s) => h('li', { class: `step step-${s.state}` },
        h('span', { class: 'step-dot', 'aria-hidden': 'true' }, STEP_MARK[s.state]),
        h('div', { class: 'step-body' },
          h('p', { class: 'step-title' }, s.title, h('span', { class: 'sr-only' }, ` (${s.state})`)),
          s.detail ? h('p', { class: 'step-detail' }, s.detail) : null,
          s.extra?.until ? h('p', { class: 'step-detail' }, h('span', { class: 'countdown', dataset: { untilSec: String(s.extra.until) } }, '')) : null,
          s.extra?.txid ? h('p', { class: 'step-link' }, wocTx(s.extra.txid)) : null),
        h('time', { class: 'step-time' }, Number.isFinite(s.time) ? clock(s.time * 1000) : ''))));
      const meter = sel.outflow !== null && sel.maxSats ? (() => {
        const share = Number((sel.outflow * 1000n) / sel.maxSats) / 10;
        return h('div', { class: 'run-meter' },
          h('p', null, h('span', { class: 'num' }, group(sel.outflow)), ` of ${group(sel.maxSats)} sats ${sel.outflowExact ? 'used, fee included' : 'paid to the agent'}`),
          h('span', { class: 'meter', role: 'img', 'aria-label': `${share} % of the limit` }, h('span', { class: 'bar-fill', dataset: { w: String(Math.min(share, 100)) } })));
      })() : null;
      const idle = latest && sel.status !== 'running'
        ? h('p', { class: 'run-waiting' }, h('span', { class: `breath${watching ? '' : ' breath-off'}`, 'aria-hidden': 'true' }), watching ? 'Waiting for the next request. The watcher is on.' : 'Waiting for the next request. The watcher is not reachable from this page.')
        : null;
      return [idle, head, list, meter];
    });
  };

  // ---------------------------------------------------------------- render loop and tick

  let pending = false;
  const render = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const rows = pipelineRows();
      renderHeader(); renderFlow(); renderPrice(); renderBudget(); renderDecisions(); renderVault(); renderFlows(rows); renderPipeline(rows); renderTrust(); renderRun(rows);
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
    for (const el of document.querySelectorAll('[data-elapsed-from]')) el.textContent = `running for ${dur(now - Number(el.dataset.elapsedFrom))}`;
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
    if (name === 'agent' && logPoller) logPoller.now();
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
    // Dark is the designed default; a saved choice or ?theme= still wins.
    const theme = q === 'dark' || q === 'light' ? q : stored || 'dark';
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
    const full = S.basePolls++ % 3 === 0 || currentTab() !== 'overview';
    for (let i = 1n; i <= count; i++) {
      const id = i.toString();
      const known = S.chain.intents.get(id);
      if (known && known.settled) continue;
      // Expired, unsettled intents change only through settle: re-read them every third poll.
      if (known && !full && nowSec() >= known.expiry) continue;
      const cached = cache.get(`${CACHE_NS}.intent.${id}`);
      if (!known && cached) { S.chain.intents.set(id, reviveIntent(cached)); continue; }
      // Unsettled intents are re-read: settle can still change them. Expired unsettled ones change only via settle.
      const it = await base.getIntent(i);
      S.chain.intents.set(id, it);
      if (it.settled) cache.set(`${CACHE_NS}.intent.${id}`, it);
    }
    for (const [key, v] of full ? [['v5', VAULT], ['v8', RUNNER]] : [['v5', VAULT]]) {
      const cfgKey = `${CACHE_NS}.config.${v}`;
      if (!S.chain[key].config) {
        const c = cache.get(cfgKey);
        S.chain[key].config = c ? reviveConfig(c) : await base.getVaultConfig(v);
        if (!c) cache.set(cfgKey, S.chain[key].config);
      }
      const [lp, rg, rem] = await Promise.all([base.lastPrice(v), base.regime(v), base.remainingUsdToday(v)]);
      Object.assign(S.chain[key], { lastPrice: lp, regime: rg, remaining: rem });
    }
    if (currentTab() === 'hedges') fetchOtherRegimes();
    // A settled vault-5 intent: read its BSV transaction for the receipt and float output.
    for (const [id, i] of vaultIntents()) if (i.settled && !S.receipts.has(id)) readReceipt(i.bsvTxid.slice(2));
    return true;
  };

  let regimesBusy = false;
  const fetchOtherRegimes = async () => {
    if (regimesBusy) return;
    regimesBusy = true;
    try {
      for (const v of regimeVaults()) if (v !== VAULT && v !== RUNNER) S.chain.others[v.toString()] = await base.regime(v);
    } catch { /* shown as — until the next refresh */ } finally { regimesBusy = false; }
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
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadLogs = async () => {
    if (!S.chain.block) throw new Error('waiting for the Base block number');
    const head = S.chain.block;
    const win = await windowBlocks(head);
    // The full ~30 min window is only needed for the vault-8 history; the overview needs recent intents only.
    const wanted = currentTab() === 'agent' ? win : (LOG_FIRST_PAGES * 200n < win ? LOG_FIRST_PAGES * 200n : win);
    if (S.logData.to === null || head - S.logData.to > win) {
      S.logData.to = head;
      S.logData.from = head + 1n;
    } else if (head > S.logData.to) {
      mergeLogs(await base.contractLogs(S.logData.to + 1n, head));
      S.logData.to = head;
    }
    // Extend backwards, newest page first and paced, until the wanted window is covered.
    const floor = head - wanted + 1n;
    while (S.logData.from > floor) {
      const end = S.logData.from - 1n;
      const start = end - 199n > floor ? end - 199n : floor;
      mergeLogs(await base.contractLogs(start, end));
      S.logData.from = start;
      render();
      if (S.logData.from > floor) await pause(LOG_PAGE_GAP_MS);
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
        // Intent 2 paid the earlier float (the agent wallet) before `tg rebind-float`.
        for (const o of tx.vout ?? []) {
          const hex = o?.scriptPubKey?.hex;
          const payee = hex === EV.bsv.floatScript ? 'current' : EV.bsv.earlierFloatScript && hex === EV.bsv.earlierFloatScript ? 'earlier' : null;
          if (payee && Number.isFinite(o.value) && Number.isInteger(o.n)) {
            S.receiptOut.set(id, { sats: BigInt(Math.round(o.value * 1e8)), vout: o.n, payee });
            break;
          }
        }
        render();
        if (S.receiptOut.has(id)) readPayment(id);
      }
    } catch { receiptTried.delete(txid); }
  };

  // The agent's HTTP 402 payment is the next spend of the float output: WhatsOnChain's /tx/<txid>/<n>/spent names the
  // spending transaction. In every payment so far it has one input (that output) and two outputs: output 0 pays the
  // merchant and output 1 is the wallet's change. Any other shape is shown without an amount.
  const paymentBusy = new Set();
  const readPayment = async (id) => {
    const out = S.receiptOut.get(id);
    const txid = S.receipts.get(id);
    if (!out || !txid || paymentBusy.has(id)) return;
    const cur = S.payments.get(id);
    if (cur && (cur.state === 'spent' || Date.now() - cur.at < INTERVAL.tx)) return;
    paymentBusy.add(id);
    try {
      let spender = null;
      try {
        const r = await woc.spentBy(txid, out.vout);
        spender = typeof r?.txid === 'string' && TXID.test(r.txid) ? r.txid : null;
        if (!spender) throw new Error('unexpected /spent answer');
      } catch (e) {
        if (e.status === 404) { S.payments.set(id, { state: 'unspent', txid: null, sats: null, at: Date.now() }); return; }
        throw e;
      }
      const tx = await woc.tx(spender);
      noteTx(spender, tx);
      const ins = tx?.vin ?? [];
      const outs = tx?.vout ?? [];
      const spendsIt = ins.some((i) => i?.txid === txid && i?.vout === out.vout);
      const first = outs.find((o) => o?.n === 0);
      const sats = spendsIt && ins.length === 1 && outs.length === 2 && Number.isFinite(first?.value) ? BigInt(Math.round(first.value * 1e8)) : null;
      S.payments.set(id, { state: 'spent', txid: spender, sats, at: Date.now() });
    } catch (e) {
      S.payments.set(id, { state: 'error', txid: null, sats: null, at: Date.now(), error: String(e.message || e) });
    } finally {
      paymentBusy.delete(id);
      render();
    }
  };

  const noteTx = (txid, tx) => {
    const height = Number(tx?.blockheight);
    const conf = Number(tx?.confirmations);
    const mined = Number.isInteger(height) && height > 0 && Number.isFinite(conf) && conf >= 1;
    const t = Number(tx?.blocktime || tx?.time);
    const entry = { state: mined ? 'mined' : 'unconfirmed', height: mined ? height : null, at: Date.now(), time: Number.isFinite(t) && t > 0 ? t : null };
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
    for (const p of S.payments.values()) if (p.txid) ids.push(p.txid);
    return [...new Set(ids)];
  };
  const fetchCoreTx = async () => {
    for (const id of coreTxids()) await fetchTx(id);
    for (const id of S.receiptOut.keys()) await readPayment(id); // unspent outputs are re-checked at most once a minute
  };
  const fetchEvidenceTx = async () => {
    for (const r of evidenceRows()) if (r.txid) await fetchTx(r.txid);
  };

  // ---------------------------------------------------------------- start

  let logPoller = null;
  const start = () => {
    $('#run-list')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-run]');
      if (!b) return;
      const first = $('#run-list [data-run]');
      S.selectedRun = first && first.dataset.run === b.dataset.run ? null : b.dataset.run;
      render();
    });
    initControls();
    initTabs();
    render();
    C.poll(loadHealth, INTERVAL.health, update('health'));
    C.poll(loadDecisions, INTERVAL.decisions, update('decisions'));
    C.poll(loadBase, INTERVAL.base, update('base'));
    // Logs wait for the first block number, then follow it; started a little later to spread the first requests.
    setTimeout(() => { logPoller = C.poll(loadLogs, INTERVAL.logs, update('logs')); }, 3000);
    C.poll(loadVault, INTERVAL.vault, update('vault'));
    setTimeout(() => C.poll(fetchCoreTx, INTERVAL.tx, () => render()), 1500);
  };

  if (!EV || !C) {
    document.body.prepend(Object.assign(document.createElement('p'), { className: 'banner banner-warn', textContent: 'Dashboard files are missing (config.js or chain.js).' }));
    return;
  }
  start();
})();
