import { readFileSync } from 'node:fs';
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  formatUnits,
  http,
  isAddress,
  isHex,
  parseAbi,
  parseEventLogs,
  publicActions,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type AirnodeV2Route, type SignedResponse, verifySignedResponse } from './airnode-v2.ts';
import { derivePriceRequestHash, fetchSignedPrice, NODARY_AIRNODE_V2_ADDRESS } from './nodary.ts';
import { createScriptFetch, parseSubmitArguments } from './script-options.ts';

const consumerAbi = parseAbi([
  'function submitResponse(uint256 timestamp, bytes data, bytes signature)',
  'event PriceConsumed(uint256 price, uint256 priceTimestamp)',
  'error NotSignedByAirnode(address signer)',
  'error ResponseTooOld(uint256 responseTimestamp)',
  'error PriceTooOld(uint256 priceTimestamp)',
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureLength(uint256 length)',
  'error ECDSAInvalidSignatureS(bytes32 s)',
]);

const readEnvironmentVariable = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env or in the environment`);
  return value;
};

const consumerAddress = readEnvironmentVariable('CONSUMER_ADDRESS');
const privateKey = readEnvironmentVariable('PRIVATE_KEY');
if (!isAddress(consumerAddress)) throw new Error('CONSUMER_ADDRESS is not an address');
if (!isHex(privateKey)) throw new Error('PRIVATE_KEY is not a 0x-prefixed hex string');

const fetchCheckedPrice = async (feedName: string, route: AirnodeV2Route) => {
  const signedResponse = await fetchSignedPrice(feedName, route, createScriptFetch());
  await verifySignedResponse(signedResponse, NODARY_AIRNODE_V2_ADDRESS, derivePriceRequestHash(feedName, route));
  return signedResponse;
};

// Skips the off-chain check, so a tampered response reaches the contract, and the contract is what rejects it.
const readResponseFile = (path: string) => {
  const { timestamp, data, signature } = JSON.parse(readFileSync(path, 'utf8')) as Partial<SignedResponse>;
  if (typeof timestamp !== 'string' || typeof data !== 'string' || !isHex(signature)) {
    throw new Error(`${path} needs timestamp, data and signature as strings, as fetch-response prints them`);
  }
  return { timestamp, data, signature };
};

// Must be the feed and the route whose request hash the consumer was deployed with.
const { feedName, route, responseFile } = parseSubmitArguments();
const signedResponse = responseFile ? readResponseFile(responseFile) : await fetchCheckedPrice(feedName, route);

// viem's error for a revert runs to hundreds of lines, so this one names only the error that the contract reverted with.
const throwContractError = (error: unknown): never => {
  const revertError =
    error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(revertError instanceof ContractFunctionRevertedError) || !revertError.data) throw error;
  const { errorName, args = [] } = revertError.data;
  throw new Error(`The contract rejected the response with ${errorName}(${args.join(', ')})`);
};

const client = createWalletClient({
  account: privateKeyToAccount(privateKey),
  transport: http(readEnvironmentVariable('RPC_URL')),
}).extend(publicActions);

const transactionHash = await client
  .writeContract({
    address: consumerAddress,
    abi: consumerAbi,
    functionName: 'submitResponse',
    args: [BigInt(signedResponse.timestamp), toHex(signedResponse.data), signedResponse.signature],
    chain: null,
  })
  .catch(throwContractError);
const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });

const [priceConsumed] = parseEventLogs({ abi: consumerAbi, eventName: 'PriceConsumed', logs: receipt.logs });
if (!priceConsumed) throw new Error(`Transaction ${transactionHash} emitted no PriceConsumed event`);
const { price, priceTimestamp } = priceConsumed.args;
const priceTakenAt = new Date(Number(priceTimestamp) * 1000).toISOString();
console.log(`Submitted ${signedResponse.data} in transaction ${transactionHash}`);
console.log(`The contract consumed the price ${formatUnits(price, 18)}, taken at ${priceTakenAt}`);
