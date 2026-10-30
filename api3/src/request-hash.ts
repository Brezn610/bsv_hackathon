import { derivePriceRequestHash } from './nodary.ts';
import { parseScriptArguments } from './script-options.ts';

const { feedName, route } = parseScriptArguments();
console.log(derivePriceRequestHash(feedName, route));
