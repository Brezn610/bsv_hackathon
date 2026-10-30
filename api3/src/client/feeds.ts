// The signed data sources Treasury Guard reads: one Airnode request per feed, so the request hash the contract stores
// can be derived here without any call. Every field below changes the hash, so keep them in sync with the deploy config.
import type { Address, Hex } from 'viem';
import { type AirnodeV2Request, deriveRequestHash } from '../airnode-v2.ts';

export const COINPAPRIKA = {
  url: 'https://airnode-coinpaprika.fly.dev/',
  airnode: '0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732' as Address,
} as const;

export const TWITTERAPI = {
  url: 'https://airnode-twitterapi.fly.dev/',
  airnode: '0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB' as Address,
} as const;

export interface Feed {
  url: string;
  airnode: Address;
  request: AirnodeV2Request;
}

// CoinPaprika's parameter is coin_id, not id. quotes is sent explicitly so the hash does not depend on a default.
export const tickerRequest = (coinId: string): AirnodeV2Request => ({
  operation: 'getTickersById',
  parameters: { coin_id: coinId, quotes: 'USD' },
  responseProjection: {
    change1h: '/quotes/USD/percent_change_1h',
    price: '/quotes/USD/price',
    updatedAt: '/last_updated',
  },
});

// tweets[0] is the newest post (the pinned one is separate), and the id arrives as a JSON string.
export const lastTweetRequest = (userName: string): AirnodeV2Request => ({
  operation: 'userLastTweets',
  parameters: { userName },
  responseProjection: { id: '/data/tweets/0/id', text: '/data/tweets/0/text' },
});

export const priceFeed = (coinId: string): Feed => ({ ...COINPAPRIKA, request: tickerRequest(coinId) });
export const tweetFeed = (userName: string): Feed => ({ ...TWITTERAPI, request: lastTweetRequest(userName) });

export const BSV_USD = priceFeed('bsv-bitcoin-sv');
// Same signer, other request: what the WrongRequest tamper case submits.
export const BTC_USD = priceFeed('btc-bitcoin');

export const feedRequestHash = (feed: Feed): Hex => deriveRequestHash(feed.request);

export interface PriceData {
  price: number;
  change1h: number;
  updatedAt: string;
}

export interface TweetData {
  id: string;
  text: string;
}

export const parsePriceData = (data: string) => JSON.parse(data) as PriceData;
export const parseTweetData = (data: string) => JSON.parse(data) as TweetData;

// There is no retweet flag in the response; a retweet's text starts with "RT @".
export const isRetweet = ({ text }: TweetData) => text.startsWith('RT @');

// Twitter's Snowflake id carries the post time, which the contract also derives on-chain.
const TWITTER_EPOCH_MS = 1288834974657n;
export const tweetPostedAt = (id: string) => Number(((BigInt(id) >> 22n) + TWITTER_EPOCH_MS) / 1000n);
