// Read-only data access for the Treasury Guard dashboard: Base Sepolia JSON-RPC (eth_call, eth_getLogs), WhatsOnChain
// and the watcher's public GET endpoints. Classic script, no dependencies, no build step.
//
// The ABI is the deployed TreasuryGuard interface (api3/src/client/abi.ts, api3/contracts/TreasuryGuard.sol). Only
// read-only calls are encoded here. Selectors are keccak-256 of the signatures written next to them; they match the
// error selectors listed in api3/README.md ("Tamper test") and were checked against the live contract.
'use strict';

(function () {
  const SEL = {
    intentCount: '0x0cdf9008', // intentCount()
    getIntent: '0x906e277b', // getIntent(uint256)
    lastPrice: '0x00fd94cb', // lastPrice(uint256)
    regime: '0xe105728a', // regime(uint256)
    remainingUsdToday: '0x4ccb795c', // remainingUsdToday(uint256)
    getVaultConfig: '0x7fcced05', // getVaultConfig(uint256)
    checkPrice: '0x5fc3c41c' // checkPrice(uint256,(bytes32,uint256,bytes,bytes))
  };

  // Custom errors of TreasuryGuard.sol (selector → name, argument type).
  const ERRORS = {
    '0x64fd0fbe': ['SignerMismatch', 'address'],
    '0x4a161c51': ['WrongRequest', 'bytes32'],
    '0x480cfdff': ['StaleSignature', null],
    '0x7f1d2c82': ['StalePost', null],
    '0xb5a78004': ['Replay', null],
    '0x19af843d': ['BudgetExceeded', 'uint256'],
    '0x2c5211c6': ['InvalidAmount', null],
    '0x579354d1': ['NotOriginalPost', null]
  };

  const TOPIC = {
    IntentCreated: '0xf4d5cce76c69ebe336881e68ff05eaec0335425e956acedd6f3abac79c9cd8bf',
    PriceVerified: '0xf16cd7c92c27ce3e32aefda44df8a7531460eded040224495dd9b2c1dbb92123',
    Settled: '0x3c405a0f188ed2fc0042ea8df2a5f41a07f54753f374835c3acf51848f18d84a'
  };

  const ENUMS = {
    Regime: ['NORMAL', 'RISK_OFF', 'GUARDED'],
    Kind: ['SPEND', 'SWAP'],
    Direction: ['NONE', 'SATS_TO_DUSD', 'DUSD_TO_SATS'],
    Source: ['BUDGET', 'BREAKER', 'REENTRY', 'EVENT']
  };

  const TWO_256 = 1n << 256n;
  const TWO_255 = 1n << 255n;

  // ---------- ABI helpers (exact BigInt arithmetic) ----------

  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
  const isHex = (s, bytes) => typeof s === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(s);

  const words = (hex) => {
    const h = strip0x(hex || '');
    if (h.length % 64 !== 0) throw new Error('Malformed ABI data');
    const out = [];
    for (let i = 0; i < h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)));
    return out;
  };
  const toInt = (w) => (w >= TWO_255 ? w - TWO_256 : w);
  const toAddress = (w) => '0x' + w.toString(16).padStart(40, '0').slice(-40);
  const toBytes32 = (w) => '0x' + w.toString(16).padStart(64, '0');

  const utf8Hex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
  const padHex = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);

  // checkPrice(uint256 vaultId, (bytes32 requestHash, uint256 timestamp, bytes data, bytes signature) response)
  const encodeCheckPrice = (vaultId, response) => {
    if (!isHex(response.requestHash, 32)) throw new Error('requestHash is not bytes32');
    if (!/^[0-9]+$/.test(String(response.timestamp))) throw new Error('timestamp is not an integer');
    const data = utf8Hex(response.data);
    const sig = strip0x(response.signature);
    if (!/^[0-9a-fA-F]*$/.test(sig) || sig.length % 2) throw new Error('signature is not hex');
    const dataLen = data.length / 2;
    const tuple =
      strip0x(response.requestHash) +
      word(BigInt(response.timestamp)) +
      word(0x80) +
      word(0x80 + 32 + padHex(data).length / 2) +
      word(dataLen) + padHex(data) +
      word(sig.length / 2) + padHex(sig);
    return SEL.checkPrice + word(vaultId) + word(0x40) + tuple;
  };

  const decodeRevert = (data) => {
    if (typeof data !== 'string' || data.length < 10) return null;
    const sel = data.slice(0, 10).toLowerCase();
    const known = ERRORS[sel];
    if (!known) return { name: 'Unknown error', selector: sel, arg: null };
    const [name, type] = known;
    let arg = null;
    if (type && data.length >= 10 + 64) {
      const w = BigInt('0x' + data.slice(10, 74));
      arg = type === 'address' ? toAddress(w) : type === 'bytes32' ? toBytes32(w) : w.toString();
    }
    return { name, selector: sel, arg };
  };

  const decodeIntent = (hex) => {
    const w = words(hex);
    if (w.length < 13) throw new Error('getIntent returned too little data');
    return {
      vaultId: w[0],
      kind: ENUMS.Kind[Number(w[1])] ?? `kind ${w[1]}`,
      direction: ENUMS.Direction[Number(w[2])] ?? `direction ${w[2]}`,
      source: ENUMS.Source[Number(w[3])] ?? `source ${w[3]}`,
      maxSats: w[4],
      maxBps: w[5],
      minOut: w[6],
      maxOut: w[7],
      expiry: w[8],
      price: w[9],
      priceSignedAt: w[10],
      settled: w[11] !== 0n,
      bsvTxid: toBytes32(w[12])
    };
  };

  const decodePrice = (hex) => {
    const w = words(hex);
    return { price: w[0], change1h: toInt(w[1]), updatedAt: w[2], signedAt: w[3] };
  };

  const decodeConfig = (hex) => {
    const w = words(hex);
    if (w.length < 16) throw new Error('getVaultConfig returned too little data');
    return {
      owner: toAddress(w[0]),
      agent: toAddress(w[1]),
      priceAirnode: toAddress(w[2]),
      priceRequestHash: toBytes32(w[3]),
      postAirnode: toAddress(w[4]),
      dailyBudgetUsd: w[5],
      maxSignatureAge: w[6],
      maxDataAge: w[7],
      maxPostAge: w[8],
      cooldown: w[9],
      intentTtl: w[10],
      breakerBps: toInt(w[11]),
      reentryBps: toInt(w[12]),
      breakerHedgeBps: w[13],
      eventHedgeBps: w[14],
      slippageBps: w[15]
    };
  };

  // IntentCreated: topics [sig, intentId, vaultId]; data: kind, direction, maxSats, maxBps, minOut, maxOut, expiry,
  // price, priceSignedAt, source.
  const decodeIntentLog = (log) => {
    const w = words(log.data);
    return {
      intentId: BigInt(log.topics[1]),
      vaultId: BigInt(log.topics[2]),
      kind: ENUMS.Kind[Number(w[0])],
      source: ENUMS.Source[Number(w[9])],
      maxSats: w[2],
      expiry: w[6],
      price: w[7],
      priceSignedAt: w[8],
      txHash: log.transactionHash,
      blockNumber: BigInt(log.blockNumber)
    };
  };

  // PriceVerified: topics [sig, vaultId]; data: price, change1h, updatedAt, signedAt, requestHash.
  const decodePriceLog = (log) => {
    const w = words(log.data);
    return {
      vaultId: BigInt(log.topics[1]),
      price: w[0],
      change1h: toInt(w[1]),
      updatedAt: w[2],
      signedAt: w[3],
      requestHash: toBytes32(w[4]),
      txHash: log.transactionHash,
      blockNumber: BigInt(log.blockNumber)
    };
  };

  // ---------- transport ----------

  const fetchJson = async (url, init = {}, timeoutMs = 8000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store', credentials: 'omit' });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`timed out after ${timeoutMs / 1000} s`);
      if (e instanceof TypeError) throw new Error('network unreachable or blocked');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  class RpcError extends Error {
    constructor(message, code, data) {
      super(message);
      this.code = code;
      this.data = data;
    }
  }

  const createBase = (rpcUrl, contract) => {
    let id = 0;
    const rpc = async (method, params) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params });
      const json = await fetchJson(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (json.error) throw new RpcError(json.error.message || 'RPC error', json.error.code, json.error.data);
      return json.result;
    };
    const call = (data, block = 'latest') => rpc('eth_call', [{ to: contract, data }, block]);
    const u = (sel, n) => call(sel + word(n));

    // eth_getLogs over [from, to] in chunks of at most `range` blocks (sepolia.base.org allows 200).
    const getLogs = async (topics, from, to, range = 200n) => {
      const out = [];
      for (let start = from; start <= to; start += range) {
        const end = start + range - 1n < to ? start + range - 1n : to;
        const logs = await rpc('eth_getLogs', [{
          address: contract, topics, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16)
        }]);
        out.push(...logs);
      }
      return out;
    };

    return {
      rpcUrl,
      chainId: async () => BigInt(await rpc('eth_chainId', [])),
      blockNumber: async () => BigInt(await rpc('eth_blockNumber', [])),
      blockTimestamp: async (n) => {
        const b = await rpc('eth_getBlockByNumber', ['0x' + BigInt(n).toString(16), false]);
        if (!b || !b.timestamp) throw new Error(`block ${n} not available`);
        return BigInt(b.timestamp);
      },
      intentCount: async () => words(await call(SEL.intentCount))[0],
      getIntent: async (n) => decodeIntent(await u(SEL.getIntent, n)),
      lastPrice: async (v) => decodePrice(await u(SEL.lastPrice, v)),
      regime: async (v) => ENUMS.Regime[Number(words(await u(SEL.regime, v))[0])] ?? 'UNKNOWN',
      remainingUsdToday: async (v) => words(await u(SEL.remainingUsdToday, v))[0],
      getVaultConfig: async (v) => decodeConfig(await u(SEL.getVaultConfig, v)),
      // Free eth_call of checkPrice. Resolves { accepted: true, price } or { accepted: false, revert }.
      checkPrice: async (vaultId, response) => {
        try {
          const result = await call(encodeCheckPrice(vaultId, response));
          return { accepted: true, price: decodePrice(result) };
        } catch (e) {
          const data = e instanceof RpcError ? (typeof e.data === 'string' ? e.data : e.data?.data) : null;
          const revert = decodeRevert(data);
          if (revert) return { accepted: false, revert };
          throw e;
        }
      },
      // IntentCreated and PriceVerified of every vault in one bounded query per 200-block page.
      contractLogs: async (from, to) => {
        const logs = await getLogs([[TOPIC.IntentCreated, TOPIC.PriceVerified]], from, to);
        const out = [];
        for (const log of logs) {
          try {
            if (log.topics[0] === TOPIC.IntentCreated) out.push({ type: 'intent', ...decodeIntentLog(log) });
            else if (log.topics[0] === TOPIC.PriceVerified) out.push({ type: 'price', ...decodePriceLog(log) });
          } catch { /* skip a log that does not decode */ }
        }
        return out;
      }
    };
  };

  // WhatsOnChain: free API, about 3 requests per second. Requests are serialised with a minimum gap, and any failure
  // (a rate-limit answer arrives without CORS headers, so the browser reports it as a network error) pauses the queue.
  const createWoc = (apiBase) => {
    let queue = Promise.resolve();
    let last = 0;
    let pauseUntil = 0;
    const GAP_MS = 700;
    const PAUSE_MS = 15000;
    const get = (path) => {
      const run = async () => {
        const wait = Math.max(last + GAP_MS, pauseUntil) - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        try {
          return await fetchJson(apiBase + path, {}, 10000);
        } catch (e) {
          if (e.status !== 404) pauseUntil = Date.now() + PAUSE_MS;
          throw e;
        }
      };
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    };
    return {
      scriptUnspent: (scriptHash) => get(`/script/${scriptHash}/unspent/all`),
      // The transaction that spent output `n` of `txid`: { txid, vin, status }. HTTP 404 while it is unspent.
      spentBy: (txid, n) => get(`/tx/${txid}/${n}/spent`),
      tx: (txid) => get(`/tx/hash/${txid}`)
    };
  };

  const createWatcher = (baseUrl) => ({
    health: () => fetchJson(baseUrl + '/health', {}, 4000),
    decisions: () => fetchJson(baseUrl + '/decisions', {}, 4000)
  });

  // ---------- BSV helpers ----------

  const reverseHex = (h) => (h.match(/../g) || []).reverse().join('');

  // Finds the Treasury Guard receipt "TGv1 <chainId> <contract> <vaultId> <intentId>" (bsv/src/vault/proposeSpend.ts)
  // in a WhatsOnChain transaction's OP_RETURN outputs.
  const findReceipt = (tx) => {
    for (const out of tx?.vout ?? []) {
      const hex = out?.scriptPubKey?.hex;
      if (typeof hex !== 'string' || !/^(00)?6a/.test(hex)) continue;
      let i = hex.startsWith('006a') ? 4 : 2;
      while (i < hex.length) {
        let len = parseInt(hex.slice(i, i + 2), 16);
        i += 2;
        if (len === 0x4c) { len = parseInt(hex.slice(i, i + 2), 16); i += 2; }
        else if (len === 0x4d) { len = parseInt(hex.slice(i + 2, i + 4) + hex.slice(i, i + 2), 16); i += 4; }
        else if (len > 0x4b) break;
        const chunk = hex.slice(i, i + len * 2);
        i += len * 2;
        let text = '';
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(chunk.match(/../g).map((b) => parseInt(b, 16)))); } catch { continue; }
        const m = /^TGv1 (\d+) (0x[0-9a-f]{40}) (\d+) (\d+)$/.exec(text);
        if (m) return { chainId: BigInt(m[1]), contract: m[2], vaultId: BigInt(m[3]), intentId: BigInt(m[4]) };
      }
    }
    return null;
  };

  // ---------- polling ----------

  // Runs `fn` every `intervalMs`, never overlapping; on error backs off (doubling, up to maxBackoffMs). `onUpdate`
  // receives { ok, value?, error?, at }.
  const poll = (fn, intervalMs, onUpdate, { maxBackoffMs = 60000 } = {}) => {
    let delay = intervalMs;
    let timer;
    let stopped = false;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      clearTimeout(timer);
      try {
        const value = await fn();
        delay = intervalMs;
        onUpdate({ ok: true, value, at: Date.now() });
      } catch (error) {
        delay = Math.min(delay * 2, maxBackoffMs);
        onUpdate({ ok: false, error, at: Date.now(), retryInMs: delay });
      } finally {
        running = false;
        if (!stopped) timer = setTimeout(tick, document.hidden ? Math.max(delay, 30000) : delay);
      }
    };
    tick();
    return {
      stop: () => { stopped = true; clearTimeout(timer); },
      now: () => { if (!running) tick(); }
    };
  };

  window.TGChain = Object.freeze({
    SEL, ERRORS, TOPIC, ENUMS,
    createBase, createWoc, createWatcher,
    encodeCheckPrice, decodeRevert, decodeIntent, decodePrice, decodeConfig, words,
    reverseHex, findReceipt, poll, isHex
  });
})();
