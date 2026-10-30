import { parseArgs } from 'node:util';
import { isHex } from 'viem';
import type { AirnodeV2Route } from './airnode-v2.ts';
import { DEFAULT_FEED_NAME } from './nodary.ts';
import { createPayingFetch, readPaymentSettlement } from './x402.ts';

const SCRIPT_OPTIONS = { passthrough: { type: 'boolean', default: false } } as const;

// Every script takes `[feed name] [--passthrough]`, and calls POST / unless it is given --passthrough.
const readFeedNameAndRoute = (positionals: string[], passthrough: boolean) => {
  const route: AirnodeV2Route = passthrough ? 'passthrough' : 'post';
  return { feedName: positionals[0] ?? DEFAULT_FEED_NAME, route };
};

export const parseScriptArguments = () => {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: SCRIPT_OPTIONS });
  return readFeedNameAndRoute(positionals, values.passthrough);
};

// submit-response also takes `--file <response.json>`, to submit a saved response instead of fetching one.
export const parseSubmitArguments = () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { ...SCRIPT_OPTIONS, file: { type: 'string' } },
  });
  return { ...readFeedNameAndRoute(positionals, values.passthrough), responseFile: values.file };
};

// The Airnode answers an unpaid call to a priced operation with only {"error":"Payment required"}.
const fetchWithoutPayer: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status !== 402) return response;
  throw new Error(
    'The operation is priced and answered 402. Set PAYER_PRIVATE_KEY in .env to an account that holds testnet aUSD on Base Sepolia, and the scripts pay for it'
  );
};

// Prints to stderr, so that `pnpm --silent fetch-response > response.json` saves only the response.
const wrapFetchWithSettlementPrinting =
  (payingFetch: typeof fetch): typeof fetch =>
  async (input, init) => {
    const response = await payingFetch(input, init);
    const settlement = readPaymentSettlement(response);
    if (!settlement) return response;
    console.error(
      settlement.success
        ? `The payment settled in transaction https://sepolia.basescan.org/tx/${settlement.transaction}`
        : `The payment did not settle: ${settlement.errorReason}`
    );
    return response;
  };

// The scripts pay for a priced operation in aUSD when PAYER_PRIVATE_KEY is set.
export const createScriptFetch = (): typeof fetch => {
  const payerPrivateKey = process.env.PAYER_PRIVATE_KEY;
  if (!payerPrivateKey) return fetchWithoutPayer;
  if (!isHex(payerPrivateKey)) throw new Error('PAYER_PRIVATE_KEY is not a 0x-prefixed hex string');

  return wrapFetchWithSettlementPrinting(createPayingFetch(payerPrivateKey));
};
