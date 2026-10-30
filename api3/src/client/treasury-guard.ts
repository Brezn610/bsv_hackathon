// A small client for TreasuryGuard: fetch a signed response, verify it off-chain, submit it, read the result. The agent
// and the BSV side import this instead of talking to the contract directly. Interface: API3-NOTES.md, "TreasuryGuard
// interface (v1)".
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  parseEventLogs,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { fetchSignedResponse, type SignedResponse, verifySignedResponse } from '../airnode-v2.ts';
import { treasuryGuardAbi } from './abi.ts';
import { type Deployment, loadDeployment, requireTreasuryGuard } from './deployments.ts';
import { BSV_USD, type Feed, feedRequestHash, tweetFeed } from './feeds.ts';

export const Regime = ['NORMAL', 'RISK_OFF', 'GUARDED'] as const;
export const Kind = ['SPEND', 'SWAP'] as const;
export const Direction = ['NONE', 'SATS_TO_DUSD', 'DUSD_TO_SATS'] as const;
export const Source = ['BUDGET', 'BREAKER', 'REENTRY', 'EVENT'] as const;
export const Verdict = { IGNORE: 0, RISK_OFF: 1, RISK_ON: 2 } as const;

// Contract units: USD 6 decimals, price 8 decimals (USD per BSV), change1h and bps hundredths of a percent.
export const usd = (dollars: number) => BigInt(Math.round(dollars * 1e6));
export const formatUsd = (amount: bigint) => (Number(amount) / 1e6).toFixed(6);
export const formatPrice = (price: bigint) => (Number(price) / 1e8).toFixed(8);
export const formatBps = (bps: bigint | number) => `${(Number(bps) / 100).toFixed(2)} %`;

// The response as the contract takes it: data as the bytes of the exact signed string, timestamp as a number.
export const toResponseTuple = ({ requestHash, timestamp, data, signature }: SignedResponse) => ({
  requestHash,
  timestamp: BigInt(timestamp),
  data: toHex(data),
  signature,
});

// A revert of TreasuryGuard by its error name, such as SignerMismatch, instead of viem's hundreds of lines.
export class ContractRejection extends Error {
  readonly errorName: string;
  readonly args: readonly unknown[];
  constructor(errorName: string, args: readonly unknown[]) {
    super(`${errorName}(${args.map(String).join(', ')})`);
    this.errorName = errorName;
    this.args = args;
  }
}

export const toContractRejection = (error: unknown): ContractRejection | undefined => {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError) || !revert.data?.errorName) return undefined;
  return new ContractRejection(revert.data.errorName, revert.data.args ?? []);
};

const rethrowRejection = (error: unknown): never => {
  throw toContractRejection(error) ?? error;
};

export interface TreasuryGuardClientOptions {
  rpcUrl: string;
  // Only needed to submit: the vault's agent key. Never logged.
  privateKey?: Hex;
  deployment?: Deployment;
  // Most blocks per eth_getLogs call. 200 fits the public Base Sepolia RPC; a keyed RPC allows more.
  logBlockRange?: bigint;
}

