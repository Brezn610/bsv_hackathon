// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AirnodeV2Attestation} from "../AirnodeV2Attestation.sol";
import {ProjectedJson} from "../ProjectedJson.sol";

/// @title Consumes prices from responses that the Nodary Airnode v2 signed
/// @notice Anyone can submit a signed response, such as a user, a keeper bot or an agent. The contract checks the
/// signer, the request and the time itself, so it does not have to trust whoever submits the response. Then it passes
/// the price to `consumePrice`, which a contract that inherits from this one implements.
abstract contract NodaryPriceConsumer {
    /// @notice Longest time from the Airnode signing a response to the contract accepting it
    uint256 public constant MAX_RESPONSE_AGE = 1 minutes;

    /// @notice Longest time from Nodary taking a price to the contract accepting it
    uint256 public constant MAX_PRICE_AGE = 1 minutes;

    /// @notice Address that the Nodary Airnode v2 signs with
    /// @dev From the x-airnode extension of the document at https://airnode-nodary.fly.dev/
    address public constant AIRNODE_V2 = 0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0;

    /// @notice Hash of the only request whose responses the contract accepts
    /// @dev It covers the operation, its parameters and the projection, so it fixes the feed and the fields that the
    /// signed data has. `pnpm request-hash` prints it.
    bytes32 public immutable requestHash;

    error ResponseTooOld(uint256 responseTimestamp);
    error PriceTooOld(uint256 priceTimestamp);

    constructor(bytes32 requestHash_) {
        requestHash = requestHash_;
    }

    /// @notice Verifies a signed response and passes its price to `consumePrice`
    /// @param timestamp `timestamp` of the response
    /// @param data `data` of the response, as the JSON string that the Airnode signed
    /// @param signature `signature` of the response
    function submitResponse(uint256 timestamp, bytes calldata data, bytes calldata signature) external {
        // The signer and the request. The stored request hash goes into the digest, so a response to another request
        // recovers a different signer.
        AirnodeV2Attestation.verify(AIRNODE_V2, requestHash, timestamp, data, signature);

        // The time. The signature covers the timestamp, so the timestamp is trustworthy from here on.
        if (timestamp + MAX_RESPONSE_AGE < block.timestamp) revert ResponseTooOld(timestamp);

        // The data. The request hash fixes the projection, so the data has these two fields.
        uint256 price = ProjectedJson.readUint(data, "price", 18);
        // Nodary gives its timestamps in milliseconds.
        uint256 priceTimestamp = ProjectedJson.readUint(data, "updatedAt", 0) / 1000;
        if (priceTimestamp + MAX_PRICE_AGE < block.timestamp) revert PriceTooOld(priceTimestamp);

        consumePrice(price, priceTimestamp);
    }

    /// @notice Does what your contract does with a price, such as settling a bet or paying out a claim
    /// @dev It runs only for a price that passed every check. Anyone can submit the same response again, so if a
    /// repeated or an older price matters to your contract, compare `priceTimestamp` with the last one that you used.
    /// @param price Price with 18 decimals
    /// @param priceTimestamp Unix time in seconds at which Nodary took the price
    function consumePrice(uint256 price, uint256 priceTimestamp) internal virtual;
}
