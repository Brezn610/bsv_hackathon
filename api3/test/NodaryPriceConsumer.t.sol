// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {NodaryPriceLogger} from "../contracts/examples/NodaryPriceLogger.sol";
import {NodaryPriceConsumer} from "../contracts/examples/NodaryPriceConsumer.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

contract NodaryPriceConsumerTest is AirnodeV2Test {
    struct SignedResponse {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    SignedResponse ethUsdResponse;
    NodaryPriceLogger logger;

    function setUp() public {
        ethUsdResponse = readFixture("nodary-eth-usd.json");
        logger = new NodaryPriceLogger(ethUsdResponse.requestHash);
        vm.warp(ethUsdResponse.timestamp + 10);
    }

    function test_ConsumesThePriceFromARealResponse() public {
        // {"price":2443.22,"updatedAt":1792403485279}
        vm.expectEmit(address(logger));
        emit NodaryPriceLogger.PriceConsumed(2443.22e18, 1792403485);
        submit(ethUsdResponse);
    }

    function test_AcceptsTheSameResponseAgain() public {
        // The checks cannot tell a repeated response from a new one, so consumePrice decides whether that matters.
        submit(ethUsdResponse);

        vm.expectEmit(address(logger));
        emit NodaryPriceLogger.PriceConsumed(2443.22e18, 1792403485);
        submit(ethUsdResponse);
    }

    // The next four tests are the tamper test from the hackathon brief.

    function test_RevertWhen_AValueIsEdited() public {
        SignedResponse memory editedResponse = ethUsdResponse;
        editedResponse.data = '{"price":1443.22,"updatedAt":1792403485279}';

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        submit(editedResponse);
    }

    function test_RevertWhen_TheResponseIsTooOld() public {
        vm.warp(ethUsdResponse.timestamp + logger.MAX_RESPONSE_AGE() + 1);

        vm.expectRevert(abi.encodeWithSelector(NodaryPriceConsumer.ResponseTooOld.selector, ethUsdResponse.timestamp));
        submit(ethUsdResponse);
    }

    function test_RevertWhen_TheResponseAnswersAnotherRequest() public {
        // A real response for BTC/USD, with the same projection
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        submit(readFixture("nodary-btc-usd.json"));
    }

    function test_RevertWhen_AnotherKeySigned() public {
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        SignedResponse memory forgedResponse = ethUsdResponse;
        forgedResponse.signature =
            signResponse(impostorKey, ethUsdResponse.requestHash, ethUsdResponse.timestamp, ethUsdResponse.data);

        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        submit(forgedResponse);
    }

    function test_RevertWhen_ThePriceIsTooOld() public {
        // A real response that the Airnode signed right away, over an exchange rate that Nodary took a day earlier:
        // {"price":1.242201671126427,"updatedAt":1792317926718}
        SignedResponse memory exchangeRateResponse = readFixture("nodary-ankreth-eth-exchange-rate.json");
        logger = new NodaryPriceLogger(exchangeRateResponse.requestHash);
        vm.warp(exchangeRateResponse.timestamp + 10);

        vm.expectRevert(abi.encodeWithSelector(NodaryPriceConsumer.PriceTooOld.selector, 1792317926));
        submit(exchangeRateResponse);
    }

    // Reads a response that `pnpm --silent fetch-response <feed name>` saved.
    function readFixture(string memory name) private view returns (SignedResponse memory) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(string.concat("test/fixtures/", name));
        return SignedResponse({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }

    function submit(SignedResponse memory response) private {
        logger.submitResponse(response.timestamp, response.data, response.signature);
    }
}
