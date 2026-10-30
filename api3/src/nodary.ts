import type { Address } from 'viem';
import {
  type AirnodeV2PassthroughRequest,
  type AirnodeV2Request,
  type AirnodeV2Route,
  derivePassthroughRequestHash,
  deriveRequestHash,
  fetchSignedPassthroughResponse,
  fetchSignedResponse,
} from './airnode-v2.ts';

export const NODARY_AIRNODE_V2_URL = 'https://airnode-nodary.fly.dev/';

// The address that the Nodary Airnode v2 signs with, from the x-airnode extension of the document at its URL.
export const NODARY_AIRNODE_V2_ADDRESS: Address = '0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0';

export const DEFAULT_FEED_NAME = 'ETH/USD';

// A JSON Pointer writes "~" in a name as "~0" and "/" as "~1", so ETH/USD becomes ETH~1USD.
const escapePointerToken = (token: string) => token.replaceAll('~', '~0').replaceAll('/', '~1');

// Nodary answers with {"ETH/USD":{"value":2443.95,"timestamp":1792403240691,"category":"crypto"}}, and the projection
// cuts that down to {"price":2443.95,"updatedAt":1792403240691}.
const buildPriceProjection = (feedName: string) => ({
  price: `/${escapePointerToken(feedName)}/value`,
  updatedAt: `/${escapePointerToken(feedName)}/timestamp`,
});

export const buildPriceRequest = (feedName: string): AirnodeV2Request => ({
  operation: 'latestFeeds',
  parameters: { name: feedName },
  responseProjection: buildPriceProjection(feedName),
});

// The same request as Nodary's own API takes it, GET /feed/latest?name=ETH/USD.
export const buildPricePassthroughRequest = (feedName: string): AirnodeV2PassthroughRequest => ({
  method: 'GET',
  path: '/feed/latest',
  query: [['name', feedName]],
  headers: [],
  body: '',
  responseProjection: buildPriceProjection(feedName),
});

export const derivePriceRequestHash = (feedName: string, route: AirnodeV2Route) =>
  route === 'passthrough'
    ? derivePassthroughRequestHash(buildPricePassthroughRequest(feedName))
    : deriveRequestHash(buildPriceRequest(feedName));

export const fetchSignedPrice = (feedName: string, route: AirnodeV2Route, fetchFunction: typeof fetch = fetch) =>
  route === 'passthrough'
    ? fetchSignedPassthroughResponse(NODARY_AIRNODE_V2_URL, buildPricePassthroughRequest(feedName), fetchFunction)
    : fetchSignedResponse(NODARY_AIRNODE_V2_URL, buildPriceRequest(feedName), fetchFunction);
