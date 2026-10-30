// Hour-0 spike: buys one signed response per target via x402, checks it off-chain, and caches it as a fixture.
// Run with the agent env, never the deployer's: node --env-file=.env.agent src/spike.ts <target>
// A target whose fixture already exists is skipped, so nothing is bought twice.
import { existsSync, writeFileSync } from 'node:fs';
import { isHex, type Address } from 'viem';
import { type AirnodeV2Request, deriveRequestHash, fetchSignedResponse, verifySignedResponse } from './airnode-v2.ts';
import { createPayingFetch, readPaymentSettlement } from './x402.ts';

const COINPAPRIKA_URL = 'https://airnode-coinpaprika.fly.dev/';
const COINPAPRIKA_ADDRESS: Address = '0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732';
const TWITTERAPI_URL = 'https://airnode-twitterapi.fly.dev/';
const TWITTERAPI_ADDRESS: Address = '0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB';

const tickerRequest = (coinId: string): AirnodeV2Request => ({
  operation: 'getTickersById',
  parameters: { coin_id: coinId, quotes: 'USD' },
  responseProjection: {
    change1h: '/quotes/USD/percent_change_1h',
    price: '/quotes/USD/price',
    updatedAt: '/last_updated',
  },
});

const TARGETS: Record<string, { url: string; airnode: Address; request: AirnodeV2Request; file: string }> = {
  'bsv-usd': {
    url: COINPAPRIKA_URL,
    airnode: COINPAPRIKA_ADDRESS,
    request: tickerRequest('bsv-bitcoin-sv'),
    file: 'coinpaprika-bsv-usd.json',
  },
  // Same signer, different request: the fixture for the WrongRequest case.
  'btc-usd': {
    url: COINPAPRIKA_URL,
    airnode: COINPAPRIKA_ADDRESS,
    request: tickerRequest('btc-bitcoin'),
    file: 'coinpaprika-btc-usd.json',
  },
  // Unprojected, only to learn the shape (pinned post, retweet flag, id type). Not for the contract.
  'whitehouse-raw': {
    url: TWITTERAPI_URL,
    airnode: TWITTERAPI_ADDRESS,
    request: { operation: 'userLastTweets', parameters: { userName: 'WhiteHouse' } },
    file: 'twitterapi-whitehouse-raw.json',
  },
  // What the contract sees. There is no retweet boolean: a retweet has a retweeted_tweet object and text "RT @...".
  whitehouse: {
    url: TWITTERAPI_URL,
    airnode: TWITTERAPI_ADDRESS,
    request: {
      operation: 'userLastTweets',
      parameters: { userName: 'WhiteHouse' },
      responseProjection: { id: '/data/tweets/0/id', text: '/data/tweets/0/text' },
    },
    file: 'twitterapi-whitehouse.json',
  },
  // An account that posts rarely, so the newest post is hours old at signing: the real StalePost fixture.
  federalreserve: {
    url: TWITTERAPI_URL,
    airnode: TWITTERAPI_ADDRESS,
    request: {
      operation: 'userLastTweets',
      parameters: { userName: 'federalreserve' },
      responseProjection: { id: '/data/tweets/0/id', text: '/data/tweets/0/text' },
    },
    file: 'twitterapi-federalreserve.json',
  },
};

const target = TARGETS[process.argv[2] ?? ''];
if (!target) throw new Error(`Usage: spike.ts <${Object.keys(TARGETS).join('|')}>`);

const fixturePath = new URL(`../test/fixtures/${target.file}`, import.meta.url);
if (existsSync(fixturePath)) {
  console.error(`${target.file} exists, not fetching again`);
  process.exit(0);
}

const payerPrivateKey = process.env.PAYER_PRIVATE_KEY;
if (!payerPrivateKey || !isHex(payerPrivateKey)) throw new Error('PAYER_PRIVATE_KEY is missing or not 0x-prefixed hex');
const payingFetch = createPayingFetch(payerPrivateKey);
const loggingFetch: typeof fetch = async (input, init) => {
  const response = await payingFetch(input, init);
  const settlement = readPaymentSettlement(response);
  if (settlement) {
    console.error(
      settlement.success
        ? `x402 paid: https://sepolia.basescan.org/tx/${settlement.transaction}`
        : `x402 did not settle: ${settlement.errorReason}`
    );
  }
  return response;
};

const expectedRequestHash = deriveRequestHash(target.request);
const signedResponse = await fetchSignedResponse(target.url, target.request, loggingFetch);
// Save first, so a failed check never costs a second purchase. data stays the exact signed string.
writeFileSync(fixturePath, `${JSON.stringify(signedResponse, null, 2)}\n`);
console.error(`saved test/fixtures/${target.file}`);
await verifySignedResponse(signedResponse, target.airnode, expectedRequestHash);
console.error(`signature ok, signer ${target.airnode}, requestHash ${expectedRequestHash}`);
