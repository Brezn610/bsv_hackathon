// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {ProjectedJson} from "../contracts/ProjectedJson.sol";

// Hour-0 spike: reads the real signed CoinPaprika and TwitterAPI.io fixtures on-chain, with the signer and request hash
// written out here (as a contract would store them), never taken from the response.
contract SpikeHarness {
    function verify(address airnode, bytes32 requestHash, uint256 timestamp, bytes calldata data, bytes calldata sig)
        external
        pure
    {
        AirnodeV2Attestation.verify(airnode, requestHash, timestamp, data, sig);
    }

    function readInt(bytes calldata json, string calldata key, uint8 decimals) external pure returns (int256) {
        return ProjectedJson.readInt(json, key, decimals);
    }

    function readUint(bytes calldata json, string calldata key, uint8 decimals) external pure returns (uint256) {
        return ProjectedJson.readUint(json, key, decimals);
    }

    function readString(bytes calldata json, string calldata key) external pure returns (string memory) {
        return ProjectedJson.readString(json, key);
    }

    function readTimestamp(bytes calldata json, string calldata key) external pure returns (uint256) {
        return ProjectedJson.readTimestamp(json, key);
    }
}

contract SpikeTest is Test {
    address constant COINPAPRIKA = 0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732;
    address constant TWITTERAPI = 0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB;
    bytes32 constant BSV_USD_REQUEST = 0x18b782163c79529c7bbe757343b930284f3aef690e45560f0aa771b629399480;
    bytes32 constant BTC_USD_REQUEST = 0xcadca27a1c6328b3abbe1a10feeeec01f5e49ef4ad7de3e54797265df80850d8;
    bytes32 constant WHITEHOUSE_REQUEST = 0x783a61a36250c7dfdf26d9ea96ca3cc5894a286c9f4b4139798345cb4d9395e9;
    uint256 constant TWITTER_EPOCH_MS = 1288834974657;

    SpikeHarness harness = new SpikeHarness();

    struct Response {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    function load(string memory name) internal view returns (Response memory) {
        string memory json = vm.readFile(string.concat("test/fixtures/", name));
        return Response({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }

    function test_bsvUsd_verifiesAndReadsNegativeChange() public view {
        Response memory r = load("coinpaprika-bsv-usd.json");
        assertEq(r.requestHash, BSV_USD_REQUEST);
        harness.verify(COINPAPRIKA, BSV_USD_REQUEST, r.timestamp, r.data, r.signature);

        // {"change1h":-0.15000000596046448,"price":17.046251500133348,"updatedAt":"2026-10-30T13:03:16Z"}
        assertEq(harness.readInt(r.data, "change1h", 2), -15); // -0.15 %, cut toward zero
        assertEq(harness.readInt(r.data, "change1h", 4), -1500);
        assertEq(harness.readUint(r.data, "price", 8), 1704625150); // $17.04625150
        assertEq(harness.readTimestamp(r.data, "updatedAt"), 1793365396);
        assertLe(harness.readTimestamp(r.data, "updatedAt"), r.timestamp);
    }

    function test_btcUsd_failsAgainstBsvRequest() public {
        Response memory r = load("coinpaprika-btc-usd.json");
        harness.verify(COINPAPRIKA, BTC_USD_REQUEST, r.timestamp, r.data, r.signature);
        // Same signer, other request: recovering against the stored BSV/USD hash yields some unrelated address.
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        harness.verify(COINPAPRIKA, BSV_USD_REQUEST, r.timestamp, r.data, r.signature);
    }

    function test_readInt_handwrittenNegativeDecimal() public view {
        assertEq(harness.readInt(bytes('{"c":-1.23}'), "c", 2), -123);
        assertEq(harness.readInt(bytes('{"c":"-1.23"}'), "c", 2), -123);
    }

    function test_readInt_exponentReverts() public {
        // JSON.stringify writes |x| < 1e-6 in exponent form; the library rejects it.
        vm.expectRevert();
        harness.readInt(bytes('{"c":-1e-7}'), "c", 2);
    }

    function test_whitehouse_verifiesAndReadsSnowflakeId() public view {
        Response memory r = load("twitterapi-whitehouse.json");
        assertEq(r.requestHash, WHITEHOUSE_REQUEST);
        harness.verify(TWITTERAPI, WHITEHOUSE_REQUEST, r.timestamp, r.data, r.signature);

        uint256 id = harness.readUint(r.data, "id", 0); // the id is a JSON string, readUint accepts that
        assertEq(id, 2116153357064888354);
        uint256 postTime = ((id >> 22) + TWITTER_EPOCH_MS) / 1000;
        assertEq(postTime, 1793365251); // Fri Oct 30 13:00:51 UTC 2026, matches createdAt
        assertLe(postTime, r.timestamp);

        // No retweet boolean in the API; a native retweet's text starts with "RT @".
        assertTrue(LibString.startsWith(harness.readString(r.data, "text"), "RT @"));
    }
}
