// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TreasuryGuard} from "../contracts/TreasuryGuard.sol";

/// @notice Deploys TreasuryGuard and creates the demo vault (agent = the BSV agent loop's key), optionally a judge
/// vault with the same config whose agent is the deployer, so the live judge never shares a nonce, budget or
/// lastPriceTimestamp with the agent loop.
/// forge script script/DeployTreasuryGuard.s.sol --rpc-url $RPC_URL --broadcast
/// Env: PRIVATE_KEY (deployer), optional AGENT (default: agent address from API3-NOTES), JUDGE_VAULT=true,
/// DEMO_POST_REQUEST_HASH (team demo X account, same projection as the other posts).
contract DeployTreasuryGuard is Script {
    address constant DEFAULT_AGENT = 0x0310dCF1E329FE74fe881ae273E1E1d2784b4cf0;
    // @federalreserve, projection {id, text}: the real StalePost fixture needs it whitelisted, or it hits WrongRequest.
    bytes32 constant FEDERALRESERVE_REQUEST = 0xceecf6d2b5c25f57242052a0a59ca73222bf017e41a7ec13418fe1207b7b9ec6;

    function run() external returns (TreasuryGuard guard, uint256 vaultId, uint256 judgeVaultId) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address agent = vm.envOr("AGENT", DEFAULT_AGENT);

        string memory json = vm.readFile("deployments.json");
        string memory feeds = ".baseSepolia.feeds";
        TreasuryGuard.VaultConfig memory config = TreasuryGuard.VaultConfig({
            owner: address(0), // the contract sets the caller
            agent: agent,
            priceAirnode: vm.parseJsonAddress(json, string.concat(feeds, ".bsvUsd.airnode")),
            priceRequestHash: vm.parseJsonBytes32(json, string.concat(feeds, ".bsvUsd.requestHash")),
            postAirnode: vm.parseJsonAddress(json, string.concat(feeds, ".tweets.WhiteHouse.airnode")),
            dailyBudgetUsd: 1e6, // $1 a day, approved 30.10.
            maxSignatureAge: 300, // one x402 fetch + a few eth_calls + one confirmed tx
            maxDataAge: 600, // CoinPaprika refreshes every minute
            maxPostAge: 1800,
            cooldown: 3600,
            intentTtl: 900,
            breakerBps: -500, // -5 % in 1 h
            reentryBps: 100, // +1 % in 1 h
            breakerHedgeBps: 5000,
            eventHedgeBps: 2500,
            slippageBps: 100
        });

        bytes32 demoPost = vm.envOr("DEMO_POST_REQUEST_HASH", bytes32(0));
        bytes32[] memory posts = new bytes32[](demoPost == bytes32(0) ? 2 : 3);
        posts[0] = vm.parseJsonBytes32(json, string.concat(feeds, ".tweets.WhiteHouse.requestHash"));
        posts[1] = FEDERALRESERVE_REQUEST;
        if (demoPost != bytes32(0)) posts[2] = demoPost;

        vm.startBroadcast(deployerKey);
        guard = new TreasuryGuard();
        vaultId = guard.createVault(config, posts);
        if (vm.envOr("JUDGE_VAULT", false)) {
            config.agent = deployer;
            judgeVaultId = guard.createVault(config, posts);
        }
        vm.stopBroadcast();

        console.log("chainId", block.chainid);
        console.log("treasuryGuard", address(guard));
        console.log("vaultId", vaultId, "agent", agent);
        if (judgeVaultId != 0) console.log("judgeVaultId", judgeVaultId, "agent", deployer);
        console.log("deploy tx hash + block: broadcast/DeployTreasuryGuard.s.sol/<chainId>/run-latest.json");
    }
}
