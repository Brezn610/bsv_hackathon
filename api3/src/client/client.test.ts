import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverSigner, type SignedResponse, verifySignedResponse } from '../airnode-v2.ts';
import { loadDeployment } from './deployments.ts';
import {
  BSV_USD,
  BTC_USD,
  feedRequestHash,
  isRetweet,
  parsePriceData,
  parseTweetData,
  tweetFeed,
  tweetPostedAt,
} from './feeds.ts';
import { editDigit, resignWithLocalKey, signatureAge } from './tamper.ts';

// Bought once by src/spike.ts and cached, never fetched again.
const readFixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')) as SignedResponse;

const bsvUsd = readFixture('coinpaprika-bsv-usd.json');
const btcUsd = readFixture('coinpaprika-btc-usd.json');
const whiteHouse = readFixture('twitterapi-whitehouse.json');
const whiteHouseFeed = tweetFeed('WhiteHouse');

test('derives the request hashes the Airnodes signed', () => {
  assert.equal(feedRequestHash(BSV_USD), bsvUsd.requestHash);
  assert.equal(feedRequestHash(BTC_USD), btcUsd.requestHash);
  assert.equal(feedRequestHash(whiteHouseFeed), whiteHouse.requestHash);
});

test('the cached responses verify against their feeds', async () => {
  await verifySignedResponse(bsvUsd, BSV_USD.airnode, feedRequestHash(BSV_USD));
  await verifySignedResponse(btcUsd, BTC_USD.airnode, feedRequestHash(BTC_USD));
  await verifySignedResponse(whiteHouse, whiteHouseFeed.airnode, feedRequestHash(whiteHouseFeed));
});

test('deployments.json matches the feeds', () => {
  const { feeds } = loadDeployment();
  assert.equal(feeds.bsvUsd.airnode, BSV_USD.airnode);
  assert.equal(feeds.bsvUsd.requestHash, feedRequestHash(BSV_USD));
  assert.equal(feeds.tweets.WhiteHouse?.airnode, whiteHouseFeed.airnode);
  assert.equal(feeds.tweets.WhiteHouse?.requestHash, feedRequestHash(whiteHouseFeed));
  assert.equal(feeds.tweets.federalreserve?.requestHash, feedRequestHash(tweetFeed('federalreserve')));
});

test('parses price and tweet data', () => {
  const price = parsePriceData(bsvUsd.data);
  assert.equal(typeof price.price, 'number');
  assert.equal(typeof price.change1h, 'number');
  const tweet = parseTweetData(whiteHouse.data);
  assert.equal(typeof tweet.id, 'string');
  assert.equal(isRetweet(tweet), true);
});

test('reads the post time from the tweet id', () => {
  // createdAt of that post: Fri Oct 30 13:00:51 +0000 2026
  assert.equal(tweetPostedAt(parseTweetData(whiteHouse.data).id), Date.UTC(2026, 9, 30, 13, 0, 51) / 1000);
});

test('an edited digit no longer recovers to the Airnode', async () => {
  const edited = editDigit(bsvUsd);
  assert.notEqual(edited.data, bsvUsd.data);
  assert.equal(edited.data.length, bsvUsd.data.length);
  assert.notEqual(parsePriceData(edited.data).price, parsePriceData(bsvUsd.data).price);
  await assert.rejects(verifySignedResponse(edited, BSV_USD.airnode, feedRequestHash(BSV_USD)), /is signed by/);
});

test('edits the digit after a minus sign', () => {
  const edited = editDigit(bsvUsd, 'change1h');
  assert.ok(parsePriceData(edited.data).change1h < 0);
  assert.notEqual(parsePriceData(edited.data).change1h, parsePriceData(bsvUsd.data).change1h);
});

test('a local key signs a valid signature that is not the Airnode', async () => {
  const key = generatePrivateKey();
  const { response, signer } = await resignWithLocalKey(bsvUsd, key);
  assert.equal(signer, privateKeyToAccount(key).address);
  assert.equal(await recoverSigner(response), signer);
  await assert.rejects(verifySignedResponse(response, BSV_USD.airnode, feedRequestHash(BSV_USD)), /is signed by/);
});

test('another request is rejected against the BSV/USD hash', async () => {
  await assert.rejects(verifySignedResponse(btcUsd, BSV_USD.airnode, feedRequestHash(BSV_USD)), /answers the request/);
});

test('measures the signature age', () => {
  assert.equal(signatureAge(bsvUsd, Number(bsvUsd.timestamp) + 301), 301);
});
