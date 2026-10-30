// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NodaryPriceConsumer} from "./NodaryPriceConsumer.sol";

/// @title Emits every price that passes the checks of NodaryPriceConsumer
/// @notice The smallest contract that implements `consumePrice`. Replace the event with your own logic.
contract NodaryPriceLogger is NodaryPriceConsumer {
    event PriceConsumed(uint256 price, uint256 priceTimestamp);

    constructor(bytes32 requestHash_) NodaryPriceConsumer(requestHash_) {}

    function consumePrice(uint256 price, uint256 priceTimestamp) internal override {
        emit PriceConsumed(price, priceTimestamp);
    }
}
