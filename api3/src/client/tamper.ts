// Builds the rejected cases of the tamper test from a valid signed response. Pure functions, nothing is sent: the judge
// script submits the results, and the contract is what rejects them.
import { encodePacked, type Hex, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SignedResponse } from '../airnode-v2.ts';

// The hash the Airnode signs (EIP-191 over it), the same as AirnodeV2Attestation builds on-chain.
export const responseDigest = ({
  requestHash,
  timestamp,
  data,
}: Pick<SignedResponse, 'requestHash' | 'timestamp' | 'data'>) =>
  keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [requestHash, BigInt(timestamp), toHex(data)]));

// Changes one digit of a numeric field and keeps the signature, so the signer recovered on-chain is some unknown address.
export const editDigit = (response: SignedResponse, field = 'price'): SignedResponse => {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}":"?-?(\\d)`).exec(response.data);
  if (!match) throw new Error(`The data has no numeric field ${field}`);
  const digitIndex = match.index + match[0].length - 1;
  const digit = Number(response.data[digitIndex]);
  // 1 → 2, 9 → 8: the value changes in a way a viewer can see, and never gains a leading zero.
  const edited = String(digit === 9 ? 8 : digit + 1);
  return { ...response, data: response.data.slice(0, digitIndex) + edited + response.data.slice(digitIndex + 1) };
};

// Signs the same request, timestamp and data with a key that is not the Airnode's. The key is made here and dropped.
export const resignWithLocalKey = async (response: SignedResponse, privateKey: Hex = generatePrivateKey()) => {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signMessage({ message: { raw: responseDigest(response) } });
  return { response: { ...response, airnode: account.address, signature }, signer: account.address };
};

// Seconds between signing and `now`, to tell whether a response is past the contract's max signature age.
export const signatureAge = (response: SignedResponse, now = Math.floor(Date.now() / 1000)) =>
  now - Number(response.timestamp);
