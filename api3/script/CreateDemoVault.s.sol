// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TreasuryGuard} from "../contracts/TreasuryGuard.sol";

/// @notice Creates a new agent vault on the deployed TreasuryGuard that also whitelists the team demo X account.
/// Vaults are immutable, so the demo account needs a new vault: it copies the config of the current agent vault
/// (deployments.json → vaultId) 1:1 and whitelists its posts plus the demo account's request hash.
/// DEMO_POST_REQUEST_HASH=0x… forge script script/CreateDemoVault.s.sol --rpc-url $RPC_URL [--broadcast]
/// Env: PRIVATE_KEY (deployer, becomes the vault owner), DEMO_POST_REQUEST_HASH (userLastTweets of the demo
/// account, projection {id: /data/tweets/0/id, text: /data/tweets/0/text}).
contract CreateDemoVault is Script {
    // @federalreserve, same projection: not in deployments.json, but whitelisted in every vault (StalePost fixture).
    bytes32 constant FEDERALRESERVE_REQUEST = 0xceecf6d2b5c25f57242052a0a59ca73222bf017e41a7ec13418fe1207b7b9ec6;

    function run() external returns (uint256 vaultId) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        bytes32 demoPost = vm.envBytes32("DEMO_POST_REQUEST_HASH");
        require(demoPost != bytes32(0), "DEMO_POST_REQUEST_HASH not set");

        string memory json = vm.readFile("deployments.json");
        TreasuryGuard guard = TreasuryGuard(vm.parseJsonAddress(json, ".baseSepolia.treasuryGuard"));
        uint256 sourceVault = vm.parseJsonUint(json, ".baseSepolia.vaultId");
        bytes32 whiteHouse = vm.parseJsonBytes32(json, ".baseSepolia.feeds.tweets.WhiteHouse.requestHash");

        require(guard.isPostRequest(sourceVault, whiteHouse), "source vault lacks WhiteHouse");
        require(guard.isPostRequest(sourceVault, FEDERALRESERVE_REQUEST), "source vault lacks federalreserve");
        require(!guard.isPostRequest(sourceVault, demoPost), "source vault already has the demo account");

        TreasuryGuard.VaultConfig memory config = guard.getVaultConfig(sourceVault);
        bytes32[] memory posts = new bytes32[](3);
        posts[0] = whiteHouse;
        posts[1] = FEDERALRESERVE_REQUEST;
        posts[2] = demoPost;

        vm.startBroadcast(deployerKey);
        vaultId = guard.createVault(config, posts);
        vm.stopBroadcast();

        console.log("treasuryGuard", address(guard));
        console.log("vaultId", vaultId, "copied from vault", sourceVault);
        console.log("agent", config.agent);
        console.log("dailyBudgetUsd", config.dailyBudgetUsd);
        console.logBytes32(demoPost);
    }
}