export const createTreasuryGuardClient = ({
  rpcUrl,
  privateKey,
  deployment = loadDeployment(),
  logBlockRange = 200n,
}: TreasuryGuardClientOptions) => {
  const address = requireTreasuryGuard(deployment);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const account = privateKey && privateKeyToAccount(privateKey);
  const walletClient = account && createWalletClient({ account, transport: http(rpcUrl) });
  const contract = { address, abi: treasuryGuardAbi } as const;

  const requireWallet = () => {
    if (!walletClient || !account) throw new Error('This call sends a transaction: pass the agent privateKey');
    return { walletClient, account };
  };

  // Fetching and the off-chain check use the feeds deployments.json says the contract was configured with, so a feed
  // that drifted from the deploy fails here, before it costs a payment's worth of gas.
  const fetchVerified = async (feed: Feed, expectedHash: Hex, fetchFunction?: typeof fetch) => {
    if (feedRequestHash(feed) !== expectedHash) {
      throw new Error(`The feed's request hash ${feedRequestHash(feed)} is not the deployed ${expectedHash}`);
    }
    const response = await fetchSignedResponse(feed.url, feed.request, fetchFunction);
    await verifySignedResponse(response, feed.airnode, expectedHash);
    return response;
  };

  // Writes are simulated first, so a rejected response reverts here with its error name and costs no gas.
  const send = async (functionName: 'submitPrice' | 'submitEvent' | 'settle', args: readonly unknown[]) => {
    const { walletClient, account } = requireWallet();
    const { request } = await publicClient
      .simulateContract({ ...contract, functionName, args, account } as Parameters<
        typeof publicClient.simulateContract
      >[0])
      .catch(rethrowRejection);
    const hash = await walletClient.writeContract({ ...request, chain: null } as Parameters<
      typeof walletClient.writeContract
    >[0]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
    const events = parseEventLogs({ abi: treasuryGuardAbi, logs: receipt.logs });
    return { hash, receipt, events };
  };

  return {
    address,
    deployment,
    publicClient,
    agent: account?.address,

    /** Pays via x402 when given a fetch from createPayingFetch (src/x402.ts). */
    fetchPrice: (fetchFunction?: typeof fetch) =>
      fetchVerified(BSV_USD, deployment.feeds.bsvUsd.requestHash, fetchFunction),
    fetchPost: (userName: string, fetchFunction?: typeof fetch) => {
      const feed = deployment.feeds.tweets[userName];
      if (!feed) throw new Error(`${userName} is not a whitelisted account in deployments.json`);
      return fetchVerified(tweetFeed(userName), feed.requestHash, fetchFunction);
    },

    /** Runs every check of submitPrice with eth_call: free, throws ContractRejection like the write would. */
    checkPrice: (vaultId: bigint, response: SignedResponse) =>
      publicClient
        .readContract({ ...contract, functionName: 'checkPrice', args: [vaultId, toResponseTuple(response)] })
        .catch(rethrowRejection),
    checkEvent: (vaultId: bigint, post: SignedResponse, price: SignedResponse) =>
      publicClient
        .readContract({
          ...contract,
          functionName: 'checkEvent',
          args: [vaultId, toResponseTuple(post), toResponseTuple(price)],
        })
        .catch(rethrowRejection),

    /** Simulates submitPrice as the agent without sending it, e.g. to show BudgetExceeded for free. */
    simulateSubmitPrice: (vaultId: bigint, price: SignedResponse, usdAmount: bigint) =>
      publicClient
        .simulateContract({
          ...contract,
          functionName: 'submitPrice',
          args: [vaultId, toResponseTuple(price), usdAmount],
          account: requireWallet().account,
        })
        .then(({ result }) => result)
        .catch(rethrowRejection),
    /** Creates a SPEND intent for `usdAmount` (6 decimals, 0 for none) and may trigger the breaker. */
    submitPrice: async (vaultId: bigint, price: SignedResponse, usdAmount: bigint) => {
      const result = await send('submitPrice', [vaultId, toResponseTuple(price), usdAmount]);
      return { ...result, intents: result.events.filter((event) => event.eventName === 'IntentCreated') };
    },
    submitEvent: async (
      vaultId: bigint,
      post: SignedResponse,
      price: SignedResponse,
      verdict: number,
      analystSig: Hex = '0x'
    ) => {
      const result = await send('submitEvent', [
        vaultId,
        toResponseTuple(post),
        toResponseTuple(price),
        verdict,
        analystSig,
      ]);
      return { ...result, intents: result.events.filter((event) => event.eventName === 'IntentCreated') };
    },
    settle: (intentId: bigint, bsvTxid: Hex) => send('settle', [intentId, bsvTxid]),

    getIntent: (intentId: bigint) =>
      publicClient.readContract({ ...contract, functionName: 'getIntent', args: [intentId] }),
    remainingUsdToday: (vaultId: bigint) =>
      publicClient.readContract({ ...contract, functionName: 'remainingUsdToday', args: [vaultId] }),
    regime: async (vaultId: bigint) =>
      Regime[await publicClient.readContract({ ...contract, functionName: 'regime', args: [vaultId] })],
    lastPrice: (vaultId: bigint) =>
      publicClient.readContract({ ...contract, functionName: 'lastPrice', args: [vaultId] }),
    getVaultConfig: (vaultId: bigint) =>
      publicClient.readContract({ ...contract, functionName: 'getVaultConfig', args: [vaultId] }),

    /** All intents of a vault since `fromBlock` (default: the deploy block), e.g. for a watcher catching up. Reads the
     * logs in chunks of `logBlockRange` blocks, since public RPCs cap eth_getLogs (sepolia.base.org: 200 blocks). */
    getIntentEvents: async (vaultId?: bigint, fromBlock = BigInt(deployment.deployBlock ?? 0)) => {
      const latest = await publicClient.getBlockNumber();
      const events = [];
      for (let from = fromBlock; from <= latest; from += logBlockRange) {
        const to = from + logBlockRange - 1n < latest ? from + logBlockRange - 1n : latest;
        events.push(
          ...(await publicClient.getContractEvents({
            ...contract,
            eventName: 'IntentCreated',
            args: vaultId === undefined ? undefined : { vaultId },
            fromBlock: from,
            toBlock: to,
          }))
        );
      }
      return events;
    },
    /** Calls `onIntent` for every new IntentCreated. Returns the function that stops watching. */
    watchIntents: (onIntent: (intentId: bigint, vaultId: bigint) => void, vaultId?: bigint) =>
      publicClient.watchContractEvent({
        ...contract,
        eventName: 'IntentCreated',
        args: vaultId === undefined ? undefined : { vaultId },
        onLogs: (logs) => {
          for (const { args } of logs)
            if (args.intentId !== undefined && args.vaultId !== undefined) onIntent(args.intentId, args.vaultId);
        },
      }),
  };
};

export type TreasuryGuardClient = ReturnType<typeof createTreasuryGuardClient>;
export type { Address };
