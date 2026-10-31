// Explain mode: animated pop-ups that show what happens behind each step, for screen recordings. Presentation only.
// Off by default; on with ?explain=1 or the E key. It is passive: it listens to clicks and keys, reads text the page
// already shows, and draws its own pop-up. It never calls preventDefault or stopPropagation on the page's elements,
// never triggers an action, sends no request, holds no key and signs nothing. Numbers come from the page, or are
// labelled "Recorded example" with their transaction id.
'use strict';

(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const params = new URLSearchParams(location.search);
  const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => reduceMq.matches;

  let on = false;
  let modal = null; // the open pop-up
  let observer = null;
  let anims = [];

  // ---------------------------------------------------------------- recorded example (intent 9, 31 Oct 2026)
  // Checked on WhatsOnChain and Basescan; also in bsv/docs/evidence/RESULTS.md.
  const REC = {
    intent: '9', price: '$17.0219', usd: '$0.001', maxSats: '5,874', intentTx: '0x9da0d762…7a8d',
    toFloat: '5,774', fee: '42', outflow: '5,816', change: '36,967', vaultTx: 'e802c195…f6b5',
    paid: '1,000', http: 'HTTP 200 · data returned', payTx: 'ccb8dc18…431e', settleTx: '0xa23646e0…5eb6',
    replayAt: '08:55:46 UTC', exitBack: '2,960', exitFee: '40', exitTx: 'db5ca41c…d41e', fund: '5,000', fundTx: 'c1f97102…6ad4'
  };

  // ---------------------------------------------------------------- reading the page (text it already shows)

  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const node = (i) => document.querySelector(`#run li.pn[data-i="${i}"]`);
  const val = (i) => { const v = txt(node(i)?.querySelector('.pn-value')); return v && v !== '—' ? v : null; };
  const cap = (i) => txt(node(i)?.querySelector('.pn-cap')) || null;
  const txOf = (i) => {
    const a = node(i)?.querySelector('.pn-link a[href]');
    const m = a && /\/tx\/(0x)?([0-9a-fA-F]{64})/.exec(a.getAttribute('href'));
    return m ? `${m[2].slice(0, 8)}…${m[2].slice(-4)}` : null;
  };
  const firstNum = (s) => { const m = /([\d][\d,]*)/.exec(s || ''); return m ? m[1] : null; };
  const live = () => {
    const id = (/intent (\d+)/.exec(txt(document.getElementById('run-title'))) || [])[1] || null;
    const strip = txt(document.querySelector('#lanes .gate-strip'));
    const budget = /Daily budget \$([\d.]+) of \$([\d.]+)/.exec(strip);
    const watcherFailed = !!node(2)?.classList.contains('pn-failed');
    return {
      id,
      price: val(0),
      maxSats: firstNum(val(1)),
      usd: (/\$[\d.]+/.exec(cap(1) || '') || [])[0] || null,
      outflow: watcherFailed ? null : firstNum(val(2)),
      fee: watcherFailed ? null : (/\+ ([\d,]+) fee/.exec(cap(2) || '') || [])[1] || null,
      toFloat: firstNum(val(3)),
      vaultTx: txOf(3),
      paid: firstNum(val(4)),
      payCap: cap(4),
      payTx: txOf(4),
      settled: val(5) === 'settled',
      budgetLeft: budget ? `$${budget[1]}` : null,
      budgetOf: budget ? `$${budget[2]}` : null,
      budgetFrac: budget && Number(budget[2]) > 0 ? Math.max(0, Math.min(1, Number(budget[1]) / Number(budget[2]))) : null
    };
  };
  const SRC_LIVE = (id) => `Live · intent ${id} · numbers from this page`;
  const SRC_REC = (what) => `Recorded example · ${what}`;

  // ---------------------------------------------------------------- SVG and animation helpers

  const el = (tag, attrs, ...kids) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) n.setAttribute(k, String(v));
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  };
  const T = (x, y, s, cls, extra) => el('text', { x, y, class: cls || 'x-label', ...extra }, s);
  const g = (attrs, ...kids) => el('g', attrs, ...kids);
  // A positioned group: the outer keeps the SVG position, `mid` takes state changes (glow, dim, fade out) and `inner`
  // takes entrances (fade, rise, pop, fly), so two animations never fight over one property of one element.
  const at = (x, y, ...kids) => {
    const inner = g({}, ...kids);
    const mid = g({}, inner);
    const outer = g({ transform: `translate(${x} ${y})` }, mid);
    outer.inner = inner;
    outer.mid = mid;
    return outer;
  };
  const rr = (x, y, w, h, cls, r = 16) => el('rect', { x, y, width: w, height: h, rx: r, class: cls });

  const play = (target, frames, delay, duration = 600, easing = 'cubic-bezier(.2,.7,.2,1)') => {
    const a = target.animate(frames, { delay: reduced() ? 0 : delay, duration: reduced() ? 0 : duration, easing, fill: 'both' });
    anims.push(a);
    return a;
  };
  const inner = (n) => n.inner || n;
  const fade = (n, t, d = 500) => play(inner(n), [{ opacity: 0 }, { opacity: 1 }], t, d);
  const rise = (n, t, d = 600) => play(inner(n), [{ opacity: 0, transform: 'translate(0px, 14px)' }, { opacity: 1, transform: 'translate(0px, 0px)' }], t, d);
  const popIn = (n, t, d = 520) => {
    const i = inner(n);
    i.style.transformBox = 'fill-box';
    i.style.transformOrigin = 'center';
    return play(i, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1.06)', offset: 0.7 }, { opacity: 1, transform: 'scale(1)' }], t, d);
  };
  const mid = (n) => n.mid || n;
  const glow = (n, t, d = 700) => play(mid(n), [{ opacity: 0.35 }, { opacity: 1 }], t, d);
  const dim = (n, t, d = 500) => play(mid(n), [{ opacity: 1 }, { opacity: 0.3 }], t, d);
  const out = (n, t, d = 300) => play(mid(n), [{ opacity: 1 }, { opacity: 0 }], t, d);
  // A line or path drawn from start to end.
  const draw = (n, t, d = 700) => { n.setAttribute('pathLength', '1'); n.setAttribute('stroke-dasharray', '1'); return play(n, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], t, d, 'ease-in-out'); };
  // Something that travels from one point to another and fades out on arrival (hide: false keeps it there).
  const fly = (n, [x1, y1], [x2, y2], t, d = 900, hide = true) => play(inner(n), [
    { opacity: 0, transform: `translate(${x1}px, ${y1}px)` },
    { opacity: 1, transform: `translate(${x1}px, ${y1}px)`, offset: 0.08 },
    { opacity: 1, transform: `translate(${x2}px, ${y2}px)`, offset: hide ? 0.9 : 1 },
    ...(hide ? [{ opacity: 0, transform: `translate(${x2}px, ${y2}px)` }] : [])
  ], t, d, 'ease-in-out');
  const arrow = (x1, y1, x2, y2, cls) => {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const p = (r, da) => `${x2 - r * Math.cos(a + da)},${y2 - r * Math.sin(a + da)}`;
    return g({ class: cls }, el('line', { x1, y1, x2, y2, class: 'x-line' }), el('polygon', { points: `${x2},${y2} ${p(14, 0.42)} ${p(14, -0.42)}`, class: 'x-head' }));
  };

  // Role icons, keyholes, keys, coins, cards: the film's vocabulary.
  const glyph = (role) => {
    if (role === 'agent') return [rr(-16, -12, 32, 24, 'x-stroke', 7), el('circle', { cx: -6, cy: 0, r: 3.4, class: 'x-fill' }), el('circle', { cx: 6, cy: 0, r: 3.4, class: 'x-fill' })];
    if (role === 'watcher') return [el('path', { d: 'M-19 0 Q0 -15 19 0 Q0 15 -19 0Z', class: 'x-stroke' }), el('circle', { cx: 0, cy: 0, r: 5.5, class: 'x-fill' })];
    if (role === 'owner') return [el('circle', { cx: 0, cy: -7, r: 7, class: 'x-stroke' }), el('path', { d: 'M-14 15 Q0 -3 14 15', class: 'x-stroke' })];
    if (role === 'api3') return [el('path', { d: 'M-17 3 L-8 3 L-3 -11 L5 15 L9 3 L17 3', class: 'x-stroke' })];
    return [el('circle', { cx: 0, cy: 0, r: 10, class: 'x-stroke' })];
  };
  const roleIcon = (role, x, y, label, sub) => at(x, y,
    g({ class: `r-${role}` }, el('circle', { cx: 0, cy: 0, r: 34, class: 'x-ring' }), ...glyph(role)),
    T(0, 62, label, 'x-role', { 'text-anchor': 'middle' }),
    sub ? T(0, 86, sub, 'x-small', { 'text-anchor': 'middle' }) : null);
  const keyhole = (role, x, y) => at(x, y, g({ class: `r-${role}` },
    el('circle', { cx: 0, cy: 0, r: 34, class: 'x-ring x-hole-ring' }),
    el('circle', { cx: 0, cy: -6, r: 8.5, class: 'x-fill' }),
    el('path', { d: 'M-6 -1 L6 -1 L9.5 17 L-9.5 17Z', class: 'x-fill' })));
  // A key pointing right; its tip is at (56, 0).
  const key = (role) => at(0, 0, g({ class: `r-${role} x-key` },
    el('circle', { cx: 0, cy: 0, r: 11, class: 'x-stroke x-thick' }),
    el('line', { x1: 11, y1: 0, x2: 56, y2: 0, class: 'x-stroke x-thick' }),
    el('line', { x1: 42, y1: 0, x2: 42, y2: 10, class: 'x-stroke x-thick' }),
    el('line', { x1: 50, y1: 0, x2: 50, y2: 8, class: 'x-stroke x-thick' })));
  const turn = (k, t) => {
    const i = inner(k).firstChild;
    i.style.transformBox = 'fill-box';
    i.style.transformOrigin = 'center';
    return play(i, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(-.15)', offset: 0.5 }, { transform: 'scaleY(1)' }], t, 700, 'ease-in-out');
  };
  const coin = () => at(0, 0, el('circle', { cx: 0, cy: 0, r: 9, class: 'x-coin' }));
  const chip = (x, y, w, s, cls) => at(x, y, rr(0, -22, w, 34, `x-chip ${cls || ''}`, 17), T(w / 2, 1, s, 'x-chip-t', { 'text-anchor': 'middle' }));
  const verdict = (x, y, word, ok) => at(x, y, T(0, 0, `${ok ? '✓' : '✕'} ${word}`, ok ? 'x-ok' : 'x-bad'));

  // The vault card of the film: three keyholes, agent and watcher on top, the owner alone below.
  const VX = 360, VY = 130, VW = 360, VH = 320;
  const HOLE = { agent: [470, 265], watcher: [610, 265], owner: [540, 382] };
  const vaultCard = () => at(0, 0,
    rr(VX - 14, VY - 14, VW + 28, VH + 28, 'x-vault-halo', 34),
    rr(VX, VY, VW, VH, 'x-vault', 26),
    T(VX + VW / 2, VY + 46, 'VAULT · BSV MAINNET', 'x-caps x-bsv-t', { 'text-anchor': 'middle' }));
  const roles = () => ({ agent: roleIcon('agent', 120, 170, 'agent'), watcher: roleIcon('watcher', 120, 320, 'watcher'), owner: roleIcon('owner', 120, 480, 'owner') });

  // ---------------------------------------------------------------- scenes

  const SCENES = {
    price: {
      kicker: 'API3 · SIGNED AT THE SOURCE', kickerCls: 'k-api3',
      title: [['signed price', ''], [' → Base', 'tt-api3']],
      caption: 'A signature proves origin, not truth.',
      draw(root, d) {
        const L = d.live.price ? d.live : null;
        const price = L ? L.price : REC.price;
        const airnode = roleIcon('api3', 200, 300, 'API3 Airnode', 'CoinPaprika');
        const agent = roleIcon('agent', 600, 300, 'API3 agent', 'buys the price');
        const guard = at(0, 0, rr(900, 236, 250, 128, 'x-card x-card-api3'), T(1025, 290, 'TreasuryGuard', 'x-title-s', { 'text-anchor': 'middle' }), T(1025, 322, 'Base Sepolia', 'x-small', { 'text-anchor': 'middle' }));
        const data = at(0, 0, rr(90, 96, 220, 92, 'x-card'), T(200, 132, 'BSV/USD', 'x-small', { 'text-anchor': 'middle' }), T(200, 168, price, 'x-num', { 'text-anchor': 'middle' }));
        const sig = el('path', { d: 'M118 206 q14 -16 28 0 t28 0 t28 0 t28 0 t28 0 t28 0', class: 'x-sig' });
        const sigLabel = T(200, 236, 'signed with the Airnode’s key', 'x-small x-api3-t', { 'text-anchor': 'middle' });
        const pay = coin();
        const payLabel = T(400, 482, 'x402 · 0.001 aUSD per request', 'x-small', { 'text-anchor': 'middle' });
        const env = at(0, 0, rr(-34, -24, 68, 48, 'x-env', 8), el('path', { d: 'M-34 -22 L0 4 L34 -22', class: 'x-env-flap' }), el('circle', { cx: 0, cy: 10, r: 7, class: 'x-seal' }));
        const env2 = at(0, 0, rr(-34, -24, 68, 48, 'x-env', 8), el('path', { d: 'M-34 -22 L0 4 L34 -22', class: 'x-env-flap' }), el('circle', { cx: 0, cy: 10, r: 7, class: 'x-seal' }));
        const parts = ['request hash', 'timestamp', 'data', 'signature'].map((p, i) => chip(210 + i * 200, 556, 180, p, 'x-chip-api3'));
        root.append(airnode, agent, guard, data, sig, sigLabel, payLabel, pay, env, env2, ...parts);
        [airnode, agent, guard].forEach((n, i) => rise(n, 100 + i * 150));
        rise(data, 700);
        draw(sig, 1500, 900); fade(sigLabel, 1900);
        fly(pay, [560, 446], [240, 446], 2700, 1100); fade(payLabel, 2700);
        fly(env, [240, 262], [560, 262], 4000, 1100);
        fly(env2, [640, 262], [1025, 196], 5200, 1200, false);
        parts.forEach((p, i) => rise(p, 6400 + i * 180));
        return { ms: 7600, source: L ? SRC_LIVE(L.id) : SRC_REC(`intent ${REC.intent} · price ${REC.price} · Base tx ${REC.intentTx}`) };
      }
    },

    limit: {
      kicker: 'BASE SEPOLIA · TREASURYGUARD.submitPrice', kickerCls: 'k-api3',
      title: [['four checks', ''], [', then a limit', 'tt-api3']],
      caption: 'Only a fresh price signed by the vault’s Airnode can set a spending limit.',
      draw(root, d) {
        const L = d.live.price && d.live.maxSats && d.live.usd ? d.live : null;
        const v = L ? { id: L.id, price: L.price, usd: L.usd, maxSats: L.maxSats } : { id: REC.intent, price: REC.price, usd: REC.usd, maxSats: REC.maxSats };
        const env = at(0, 0, rr(40, 210, 190, 130, 'x-card x-card-api3'), T(135, 262, 'signed price', 'x-label', { 'text-anchor': 'middle' }), T(135, 298, v.price, 'x-num-s', { 'text-anchor': 'middle' }));
        const rows = ['Request hash = the vault’s feed', 'Signer = the vault’s Airnode', 'Signature age ≤ 5 min', 'Newer than the last price (no replay)'];
        const rowEls = rows.map((r, i) => at(0, 0, rr(270, 128 + i * 66, 600, 52, 'x-row', 12), T(292, 162 + i * 66, `${i + 1}`, 'x-step'), T(326, 162 + i * 66, r, 'x-label')));
        const ticks = rows.map((_, i) => verdict(752, 162 + i * 66, 'passed', true));
        const formula = at(0, 0, T(270, 440, 'maxSats = dollars ÷ signed price', 'x-small'), T(270, 482, `${v.usd} ÷ ${v.price} per BSV = ${v.maxSats} sats`, 'x-num-s'));
        // The daily budget ring only with the live value from the page; without it, no ring is drawn.
        const frac = d.live.budgetFrac;
        const ringBg = frac !== null ? el('circle', { cx: 1010, cy: 230, r: 84, class: 'x-ring-bg' }) : null;
        const ring = frac !== null ? el('circle', { cx: 1010, cy: 230, r: 84, class: 'x-ring-fg', transform: 'rotate(-90 1010 230)', pathLength: 1, 'stroke-dasharray': 1 }) : null;
        const ringText = frac !== null ? at(0, 0, T(1010, 232, d.live.budgetLeft, 'x-num-s', { 'text-anchor': 'middle' }), T(1010, 262, `left of ${d.live.budgetOf}`, 'x-small', { 'text-anchor': 'middle' }), T(1010, 350, 'daily budget, live', 'x-small', { 'text-anchor': 'middle' })) : null;
        const intent = at(0, 0, rr(880, 400, 290, 170, 'x-card x-card-api3'), T(902, 440, `SPEND intent #${v.id}`, 'x-title-s'), T(902, 478, `cap ${v.maxSats} sats`, 'x-num-s'), T(902, 512, 'valid 15 min', 'x-small'), T(902, 540, 'no BSV has moved yet', 'x-small'));
        root.append(env, ...rowEls, ...ticks, formula, intent);
        if (ring) root.append(ringBg, ring, ringText);
        rise(env, 100);
        rowEls.forEach((r, i) => { rise(r, 500 + i * 650); popIn(ticks[i], 900 + i * 650, 420); });
        rise(formula, 3500);
        if (ring) { play(ring, [{ strokeDashoffset: 0 }, { strokeDashoffset: 1 - frac }], 4100, 1300, 'ease-in-out'); fade(ringText, 4100); }
        popIn(intent, 5600, 650);
        return { ms: 7000, source: L ? SRC_LIVE(L.id) + (frac === null ? '' : ' · budget from the API3 strip') : SRC_REC(`intent ${REC.intent} · ${REC.usd} at ${REC.price} → ${REC.maxSats} sats · Base tx ${REC.intentTx}`) };
      }
    },

    watcher: {
      kicker: 'WATCHER · BEFORE IT SIGNS', kickerCls: 'k-watcher',
      title: [['the watcher checks', ''], [' the real bytes', 'tt-watcher']],
      caption: 'The watcher can block, never take.',
      draw(root, d) {
        const L = d.live.outflow && d.live.fee && d.live.maxSats ? d.live : null;
        const v = L ? { id: L.id, cap: L.maxSats, outflow: L.outflow, fee: L.fee } : { id: REC.intent, cap: REC.maxSats, outflow: REC.outflow, fee: REC.fee };
        const base = at(0, 0, rr(40, 70, 400, 104, 'x-card x-card-api3'), T(62, 108, 'TreasuryGuard · Base', 'x-label'), T(62, 146, `getIntent(${v.id}) → cap ${v.cap} sats`, 'x-mono-s'));
        const eye = roleIcon('watcher', 540, 120, 'watcher');
        const read = arrow(442, 122, 494, 122, 'a-watcher');
        const readLabel = T(610, 128, 'reads Base itself, one block behind', 'x-small');
        const card = at(0, 0, rr(40, 220, 700, 340, 'x-card'), T(62, 256, 'the proposed transaction, read byte by byte', 'x-small'));
        const rows = ['inputs: vault coins only', 'output 0 → the Agent Float, exactly one', 'output 1 → change to the same vault script', `output 2 → OP_RETURN receipt TGv1 … 5 ${v.id}`, `outflow + fee ≤ maxSats: ${v.outflow} ≤ ${v.cap}`, `fee ≤ 200 sats: ${v.fee}`];
        const rowEls = rows.map((r, i) => T(70, 300 + i * 44, r, i >= 4 ? 'x-mono-s' : 'x-label'));
        const ticks = rows.map((_, i) => verdict(630, 300 + i * 44, 'ok', true));
        const scan = rr(52, 274, 676, 36, 'x-scan', 8);
        const journal = at(0, 0, rr(770, 220, 400, 150, 'x-card x-card-watcher'), T(792, 256, 'journal on disk', 'x-small'), T(792, 300, `intent ${v.id}`, 'x-mono-s'));
        const reserved = at(0, 0, T(940, 300, 'reserved', 'x-mono-s x-watcher-t'), T(792, 340, 'written with fsync before signing', 'x-small'));
        const sign = at(0, 0, rr(770, 410, 400, 150, 'x-card x-card-watcher'), T(792, 452, 'co-signature', 'x-title-s'), T(792, 488, 'SIGHASH_ALL: this exact transaction', 'x-small'), T(792, 518, 'change one sat and it is invalid', 'x-small'));
        root.append(base, eye, read, readLabel, card, scan, ...rowEls, ...ticks, journal, reserved, sign);
        rise(base, 100); rise(eye, 250);
        draw(read.firstChild, 500, 500); fade(read.lastChild, 900, 200); fade(readLabel, 700);
        rise(card, 1100);
        play(scan, [{ opacity: 0, transform: 'translate(0px, 0px)' }, { opacity: 1, transform: 'translate(0px, 0px)', offset: 0.05 }, { opacity: 1, transform: 'translate(0px, 220px)', offset: 0.95 }, { opacity: 0, transform: 'translate(0px, 220px)' }], 1500, 3300, 'linear');
        rowEls.forEach((r, i) => { fade(r, 1300 + i * 120, 400); popIn(ticks[i], 1700 + i * 520, 380); });
        rise(journal, 5000); popIn(reserved, 5500, 500);
        rise(sign, 6400);
        return { ms: 7600, source: L ? SRC_LIVE(L.id) : SRC_REC(`intent ${REC.intent} · ${REC.toFloat} + ${REC.fee} fee ≤ ${REC.maxSats} · tx ${REC.vaultTx}`) };
      }
    },

    vault: {
      kicker: 'SPEND · AGENT + WATCHER TOGETHER', kickerCls: 'k-watcher',
      title: [['( agent AND watcher ) ', ''], ['OR owner', 'tt-owner']],
      caption: 'Both keys turn together. The owner’s keyhole is never needed for this, and never blocked.',
      draw(root, d) {
        const L = d.live.toFloat ? d.live : null;
        const v = L ? { id: L.id, toFloat: L.toFloat, change: null, tx: L.vaultTx } : { id: REC.intent, toFloat: REC.toFloat, change: REC.change, tx: REC.vaultTx };
        const r = roles();
        const card = vaultCard();
        const holes = { agent: keyhole('agent', ...HOLE.agent), watcher: keyhole('watcher', ...HOLE.watcher), owner: keyhole('owner', ...HOLE.owner) };
        const ka = key('agent'), kw = key('watcher');
        const ownerNote = T(540, 488, 'owner alone: always possible, not used here', 'x-small x-owner-t', { 'text-anchor': 'middle' });
        const float = at(0, 0, rr(860, 170, 300, 130, 'x-card x-card-bsv'), T(882, 208, 'AGENT FLOAT', 'x-caps'), T(882, 256, `+${v.toFloat} sats`, 'x-num'));
        const coins = [0, 1, 2, 3, 4].map(() => coin());
        const loop = el('path', { d: 'M720 330 C 820 330, 820 425, 724 425', class: 'x-path x-bsv-s' });
        const loopHead = el('polygon', { points: '722,425 738,416 738,434', class: 'x-head x-bsv-f' });
        const changeLabel = at(0, 0, T(830, 372, 'change → the same vault script', 'x-small'), v.change ? T(830, 404, `${v.change} sats`, 'x-mono-s') : null);
        const receipt = chip(860, 486, 300, `OP_RETURN · TGv1 … 5 ${v.id}`, 'x-chip-bsv');
        root.append(r.agent, r.watcher, r.owner, card, holes.agent, holes.watcher, holes.owner, ownerNote, float, loop, loopHead, changeLabel, receipt, ...coins, ka, kw);
        [r.agent, r.watcher, r.owner].forEach((n, i) => rise(n, 100 + i * 120));
        fade(card, 300); Object.values(holes).forEach((h, i) => popIn(h, 600 + i * 120, 400));
        fly(ka, [160, 170], [HOLE.agent[0] - 56, HOLE.agent[1]], 1300, 1300, false);
        fly(kw, [160, 320], [HOLE.watcher[0] - 56, HOLE.watcher[1]], 1300, 1300, false);
        dim(holes.owner, 900);
        turn(ka, 2800); turn(kw, 2800);
        glow(holes.agent, 3200); glow(holes.watcher, 3200);
        fade(ownerNote, 3300);
        rise(float, 3800);
        coins.forEach((c, i) => fly(c, [720, 265], [860, 235], 4000 + i * 170, 800));
        draw(loop, 5200, 800); fade(loopHead, 5900, 200); fade(changeLabel, 5600);
        rise(receipt, 6400);
        return { ms: 7600, source: L ? SRC_LIVE(L.id) + (L.vaultTx ? ` · tx ${L.vaultTx}` : '') : SRC_REC(`intent ${REC.intent} · tx ${REC.vaultTx}`) };
      }
    },

    fund: {
      kicker: 'DEPOSIT · FROM THE OWNER’S OWN WALLET', kickerCls: 'k-owner',
      title: [['( agent AND watcher ) ', ''], ['OR owner', 'tt-owner']],
      caption: 'You sign the deposit in BSV Desktop. This page holds no key.',
      draw(root, d) {
        const amount = d.ctx.amount || null;
        const r = roles();
        const card = vaultCard();
        const holes = { agent: keyhole('agent', ...HOLE.agent), watcher: keyhole('watcher', ...HOLE.watcher), owner: keyhole('owner', ...HOLE.owner) };
        const desk = T(120, 576, 'BSV Desktop · you approve', 'x-small x-owner-t', { 'text-anchor': 'middle' });
        const coins = [0, 1, 2, 3, 4, 5].map(() => coin());
        const plus = T(540, 506, amount ? `+${amount} sats` : 'deposit', 'x-num x-bsv-t', { 'text-anchor': 'middle' });
        const pair = at(0, 0, rr(800, 170, 360, 120, 'x-card x-card-watcher'), T(822, 210, 'agent + watcher together', 'x-label'), T(822, 246, 'only inside an API3 limit,', 'x-small'), T(822, 272, 'checked by the watcher', 'x-small'));
        const alone = at(0, 0, rr(800, 330, 360, 120, 'x-card x-card-owner'), T(822, 370, 'the owner alone', 'x-label x-owner-t'), T(822, 406, 'takes everything back,', 'x-small'), T(822, 432, 'any time, one transaction', 'x-small'));
        root.append(r.agent, r.watcher, r.owner, desk, card, holes.agent, holes.watcher, holes.owner, plus, pair, alone, ...coins);
        [r.agent, r.watcher, r.owner].forEach((n, i) => rise(n, 100 + i * 120));
        fade(card, 300); Object.values(holes).forEach((h, i) => popIn(h, 500 + i * 100, 400));
        glow(r.owner, 900); fade(desk, 1000);
        coins.forEach((c, i) => fly(c, [150, 470], [540, 300], 1600 + i * 180, 1000));
        popIn(plus, 2900, 500);
        glow(holes.agent, 4000); glow(holes.watcher, 4000); rise(pair, 4100);
        glow(holes.owner, 5300); rise(alone, 5400);
        return { ms: 6800, source: amount ? `Live · the deposit you just started (${amount} sats) · BSV Desktop asks you to approve it` : SRC_REC(`deposit of ${REC.fund} sats · tx ${REC.fundTx}`) };
      }
    },

    pay: {
      kicker: 'BSV · HTTP 402', kickerCls: 'k-bsv',
      title: [['pay per request', ''], [' · from the float', 'tt-bsv']],
      caption: 'The model proposes. The guardian’s rules decide.',
      draw(root, d) {
        const L = d.live.paid ? d.live : null;
        const noData = L && /HTTP (\d+), no data/.exec(L.payCap || '');
        const v = L ? { id: L.id, paid: L.paid, tx: L.payTx, end: noData ? `HTTP ${noData[1]} · paid, no data` : (L.payCap || '').includes('data returned') ? '200 OK · data' : 'answer' } : { id: REC.intent, paid: REC.paid, tx: REC.payTx, end: '200 OK · data' };
        const model = at(0, 0, rr(40, 80, 400, 110, 'x-card'), T(62, 118, 'the agent’s model', 'x-small'), T(62, 160, 'proposes a purchase: BUY or skip', 'x-label'));
        const guard = at(0, 0, rr(40, 230, 400, 300, 'x-card x-card-bsv'), T(62, 270, 'guardian · fixed rules', 'x-title-s'));
        const rules = ['merchant on the allowlist', 'price as declared', 'per-payment and daily caps'];
        const ruleEls = rules.map((r, i) => T(62, 330 + i * 56, r, 'x-label'));
        const ok = rules.map((_, i) => verdict(372, 330 + i * 56, 'ok', true));
        const lifeA = at(0, 0, el('line', { x1: 560, y1: 150, x2: 560, y2: 540, class: 'x-life' }), T(560, 120, 'agent float', 'x-label', { 'text-anchor': 'middle' }));
        const lifeM = at(0, 0, el('line', { x1: 1080, y1: 150, x2: 1080, y2: 540, class: 'x-life' }), T(1080, 120, 'paid API', 'x-label', { 'text-anchor': 'middle' }));
        const msgs = [
          [560, 1080, 210, 'GET the paid resource', 'a-muted'],
          [1080, 560, 290, `402 Payment Required · ${v.paid} sats`, 'a-bsv'],
          [560, 1080, 370, 'payment tx · input = the float output', 'a-bsv'],
          [1080, 560, 450, v.end, noData ? 'a-bad' : 'a-ok']
        ].map(([x1, x2, y, s, cls]) => ({ a: arrow(x1, y, x2, y, cls), t: T((x1 + x2) / 2, y - 14, s, 'x-small x-strong', { 'text-anchor': 'middle' }) }));
        const pay = coin();
        root.append(model, guard, ...ruleEls, ...ok, lifeA, lifeM, ...msgs.flatMap((m) => [m.a, m.t]), pay);
        rise(model, 100); rise(guard, 700);
        ruleEls.forEach((r, i) => { fade(r, 900 + i * 150); popIn(ok[i], 1300 + i * 500, 380); });
        fade(lifeA, 2900); fade(lifeM, 2900);
        msgs.forEach((m, i) => { draw(m.a.firstChild, 3400 + i * 900, 600); fade(m.a.lastChild, 3900 + i * 900, 150); fade(m.t, 3400 + i * 900, 400); });
        fly(pay, [570, 370], [1070, 370], 5200, 800);
        return { ms: 7400, source: L ? SRC_LIVE(L.id) + (L.payTx ? ` · tx ${L.payTx}` : '') : SRC_REC(`intent ${REC.intent} · ${REC.paid} sats, ${REC.http} · tx ${REC.payTx}`) };
      }
    },

    settle: {
      kicker: 'BASE · A RECORD', kickerCls: 'k-api3',
      title: [['settle(N, txid)', ''], [' on Base', 'tt-api3']],
      caption: 'Settle is a record, not a cross-chain proof.',
      draw(root, d) {
        const L = d.live.settled && d.live.vaultTx ? d.live : null;
        const v = L ? { id: L.id, tx: L.vaultTx } : { id: REC.intent, tx: REC.vaultTx };
        const woc = at(0, 0, rr(40, 120, 470, 320, 'x-card x-card-bsv'), T(62, 160, 'WhatsOnChain · BSV mainnet', 'x-small'), T(62, 198, `tx ${v.tx}`, 'x-mono-s'));
        const outs = ['0 → Agent Float', '1 → change to the vault', `2 → OP_RETURN TGv1 84532 0x8e38…7773 5 ${v.id}`].map((s, i) => T(62, 256 + i * 52, s, i === 2 ? 'x-mono-xs' : 'x-label'));
        const hi = rr(50, 334, 450, 42, 'x-hi', 10);
        const agent = roleIcon('api3', 610, 280, 'API3 agent', 'finds the receipt');
        const a1 = arrow(512, 280, 566, 280, 'a-api3');
        const a2 = arrow(656, 280, 716, 280, 'a-api3');
        const base = at(0, 0, rr(730, 120, 420, 320, 'x-card x-card-api3'), T(752, 160, 'TreasuryGuard · Base Sepolia', 'x-small'), T(752, 206, `intent ${v.id}`, 'x-title-s'), T(752, 262, 'settled:', 'x-label'), T(752, 330, 'bsvTxid:', 'x-label'));
        const before = at(0, 0, T(880, 262, 'false', 'x-mono-s x-muted'));
        const after = at(0, 0, T(880, 262, 'true', 'x-mono-s x-api3-t'));
        const txid = T(880, 330, v.tx, 'x-mono-s');
        const call = chip(752, 400, 380, `settle(${v.id}, 0x${v.tx})`, 'x-chip-api3');
        root.append(woc, ...outs, hi, agent, a1, a2, base, before, after, txid, call);
        rise(woc, 100); outs.forEach((o, i) => fade(o, 400 + i * 200));
        fade(hi, 1300, 400);
        rise(agent, 1900); draw(a1.firstChild, 2300, 400); fade(a1.lastChild, 2650, 150);
        rise(base, 2800); fade(before, 3000);
        draw(a2.firstChild, 3600, 400); fade(a2.lastChild, 3950, 150); rise(call, 3700);
        out(before, 4500); popIn(after, 4700, 450);
        fade(txid, 5100, 500);
        return { ms: 6400, source: L ? SRC_LIVE(L.id) + ` · tx ${L.vaultTx}` : SRC_REC(`settle(${REC.intent}) · Base tx ${REC.settleTx}`) };
      }
    },

    replay: {
      kicker: 'WATCHER · REPLAY', kickerCls: 'k-watcher',
      title: [['one intent, ', ''], ['one transaction', 'tt-watcher']],
      caption: 'The watcher can block, never take.',
      draw(root, d) {
        const id = d.ctx.replayId || null;
        const v = id ? id : REC.intent;
        const agent = roleIcon('agent', 120, 270, 'agent');
        const watcher = roleIcon('watcher', 560, 270, 'watcher');
        const req = at(0, 0, rr(-110, -24, 220, 48, 'x-card', 12), T(0, 8, `intent ${v} again`, 'x-mono-s', { 'text-anchor': 'middle' }));
        const journal = at(0, 0, rr(760, 110, 390, 170, 'x-card x-card-watcher'), T(782, 150, 'journal on disk', 'x-small'), T(782, 206, `intent ${v} · broadcast`, 'x-mono-s'), T(782, 248, 'one intent, one BSV transaction', 'x-small'));
        const hi = rr(772, 180, 366, 40, 'x-hi', 10);
        const back = arrow(510, 360, 170, 360, 'a-bad');
        const no = T(340, 344, 'HTTP 409 · Refused', 'x-bad', { 'text-anchor': 'middle' });
        const vault = at(0, 0, rr(760, 340, 390, 190, 'x-vault', 22), T(955, 384, 'VAULT · BSV MAINNET', 'x-caps x-bsv-t', { 'text-anchor': 'middle' }),
          rr(930, 420, 50, 40, 'x-lock', 8), el('path', { d: 'M942 420 v-10 a13 13 0 0 1 26 0 v10', class: 'x-lock-arc' }),
          T(955, 500, 'nothing signed · nothing moved', 'x-small', { 'text-anchor': 'middle' }));
        root.append(agent, watcher, journal, hi, back, no, vault, req);
        rise(agent, 100); rise(watcher, 250);
        fly(req, [190, 200], [490, 200], 700, 1200, false);
        rise(journal, 1700); fade(hi, 2500, 400);
        draw(back.firstChild, 3300, 600); fade(back.lastChild, 3850, 150); popIn(no, 3600, 450);
        rise(vault, 4500);
        return { ms: 6000, source: id ? `Live · replay of intent ${id} sent from this page · the watcher’s answer shows under the button` : SRC_REC(`intent ${REC.intent} replayed, refused with 409 at ${REC.replayAt}`) };
      }
    },

    tamper: {
      kicker: 'API3 · TAMPER TEST · checkPrice, a free eth_call', kickerCls: 'k-api3',
      title: [['one valid, ', ''], ['four rejected', 'tt-api3']],
      caption: 'Change any signed byte and the contract refuses it. Nothing is sent or signed.',
      draw(root) {
        // The cases and order of the tamper-test panel, with the error TreasuryGuard.checkPrice returns for each.
        const CASES = [
          ['Untouched signed price', null, true, 'Valid', 'younger than 5 min'],
          ['Lower the price (halved)', 'data', false, 'Rejected', 'SignerMismatch'],
          ['Make an old price look new', 'timestamp', false, 'Rejected', 'SignerMismatch'],
          ['Claim another feed (BTC/USD)', 'request hash', false, 'Rejected', 'WrongRequest'],
          ['Forge the signature (one byte)', 'signature', false, 'Rejected', 'SignerMismatch']
        ];
        const FIELDS = ['request hash', 'timestamp', 'data', 'signature'];
        CASES.forEach(([title, field, ok, word, err], i) => {
          const y = 96 + i * 92;
          const row = at(0, 0, rr(40, y, 1110, 76, 'x-row', 14), T(64, y + 46, title, 'x-label'));
          const env = g({}, ...FIELDS.map((f, j) => at(0, 0, rr(440 + j * 126, y + 20, 118, 36, f === field ? 'x-field x-field-hit' : 'x-field', 8), T(499 + j * 126, y + 44, f, 'x-mono-xs', { 'text-anchor': 'middle' }))));
          const res = at(0, 0, T(960, y + 38, `${ok ? '✓' : '✕'} ${word}`, ok ? 'x-ok' : 'x-bad'), T(960, y + 64, err, 'x-mono-xs x-muted'));
          root.append(row, env, res);
          rise(row, 200 + i * 1150); fade(env, 400 + i * 1150); popIn(res, 900 + i * 1150, 450);
        });
        return { ms: 6800, source: 'The panel’s cases, in its order · errors from TreasuryGuard.checkPrice (api3/contracts/TreasuryGuard.sol)' };
      }
    },

    exit: {
      kicker: 'EXIT · THE OWNER ALONE · OP_ELSE', kickerCls: 'k-owner',
      title: [['( agent AND watcher ) ', 'tt-dim'], ['OR owner', 'tt-owner']],
      caption: 'No agent, no watcher, no Base transaction. The owner can always leave.',
      draw(root) {
        const r = roles();
        const card = vaultCard();
        const holes = { agent: keyhole('agent', ...HOLE.agent), watcher: keyhole('watcher', ...HOLE.watcher), owner: keyhole('owner', ...HOLE.owner) };
        const ko = key('owner');
        const lines = [['OP_IF', 'x-mono-s x-muted'], ['  <agent> OP_CHECKSIGVERIFY', 'x-mono-s x-muted'], ['  <watcher> OP_CHECKSIG', 'x-mono-s x-muted'], ['OP_ELSE', 'x-mono-s x-owner-t'], ['  <owner> OP_CHECKSIG', 'x-mono-s x-owner-t'], ['OP_ENDIF', 'x-mono-s x-muted']];
        const script = at(0, 0, rr(790, 120, 370, 270, 'x-card'), ...lines.map(([s, c], i) => T(814, 164 + i * 38, s, c)));
        const elseHi = rr(800, 252, 350, 82, 'x-hi x-hi-owner', 10);
        const coins = [0, 1, 2, 3, 4].map(() => coin());
        const back = at(0, 0, T(790, 450, `${REC.exitBack} sats back · fee ${REC.exitFee}`, 'x-num-s x-owner-t'), T(790, 486, 'unlocking script: <ownerSig> OP_0', 'x-mono-xs'));
        const none = T(790, 530, 'signed by the owner in BSV Desktop', 'x-small');
        root.append(r.agent, r.watcher, r.owner, card, holes.agent, holes.watcher, holes.owner, script, elseHi, back, none, ...coins, ko);
        [r.agent, r.watcher, r.owner].forEach((n, i) => rise(n, 100 + i * 120));
        fade(card, 300); Object.values(holes).forEach((h, i) => popIn(h, 500 + i * 100, 400));
        fade(script, 700);
        dim(r.agent, 1400); dim(r.watcher, 1400); dim(holes.agent, 1400); dim(holes.watcher, 1400);
        fly(ko, [160, 480], [HOLE.owner[0] - 56, HOLE.owner[1]], 1900, 1300, false);
        turn(ko, 3300); glow(holes.owner, 3600); fade(elseHi, 3600, 500);
        coins.forEach((c, i) => fly(c, [500, 400], [150, 480], 4300 + i * 170, 900));
        rise(back, 5000); fade(none, 5600);
        return { ms: 6800, source: SRC_REC(`the owner exit on mainnet, ${REC.exitBack} sats back, fee ${REC.exitFee} · tx ${REC.exitTx}`) };
      }
    }
  };

  // ---------------------------------------------------------------- which click opens which scene

  // The live stepper's step titles (the agent bar and the owner view) → scene.
  const STEP_SCENE = {
    'Owner funds the vault': 'fund', 'Signed price → limit': 'limit', 'Watcher co-signs · vault pays': 'watcher',
    'AI agent pays for data': 'pay', 'Recorded on Base': 'settle', 'Replay refused': 'replay', 'Owner takes it back': 'exit'
  };
  const RUN_SCENE = ['price', 'limit', 'watcher', 'vault', 'pay', 'settle']; // #run nodes, by data-i
  const PANEL_SCENE = {
    'price-card': 'price', 'oracle-card': 'price', 'limit-card': 'limit', lab: 'tamper',
    'decisions-card': 'watcher', 'recheck-card': 'watcher', 'withdrawals-card': 'vault',
    'agent-card': 'pay', 'payments-card': 'pay'
  };
  const PANEL_SELECTOR = Object.keys(PANEL_SCENE).map((id) => `#${id}`).join(', ');
  const stepTitle = (li) => txt(li.querySelector('.sp-title')?.firstChild);

  const sceneFor = (t) => {
    const chipEl = t.closest('.tgx-chip');
    if (chipEl) return { key: chipEl.dataset.scene, ctx: {} };
    const btn = t.closest('button');
    if (btn) {
      const label = txt(btn);
      if (btn.id === 'lab-run-all') return { key: 'tamper', ctx: {} };
      if (label === 'Run the agent') return { key: 'price', ctx: {} };
      if (/^Replay\b/.test(label) || label === 'Show a refusal') return { key: 'replay', ctx: { replayId: (/#(\d+)/.exec(label) || [])[1] || null } };
      if (label === 'Fund 5,000 sats') return { key: 'fund', ctx: { amount: '5,000' } };
      if (label === 'Yes, fund it') {
        const m = /Send ([\d,]+) sats/.exec(txt(btn.closest('.owner-confirm')));
        return { key: 'fund', ctx: { amount: m ? m[1] : null } };
      }
      if (label === 'Exit' && btn.closest('#tab-owner')) {
        const typed = document.getElementById('exit-confirm');
        return typed && typed.value.trim() === 'EXIT' ? { key: 'exit', ctx: {} } : null;
      }
      return null;
    }
    if (t.closest('a, input, textarea, select, summary, label, form')) return null;
    const pn = t.closest('#run li.pn');
    if (pn) return RUN_SCENE[Number(pn.dataset.i)] ? { key: RUN_SCENE[Number(pn.dataset.i)], ctx: {} } : null;
    const sp = t.closest('.owner-job li.sp');
    if (sp) return STEP_SCENE[stepTitle(sp)] ? { key: STEP_SCENE[stepTitle(sp)], ctx: {} } : null;
    if (t.closest('.mf-vault, #vault-card, #script-card')) return { key: 'vault', ctx: {} };
    if (t.closest('.mf-owner, #tab-owner .owner-card, #exit-proof')) return { key: 'exit', ctx: {} };
    // Panels (and their (i)) open the scene of what they show.
    const panel = t.closest(PANEL_SELECTOR);
    if (panel) return { key: PANEL_SCENE[panel.id], ctx: {} };
    return null;
  };

  // ---------------------------------------------------------------- the pop-up

  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };

  const close = () => {
    if (!modal) return;
    for (const a of anims) a.cancel();
    anims = [];
    const { root, back } = modal;
    modal = null;
    root.remove();
    if (back && back.isConnected) back.focus({ preventScroll: true });
  };

  const render = () => {
    const { svg, scene, ctx, source, caption } = modal;
    for (const a of anims) a.cancel();
    anims = [];
    svg.replaceChildren();
    const out = scene.draw(svg, { live: live(), ctx });
    source.textContent = out.source;
    caption.textContent = scene.caption;
  };

  const open = (key, ctx, from) => {
    const scene = SCENES[key];
    if (!scene) return;
    close();
    const root = make('div', 'tgx-root');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'tgx-title');
    root.setAttribute('aria-describedby', 'tgx-caption');
    const backdrop = make('div', 'tgx-backdrop');
    const box = make('div', 'tgx-modal');
    const kicker = make('p', `tgx-kicker ${scene.kickerCls}`, scene.kicker);
    const title = make('h2', 'tgx-title');
    title.id = 'tgx-title';
    for (const [s, cls] of scene.title) title.append(cls ? make('span', cls, s) : document.createTextNode(s));
    const stage = make('div', 'tgx-stage');
    const svg = el('svg', { viewBox: '0 0 1200 600', role: 'img', 'aria-label': scene.caption });
    stage.append(svg);
    const caption = make('p', 'tgx-caption');
    caption.id = 'tgx-caption';
    const foot = make('div', 'tgx-foot');
    const source = make('p', 'tgx-source');
    const btns = make('div', 'tgx-btns');
    const replay = make('button', 'tgx-btn', 'Replay');
    replay.type = 'button';
    const closeBtn = make('button', 'tgx-btn tgx-btn-primary', 'Close');
    closeBtn.type = 'button';
    btns.append(replay, closeBtn);
    foot.append(source, btns);
    box.append(kicker, title, stage, caption, foot);
    root.append(backdrop, box);
    backdrop.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    replay.addEventListener('click', () => { render(); closeBtn.focus({ preventScroll: true }); });
    modal = { root, svg, scene, ctx: ctx || {}, source, caption, replay, closeBtn, back: from || null };
    document.body.append(root);
    render();
    closeBtn.focus({ preventScroll: true });
  };

  // ---------------------------------------------------------------- "Explain this step" chips on finished live steps

  const decorate = () => {
    if (!on) return;
    for (const li of document.querySelectorAll('.owner-job li.sp.sp-done')) {
      if (li.querySelector('.tgx-chip')) continue;
      const key = STEP_SCENE[stepTitle(li)];
      if (!key) continue;
      const b = make('button', 'tgx-chip', 'Explain this step');
      b.type = 'button';
      b.dataset.scene = key;
      li.append(b);
    }
  };
  let queued = false;
  const queueDecorate = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; decorate(); }); };

  // ---------------------------------------------------------------- on / off

  const toast = (s) => {
    const n = make('div', 'tgx-toast', s);
    n.setAttribute('role', 'status');
    document.body.append(n);
    setTimeout(() => n.remove(), 2400);
  };
  const setOn = (v, quiet) => {
    on = v;
    document.documentElement.classList.toggle('tgx-on', on);
    if (on) {
      observer = observer || new MutationObserver(queueDecorate);
      for (const id of ['agent-controls', 'tab-owner']) {
        const target = document.getElementById(id);
        if (target) observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      }
      decorate();
    } else {
      if (observer) observer.disconnect();
      for (const c of document.querySelectorAll('.tgx-chip')) c.remove();
      close();
    }
    if (!quiet) toast(on ? 'Explain mode on · click a step, a button or the vault · E turns it off' : 'Explain mode off');
  };

  // Clicks: the page's own handlers have already run (this listener is on the document, in the bubble phase).
  document.addEventListener('click', (e) => {
    if (!on || modal || !(e.target instanceof Element) || e.target.closest('.tgx-root')) return;
    const hit = sceneFor(e.target);
    if (!hit) return;
    const from = e.target.closest('button');
    requestAnimationFrame(() => open(hit.key, hit.ctx, from));
  });

  // Keys: while a pop-up is open it takes every key, so Esc closes only the pop-up and video mode stays on.
  window.addEventListener('keydown', (e) => {
    if (modal) {
      if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === modal.closeBtn ? modal.replay : modal.closeBtn).focus();
      } else if ((e.key === 'Enter' || e.key === ' ') && document.activeElement === modal.replay) {
        // the Replay button handles its own Enter / Space
      } else if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        close();
      }
      e.stopPropagation();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'e' || e.key === 'E') setOn(!on);
  }, true);

  if (params.get('explain') === '1') setOn(true, true);
})();
