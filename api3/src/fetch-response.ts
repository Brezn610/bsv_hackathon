import { verifySignedResponse } from './airnode-v2.ts';
import { derivePriceRequestHash, fetchSignedPrice, NODARY_AIRNODE_V2_ADDRESS } from './nodary.ts';
import { createScriptFetch, parseScriptArguments } from './script-options.ts';

const { feedName, route } = parseScriptArguments();
const signedResponse = await fetchSignedPrice(feedName, route, createScriptFetch());
await verifySignedResponse(signedResponse, NODARY_AIRNODE_V2_ADDRESS, derivePriceRequestHash(feedName, route));
console.log(JSON.stringify(signedResponse, null, 2));
