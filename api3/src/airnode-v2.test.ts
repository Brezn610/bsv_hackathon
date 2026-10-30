import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import {
  type AirnodeV2PassthroughRequest,
  derivePassthroughRequestHash,
  deriveRequestHash,
  type SignedResponse,
  verifySignedResponse,
} from './airnode-v2.ts';
import { buildPricePassthroughRequest, buildPriceRequest, NODARY_AIRNODE_V2_ADDRESS } from './nodary.ts';

// Saved with `pnpm --silent fetch-response <feed name>`.
const readFixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8')) as SignedResponse;

const ethUsdResponse = readFixture('nodary-eth-usd.json');
const ethUsdRequestHash = deriveRequestHash(buildPriceRequest('ETH/USD'));

test('derives the request hash that the Airnode signed', () => {
  assert.equal(ethUsdRequestHash, ethUsdResponse.requestHash);
});

test('derives the same request hash whatever the order of the projection fields', () => {
  const { responseProjection, ...request } = buildPriceRequest('ETH/USD');
  const reversedProjection = Object.fromEntries(Object.entries(responseProjection ?? {}).toReversed());
  assert.equal(deriveRequestHash({ ...request, responseProjection: reversedProjection }), ethUsdRequestHash);
});

test('sorts keys in UTF-8 byte order, as the Airnode does', () => {
  // localeCompare puts withflights first, and comparing UTF-16 code units puts the emoji before U+FFFF.
  const parameters = { withflights: false, withLocation: true, '😀': 1, '\uffff': 2 };
  const expectedHash = keccak256(
    toHex('["flightStatus",[["withLocation",true],["withflights",false],["\uffff",2],["😀",1]]]')
  );
  assert.equal(deriveRequestHash({ operation: 'flightStatus', parameters }), expectedHash);
});

test('derives the passthrough request hash from the request as sent', () => {
  const expectedHash = keccak256(
    toHex(
      '["passthrough","GET","/feed/latest",[["name","ETH/USD"]],[],"",[["price","/ETH~1USD/value"],["updatedAt","/ETH~1USD/timestamp"]]]'
    )
  );
  assert.equal(derivePassthroughRequestHash(buildPricePassthroughRequest('ETH/USD')), expectedHash);
});

test('keeps the passthrough query in the order sent, and lower-cases and sorts the header names', () => {
  const request: AirnodeV2PassthroughRequest = {
    method: 'GET',
    path: '/tokens',
    query: [
      ['b', '2'],
      ['a', '1'],
    ],
    headers: [
      ['X-Chain', 'solana'],
      ['Accept-Version', '1'],
    ],
    body: '',
  };
  const expectedHash = keccak256(
    toHex('["passthrough","GET","/tokens",[["b","2"],["a","1"]],[["accept-version","1"],["x-chain","solana"]],""]')
  );
  assert.equal(derivePassthroughRequestHash(request), expectedHash);
});

test('accepts a response that the Airnode signed', async () => {
  await verifySignedResponse(ethUsdResponse, NODARY_AIRNODE_V2_ADDRESS, ethUsdRequestHash);
});

test('rejects a response with an edited value', async () => {
  const editedResponse = { ...ethUsdResponse, data: ethUsdResponse.data.replace('"price":2', '"price":1') };
  await assert.rejects(verifySignedResponse(editedResponse, NODARY_AIRNODE_V2_ADDRESS, ethUsdRequestHash), /signed by/);
});

test('rejects a response to another request', async () => {
  const btcUsdResponse = readFixture('nodary-btc-usd.json');
  await assert.rejects(verifySignedResponse(btcUsdResponse, NODARY_AIRNODE_V2_ADDRESS, ethUsdRequestHash), /answers/);
  // A response that claims to answer the request still fails, because the signature covers the real request hash.
  const relabeledResponse = { ...btcUsdResponse, requestHash: ethUsdRequestHash };
  await assert.rejects(
    verifySignedResponse(relabeledResponse, NODARY_AIRNODE_V2_ADDRESS, ethUsdRequestHash),
    /signed by/
  );
});
