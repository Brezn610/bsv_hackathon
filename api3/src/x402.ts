import { ExactEvmScheme } from '@x402/evm';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Base Sepolia, a testnet, where the Airnodes take payment, so a priced call costs nothing real.
export const BASE_SEPOLIA = 'eip155:84532';

// AirnodeHub USD (aUSD), the only asset that the Airnodes accept. It comes from the faucet that
// https://api3dao.github.io/airnodehub-hackathon/docs/from-api-to-contract#paying-with-x402 describes.
export const AUSD_ADDRESS = '0xbeA34973e5f67F18F656A2C6070C64326C791808';

// The most that one call can cost: one dollar, in aUSD and in the assets that the client knows. Raise both to pay for
// pricier calls. aUSD has 6 decimals.
const MAX_USD_PER_PAYMENT = '$1';
const MAX_AUSD_PER_PAYMENT = '1000000';

// Wraps fetch so that it answers a 402 by signing the aUSD payment that the Airnode asks for, and sending the call
// again. The payer needs aUSD on Base Sepolia, but no ETH, because the facilitator submits the transfer.
export const createPayingFetch = (payerPrivateKey: Hex, fetchFunction: typeof fetch = fetch): typeof fetch =>
  wrapFetchWithPaymentFromConfig(fetchFunction, {
    schemes: [{ network: BASE_SEPOLIA, client: new ExactEvmScheme(privateKeyToAccount(payerPrivateKey)) }],
    // The client pays only in the assets that it knows, such as USDC, unless it is told to accept another.
    spendControls: {
      maxAmountPerPayment: MAX_USD_PER_PAYMENT,
      allowedAssets: [{ network: BASE_SEPOLIA, asset: AUSD_ADDRESS, maxAmountPerPayment: MAX_AUSD_PER_PAYMENT }],
    },
    // The client would also pay in the assets that it knows, so keep only aUSD.
    policies: [
      (_x402Version, requirements) =>
        requirements.filter((requirement) => requirement.asset.toLowerCase() === AUSD_ADDRESS.toLowerCase()),
    ],
  });

// The Airnode answers a paid call with the settlement of the payment in the PAYMENT-RESPONSE header, such as the
// transaction that moved the payment. A call that was not paid has no settlement.
export const readPaymentSettlement = (response: Response) => {
  const header = response.headers.get('PAYMENT-RESPONSE');
  return header ? decodePaymentResponseHeader(header) : undefined;
};
