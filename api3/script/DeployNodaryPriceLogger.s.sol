// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {NodaryPriceLogger} from "../contracts/examples/NodaryPriceLogger.sol";

contract DeployNodaryPriceLogger is Script {
    function run() external returns (NodaryPriceLogger logger) {
        // `pnpm --silent request-hash <feed name>` prints it.
        bytes32 requestHash = vm.envBytes32("REQUEST_HASH");
        vm.broadcast(vm.envUint("PRIVATE_KEY"));
        logger = new NodaryPriceLogger(requestHash);
    }
}
