// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";
import {TreasuryGuard} from "../contracts/TreasuryGuard.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

contract TreasuryGuardTest is AirnodeV2Test {
    // Real Airnodes and request hashes from the hour-0 spike (API3-NOTES.md).
    address constant COINPAPRIKA = 0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732;
    address constant TWITTERAPI = 0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB;
    bytes32 constant BSV_USD_REQUEST = 0x18b782163c79529c7bbe757343b930284f3aef690e45560f0aa771b629399480;
    bytes32 constant BTC_USD_REQUEST = 0xcadca27a1c6328b3abbe1a10feeeec01f5e49ef4ad7de3e54797265df80850d8;
    bytes32 constant WHITEHOUSE_REQUEST = 0x783a61a36250c7dfdf26d9ea96ca3cc5894a286c9f4b4139798345cb4d9395e9;
    bytes32 constant FEDERALRESERVE_REQUEST = 0xceecf6d2b5c25f57242052a0a59ca73222bf017e41a7ec13418fe1207b7b9ec6;

    // Local keys stand in for the Airnodes where a test needs data that the real ones did not sign.
    uint256 constant PRICE_KEY = 0xA11CE;
    uint256 constant POST_KEY = 0xB0B;
    uint256 constant ATTACKER_KEY = 0xBAD;
    bytes32 constant TEST_PRICE_REQUEST = keccak256("test BSV/USD");
    bytes32 constant TEST_POST_REQUEST = keccak256("test account");

    uint256 constant TWITTER_EPOCH_MS = 1288834974657;
    uint256 constant BUDGET = 5e6; // $5
    // Fixture times: signed at, and the ISO updatedAt of the real BSV/USD price.
    uint256 constant T0 = 1793365414;
    string constant UPDATED_AT = "2026-10-30T13:03:16Z";
    uint256 constant UPDATED_AT_TS = 1793365396;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    TreasuryGuard guard;
    uint256 realVault;
    uint256 testVault;

    function setUp() public {
        vm.warp(T0 + 10);
        guard = new TreasuryGuard();

        bytes32[] memory realPosts = new bytes32[](2);
        realPosts[0] = WHITEHOUSE_REQUEST;
        realPosts[1] = FEDERALRESERVE_REQUEST;
        vm.prank(owner);
        realVault = guard.createVault(config(COINPAPRIKA, BSV_USD_REQUEST, TWITTERAPI), realPosts);

        bytes32[] memory testPosts = new bytes32[](1);
        testPosts[0] = TEST_POST_REQUEST;
        vm.prank(owner);
        testVault = guard.createVault(config(vm.addr(PRICE_KEY), TEST_PRICE_REQUEST, vm.addr(POST_KEY)), testPosts);
    }

    // ---------- helpers ----------

    function config(address priceAirnode, bytes32 priceRequest, address postAirnode)
        internal
        view
        returns (TreasuryGuard.VaultConfig memory)
    {
        return TreasuryGuard.VaultConfig({
            owner: address(0), // the contract sets the caller
            agent: agent,
            priceAirnode: priceAirnode,
            priceRequestHash: priceRequest,
            postAirnode: postAirnode,
            dailyBudgetUsd: BUDGET,
            maxSignatureAge: 300,
            maxDataAge: 600,
            maxPostAge: 1800,
            cooldown: 3600,
            intentTtl: 900,
            breakerBps: -500,
            reentryBps: 100,
            breakerHedgeBps: 5000,
            eventHedgeBps: 2500,
            slippageBps: 100
        });
    }

    function load(string memory name) internal view returns (TreasuryGuard.SignedResponse memory) {
        string memory json = vm.readFile(string.concat("test/fixtures/", name));
        return TreasuryGuard.SignedResponse({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }

    function signed(uint256 key, bytes32 requestHash, uint256 timestamp, bytes memory data)
        internal
        pure
        returns (TreasuryGuard.SignedResponse memory)
    {
        return
            TreasuryGuard.SignedResponse(requestHash, timestamp, data, signResponse(key, requestHash, timestamp, data));
    }

    function testPrice(string memory change1h, string memory updatedAt, uint256 signedAt)
        internal
        pure
        returns (TreasuryGuard.SignedResponse memory)
    {
        bytes memory data =
            bytes(string.concat('{"change1h":', change1h, ',"price":17.5,"updatedAt":"', updatedAt, '"}'));
        return signed(PRICE_KEY, TEST_PRICE_REQUEST, signedAt, data);
    }

    function testPost(uint256 postTime, string memory text, uint256 signedAt)
        internal
        pure
        returns (TreasuryGuard.SignedResponse memory)
    {
        uint256 id = (postTime * 1000 - TWITTER_EPOCH_MS) << 22;
        bytes memory data = bytes(string.concat('{"id":"', vm.toString(id), '","text":"', text, '"}'));
        return signed(POST_KEY, TEST_POST_REQUEST, signedAt, data);
    }

    function submitPrice(uint256 vaultId, TreasuryGuard.SignedResponse memory response, uint256 usdAmount)
        internal
        returns (uint256)
    {
        vm.prank(agent);
        return guard.submitPrice(vaultId, response, usdAmount);
    }

    function submitEvent(
        uint256 vaultId,
        TreasuryGuard.SignedResponse memory post,
        TreasuryGuard.SignedResponse memory price,
        TreasuryGuard.Verdict verdict
    ) internal returns (uint256) {
        vm.prank(agent);
        return guard.submitEvent(vaultId, post, price, verdict, hex"1234");
    }

    // ---------- tamper test with real signed responses ----------

    function test_valid_freshPriceCreatesSpendIntent() public {
        TreasuryGuard.SignedResponse memory price = load("coinpaprika-bsv-usd.json");
        vm.expectEmit(address(guard));
        emit TreasuryGuard.PriceVerified(realVault, 1704625150, -15, UPDATED_AT_TS, T0, BSV_USD_REQUEST);
        uint256 intentId = submitPrice(realVault, price, 1e6);

        TreasuryGuard.Intent memory intent = guard.getIntent(intentId);
        assertEq(intentId, 1);
        assertEq(intent.vaultId, realVault);
        assertEq(uint8(intent.kind), uint8(TreasuryGuard.Kind.SPEND));
        assertEq(intent.maxSats, uint256(1e6) * 1e10 / 1704625150); // $1 at $17.0462515 ≈ 5.87M sats
        assertEq(intent.maxSats, 5866392);
        assertEq(intent.expiry, block.timestamp + 900);
        assertEq(intent.price, 1704625150);
        assertEq(intent.priceSignedAt, T0);
        assertEq(guard.remainingUsdToday(realVault), BUDGET - 1e6);
        assertEq(uint8(guard.regime(realVault)), uint8(TreasuryGuard.Regime.NORMAL));
        assertEq(guard.lastPrice(realVault).price, 1704625150);
    }

    function test_tamper_editedValue() public {
        TreasuryGuard.SignedResponse memory price = load("coinpaprika-bsv-usd.json");
        price.data = bytes(LibString.replace(string(price.data), '"price":17.04', '"price":18.04'));
        vm.expectPartialRevert(TreasuryGuard.SignerMismatch.selector);
        submitPrice(realVault, price, 1e6);
    }

    function test_tamper_tooOld() public {
        vm.warp(T0 + 301);
        vm.expectRevert(TreasuryGuard.StaleSignature.selector);
        submitPrice(realVault, load("coinpaprika-bsv-usd.json"), 1e6);
    }

    function test_tamper_wrongRequest_btcInsteadOfBsv() public {
        // Long after signing too: the request check comes first, so the judge sees WrongRequest on a cached fixture.
        vm.warp(T0 + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGuard.WrongRequest.selector, BTC_USD_REQUEST));
        submitPrice(realVault, load("coinpaprika-btc-usd.json"), 1e6);
    }

    function test_tamper_wrongKey() public {
        TreasuryGuard.SignedResponse memory price = load("coinpaprika-bsv-usd.json");
        price.signature = signResponse(ATTACKER_KEY, BSV_USD_REQUEST, price.timestamp, price.data);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGuard.SignerMismatch.selector, vm.addr(ATTACKER_KEY)));
        submitPrice(realVault, price, 1e6);
    }

    function test_tamper_malformedSignature() public {
        TreasuryGuard.SignedResponse memory price = load("coinpaprika-bsv-usd.json");
        price.signature = hex"1234";
        vm.expectRevert(abi.encodeWithSelector(TreasuryGuard.SignerMismatch.selector, address(0)));
        submitPrice(realVault, price, 1e6);
    }

    function test_tamper_replay() public {
        TreasuryGuard.SignedResponse memory price = load("coinpaprika-bsv-usd.json");
        submitPrice(realVault, price, 1e6);
        vm.expectRevert(TreasuryGuard.Replay.selector);
        submitPrice(realVault, price, 1e6);
    }

    function test_tamper_budgetExceeded() public {
        vm.expectRevert(abi.encodeWithSelector(TreasuryGuard.BudgetExceeded.selector, BUDGET));
        submitPrice(realVault, load("coinpaprika-bsv-usd.json"), BUDGET + 1);
    }

    function test_tamper_stalePost_oldPostFreshSignature() public {
        // @federalreserve's newest post was 16.6 h old when the Airnode signed it a moment ago.
        TreasuryGuard.SignedResponse memory post = load("twitterapi-federalreserve.json");
        vm.warp(post.timestamp + 10);
        vm.expectRevert(TreasuryGuard.StalePost.selector);
        submitEvent(realVault, post, load("coinpaprika-bsv-usd.json"), TreasuryGuard.Verdict.RISK_OFF);
    }

    function test_realRetweetIsNotOriginalPost() public {
        TreasuryGuard.SignedResponse memory post = load("twitterapi-whitehouse.json"); // "RT @CENTCOM: ..."
        vm.warp(post.timestamp + 2);
        vm.expectRevert(TreasuryGuard.NotOriginalPost.selector);
        submitEvent(realVault, post, load("coinpaprika-bsv-usd.json"), TreasuryGuard.Verdict.RISK_OFF);
    }

    function test_priceResponseAsPostIsWrongRequest() public {
        TreasuryGuard.SignedResponse memory price = load("coinpaprika-bsv-usd.json");
        vm.expectRevert(abi.encodeWithSelector(TreasuryGuard.WrongRequest.selector, BSV_USD_REQUEST));
        submitEvent(realVault, price, price, TreasuryGuard.Verdict.RISK_OFF);
    }

    function test_onlyAgentSubmits() public {
        TreasuryGuard.SignedResponse memory price = load("coinpaprika-bsv-usd.json");
        vm.expectRevert(TreasuryGuard.NotAgent.selector);
        guard.submitPrice(realVault, price, 1e6);
        vm.expectRevert(TreasuryGuard.NotAgent.selector);
        guard.submitEvent(realVault, price, price, TreasuryGuard.Verdict.RISK_OFF, "");
    }

    function test_checkPrice_anyoneGetsTheSameErrors() public {
        TreasuryGuard.SignedResponse memory price = load("coinpaprika-bsv-usd.json");
        assertEq(guard.checkPrice(realVault, price).change1h, -15);

        TreasuryGuard.SignedResponse memory edited = load("coinpaprika-bsv-usd.json");
        edited.data = bytes(LibString.replace(string(edited.data), '"change1h":-0.15', '"change1h":-9.15'));
        vm.expectPartialRevert(TreasuryGuard.SignerMismatch.selector);
        guard.checkPrice(realVault, edited);

        vm.expectRevert(abi.encodeWithSelector(TreasuryGuard.WrongRequest.selector, BTC_USD_REQUEST));
        guard.checkPrice(realVault, load("coinpaprika-btc-usd.json"));

        submitPrice(realVault, price, 0);
        vm.expectRevert(TreasuryGuard.Replay.selector);
        guard.checkPrice(realVault, price);
    }

    // ---------- price freshness and replay ----------

    function test_olderPriceAfterNewerIsReplay() public {
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, T0 + 5), 0);
        vm.expectRevert(TreasuryGuard.Replay.selector);
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, T0 + 4), 0);
    }

    function test_oldMeasurementWithFreshSignatureIsStale() public {
        vm.warp(T0 + 700);
        // Signed now, but observed 704 s before signing (max 600).
        vm.expectRevert(TreasuryGuard.StaleSignature.selector);
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, T0 + 700), 0);
    }

    function test_signatureFromTheFutureIsStale() public {
        vm.expectRevert(TreasuryGuard.StaleSignature.selector);
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, block.timestamp + 61), 0);
        // Within the clock skew it is accepted.
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, block.timestamp + 60), 0);
    }

    function test_exponentNotationReverts() public {
        vm.expectRevert();
        submitPrice(testVault, testPrice("-1e-7", UPDATED_AT, T0 + 5), 0);
    }

    // ---------- budget rule ----------

    function test_budget_newPriceNeverResetsIt() public {
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, T0 + 1), 3e6);
        vm.expectRevert(abi.encodeWithSelector(TreasuryGuard.BudgetExceeded.selector, 2e6));
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, T0 + 2), 3e6);
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, T0 + 3), 2e6);
        assertEq(guard.remainingUsdToday(testVault), 0);
    }

    function test_budget_noRefundOnExpiry() public {
        uint256 intentId = submitPrice(testVault, testPrice("0.1", UPDATED_AT, T0 + 1), 4e6);
        vm.warp(guard.getIntent(intentId).expiry + 1);
        assertEq(guard.remainingUsdToday(testVault), 1e6);
    }

    function test_budget_dailyReset() public {
        submitPrice(testVault, testPrice("0.1", UPDATED_AT, T0 + 1), BUDGET);
        assertEq(guard.remainingUsdToday(testVault), 0);

        uint256 nextDay = T0 + 1 days;
        vm.warp(nextDay);
        assertEq(guard.remainingUsdToday(testVault), BUDGET);
        submitPrice(testVault, testPrice("0.1", "2026-10-31T13:03:16Z", nextDay), BUDGET);
        assertEq(guard.remainingUsdToday(testVault), 0);
    }

    // ---------- circuit breaker ----------

    function test_breaker_crashHedgesAndSpendStillWorks() public {
        uint256 spendId = submitPrice(testVault, testPrice("-6.25", UPDATED_AT, T0 + 1), 1e6);
        assertEq(uint8(guard.regime(testVault)), uint8(TreasuryGuard.Regime.RISK_OFF));

        TreasuryGuard.Intent memory hedge = guard.getIntent(spendId + 1);
        assertEq(uint8(hedge.kind), uint8(TreasuryGuard.Kind.SWAP));
        assertEq(uint8(hedge.direction), uint8(TreasuryGuard.Direction.SATS_TO_DUSD));
        assertEq(uint8(hedge.source), uint8(TreasuryGuard.Source.BREAKER));
        assertEq(hedge.maxBps, 5000);
        assertEq(hedge.minOut, 1732500000); // $17.50 − 1 %
        assertEq(hedge.maxOut, 1767500000); // $17.50 + 1 %
        assertEq(guard.getIntent(spendId).maxSats, uint256(1e6) * 1e10 / 1750000000);
    }

    function test_breaker_noTriggerAboveThreshold() public {
        submitPrice(testVault, testPrice("-4.99", UPDATED_AT, T0 + 1), 0);
        assertEq(uint8(guard.regime(testVault)), uint8(TreasuryGuard.Regime.NORMAL));
        assertEq(guard.intentCount(), 0);
    }

    function test_breaker_reentryOnlyAfterCooldown() public {
        submitPrice(testVault, testPrice("-6", UPDATED_AT, T0 + 1), 0);
        // Recovered, but in cooldown: skipped silently, the SPEND still goes through.
        uint256 spendId = submitPrice(testVault, testPrice("1.5", UPDATED_AT, T0 + 2), 1e6);
        assertEq(uint8(guard.regime(testVault)), uint8(TreasuryGuard.Regime.RISK_OFF));
        assertEq(uint8(guard.getIntent(spendId).kind), uint8(TreasuryGuard.Kind.SPEND));
        assertEq(guard.intentCount(), 2);

        uint256 later = T0 + 10 + 3600;
        vm.warp(later);
        submitPrice(testVault, testPrice("0.99", "2026-10-30T14:03:20Z", later), 0); // below re-entry
        assertEq(uint8(guard.regime(testVault)), uint8(TreasuryGuard.Regime.RISK_OFF));
        submitPrice(testVault, testPrice("1", "2026-10-30T14:03:20Z", later + 1), 0);
        assertEq(uint8(guard.regime(testVault)), uint8(TreasuryGuard.Regime.NORMAL));
        TreasuryGuard.Intent memory reentry = guard.getIntent(3);
        assertEq(uint8(reentry.direction), uint8(TreasuryGuard.Direction.DUSD_TO_SATS));
        assertEq(uint8(reentry.source), uint8(TreasuryGuard.Source.REENTRY));
    }

    // ---------- news guard ----------

    function test_event_hedgesCappedAndReplayBlocked() public {
        TreasuryGuard.SignedResponse memory post = testPost(T0 - 120, "Statement on tariffs", T0 + 5);
        TreasuryGuard.SignedResponse memory price = testPrice("0.1", UPDATED_AT, T0 + 5);
        uint256 hedgeId = submitEvent(testVault, post, price, TreasuryGuard.Verdict.RISK_OFF);

        assertEq(uint8(guard.regime(testVault)), uint8(TreasuryGuard.Regime.GUARDED));
        TreasuryGuard.Intent memory hedge = guard.getIntent(hedgeId);
        assertEq(uint8(hedge.source), uint8(TreasuryGuard.Source.EVENT));
        assertEq(hedge.maxBps, 2500);

        vm.expectRevert(TreasuryGuard.Replay.selector);
        submitEvent(testVault, post, price, TreasuryGuard.Verdict.RISK_OFF);

        // A second post while GUARDED is recorded but adds no hedge.
        TreasuryGuard.SignedResponse memory second = testPost(T0 - 60, "Another statement", T0 + 6);
        assertEq(submitEvent(testVault, second, price, TreasuryGuard.Verdict.RISK_OFF), 0);
        assertTrue(guard.isPostUsed(testVault, (((T0 - 60) * 1000 - TWITTER_EPOCH_MS) << 22)));
    }

    function test_event_ignoreVerdictOnlyRecords() public {
        TreasuryGuard.SignedResponse memory post = testPost(T0 - 120, "Halloween", T0 + 5);
        assertEq(submitEvent(testVault, post, testPrice("0.1", UPDATED_AT, T0 + 5), TreasuryGuard.Verdict.IGNORE), 0);
        assertEq(uint8(guard.regime(testVault)), uint8(TreasuryGuard.Regime.NORMAL));
    }

    function test_event_stalePost() public {
        TreasuryGuard.SignedResponse memory post = testPost(T0 + 10 - 1801, "Old news", T0 + 5);
        vm.expectRevert(TreasuryGuard.StalePost.selector);
        submitEvent(testVault, post, testPrice("0.1", UPDATED_AT, T0 + 5), TreasuryGuard.Verdict.RISK_OFF);
    }

    function test_event_stalePriceRejected() public {
        vm.warp(T0 + 400);
        TreasuryGuard.SignedResponse memory post = testPost(T0 + 300, "Statement", T0 + 399);
        vm.expectRevert(TreasuryGuard.StaleSignature.selector);
        submitEvent(testVault, post, testPrice("0.1", UPDATED_AT, T0 + 5), TreasuryGuard.Verdict.RISK_OFF);
    }

    function test_event_cooldownAfterRegimeChange() public {
        submitPrice(testVault, testPrice("-6", UPDATED_AT, T0 + 1), 0);
        uint256 later = T0 + 10 + 3600;
        vm.warp(later);
        submitPrice(testVault, testPrice("2", "2026-10-30T14:03:20Z", later), 0); // back to NORMAL now
        TreasuryGuard.SignedResponse memory post = testPost(later - 60, "Statement", later);
        vm.expectRevert(TreasuryGuard.Cooldown.selector);
        submitEvent(testVault, post, testPrice("2", "2026-10-30T14:03:20Z", later), TreasuryGuard.Verdict.RISK_OFF);
    }

    function test_crashDuringGuardedGoesRiskOff() public {
        TreasuryGuard.SignedResponse memory post = testPost(T0 - 120, "Statement", T0 + 5);
        submitEvent(testVault, post, testPrice("0.1", UPDATED_AT, T0 + 5), TreasuryGuard.Verdict.RISK_OFF);
        uint256 later = T0 + 10 + 3600;
        vm.warp(later);
        submitPrice(testVault, testPrice("-7", "2026-10-30T14:03:20Z", later), 0);
        assertEq(uint8(guard.regime(testVault)), uint8(TreasuryGuard.Regime.RISK_OFF));
    }

    // ---------- settle and config ----------

    function test_settle_onceByAgent() public {
        uint256 intentId = submitPrice(realVault, load("coinpaprika-bsv-usd.json"), 1e6);
        vm.expectRevert(TreasuryGuard.NotAgent.selector);
        guard.settle(intentId, bytes32(uint256(1)));

        vm.prank(agent);
        guard.settle(intentId, bytes32(uint256(1)));
        assertTrue(guard.getIntent(intentId).settled);
        assertEq(guard.getIntent(intentId).bsvTxid, bytes32(uint256(1)));

        vm.prank(agent);
        vm.expectRevert(TreasuryGuard.AlreadySettled.selector);
        guard.settle(intentId, bytes32(uint256(2)));

        vm.prank(agent);
        vm.expectRevert(TreasuryGuard.NotAgent.selector);
        guard.settle(999, bytes32(uint256(1)));
    }

    function test_createVault_rejectsEventHedgeAbove25Percent() public {
        TreasuryGuard.VaultConfig memory bad = config(COINPAPRIKA, BSV_USD_REQUEST, TWITTERAPI);
        bad.eventHedgeBps = 2501;
        vm.expectRevert(TreasuryGuard.InvalidConfig.selector);
        guard.createVault(bad, new bytes32[](0));
    }

    function test_createVault_ownerIsCaller() public view {
        assertEq(guard.getVaultConfig(realVault).owner, owner);
        assertEq(guard.getVaultConfig(realVault).agent, agent);
    }
}
