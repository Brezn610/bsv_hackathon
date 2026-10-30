// Reads deployments.json, the one place where the deployed TreasuryGuard address and the feeds it was configured with
// are kept. The BSV side imports this instead of copying addresses.
import { readFileSync } from 'node:fs';
import { type Address, getAddress, type Hex, isAddress, isHex } from 'viem';

export interface FeedConfig {
  airnode: Address;
  requestHash: Hex;
}

export interface Deployment {
  chainId: number;
  explorer: string;
  treasuryGuard: Address | null;
  // The demo vault the deploy script creates; the agent and the judge script use it.
  vaultId: number | null;
  // A second vault whose agent is the deployer, only for the judge script, so it never shares a key, budget or
  // last price with the agent loop on vaultId.
  judgeVaultId: number | null;
  deployTx: Hex | null;
  deployBlock: number | null;
  feeds: { bsvUsd: FeedConfig; tweets: Record<string, FeedConfig> };
}

export const DEPLOYMENTS_URL = new URL('../../deployments.json', import.meta.url);

const checkFeed = (name: string, feed: FeedConfig): FeedConfig => {
  if (!isAddress(feed.airnode)) throw new Error(`${name}.airnode is not an address`);
  if (!isHex(feed.requestHash) || feed.requestHash.length !== 66)
    throw new Error(`${name}.requestHash is not a bytes32`);
  return { airnode: getAddress(feed.airnode), requestHash: feed.requestHash };
};

export const loadDeployment = (network = 'baseSepolia', path: URL | string = DEPLOYMENTS_URL): Deployment => {
  const all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Deployment>;
  const deployment = all[network];
  if (!deployment) throw new Error(`deployments.json has no network ${network} (has: ${Object.keys(all).join(', ')})`);
  if (deployment.treasuryGuard !== null && !isAddress(deployment.treasuryGuard)) {
    throw new Error(`${network}.treasuryGuard is not an address`);
  }
  return {
    ...deployment,
    treasuryGuard: deployment.treasuryGuard && getAddress(deployment.treasuryGuard),
    feeds: {
      bsvUsd: checkFeed('feeds.bsvUsd', deployment.feeds.bsvUsd),
      tweets: Object.fromEntries(
        Object.entries(deployment.feeds.tweets).map(([user, feed]) => [user, checkFeed(`feeds.tweets.${user}`, feed)])
      ),
    },
  };
};

// For anything that talks to the contract: fails clearly until the deploy has been recorded.
export const requireTreasuryGuard = (deployment: Deployment): Address => {
  if (!deployment.treasuryGuard) throw new Error('TreasuryGuard is not deployed yet: deployments.json has no address');
  return deployment.treasuryGuard;
};
