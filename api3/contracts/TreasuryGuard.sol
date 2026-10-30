// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {JSONParserLib} from "solady/utils/JSONParserLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {ProjectedJson} from "./ProjectedJson.sol";

/// @title Turns signed AirnodeHub data into spend and swap intents for an agent treasury
/// @notice The agent of a vault submits a signed BSV/USD price (CoinPaprika) to get a SPEND intent from its daily USD
/// budget, and the same price drives a circuit breaker. A signed post of a whitelisted account (TwitterAPI.io) plus an
/// analyst verdict can open a capped hedge. Intents are only authorizations: a watcher on the settlement chain co-signs
/// a transaction only if it matches one. Every accepted value is stored and emitted, so anyone can audit a move against
/// signed evidence. The checks are the same for every response: request, signer, signature age, replay.
/// @dev Units: USD amounts have 6 decimals, prices 8 decimals (USD per BSV), changes and bps are hundredths of a
/// percent, sats are 1e-8 BSV.
contract TreasuryGuard {
    enum Regime {
        NORMAL,
        RISK_OFF,
        GUARDED
    }

    enum Kind {
        SPEND,
        SWAP
    }

    enum Direction {
        NONE,
        SATS_TO_DUSD,
        DUSD_TO_SATS
    }

    enum Source {
        BUDGET,
        BREAKER,
        REENTRY,
        EVENT
    }

    enum Verdict {
        IGNORE,
        RISK_OFF,
        RISK_ON
    }

    /// @notice A signed response as the Airnode returns it, with `data` as the exact bytes it signed
    struct SignedResponse {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    /// @notice Set once at vault creation, never changed
    struct VaultConfig {
        address owner;
        address agent;
        address priceAirnode;
        bytes32 priceRequestHash;
        address postAirnode;
        uint256 dailyBudgetUsd;
        uint32 maxSignatureAge;
        uint32 maxDataAge;
        uint32 maxPostAge;
        uint32 cooldown;
        uint32 intentTtl;
        int32 breakerBps;
        int32 reentryBps;
        uint16 breakerHedgeBps;
        uint16 eventHedgeBps;
        uint16 slippageBps;
    }

    struct VaultState {
        uint256 remainingUsdToday;
        uint64 day;
        uint64 lastPriceTimestamp;
        uint64 lastRegimeChange;
        Regime regime;
    }

    struct Price {
        uint256 price;
        int256 change1h;
        uint256 updatedAt;
        uint256 signedAt;
    }

    struct Intent {
        uint256 vaultId;
        Kind kind;
        Direction direction;
        Source source;
        uint256 maxSats;
        uint16 maxBps;
        uint256 minOut;
        uint256 maxOut;
        uint64 expiry;
        uint256 price;
        uint64 priceSignedAt;
        bool settled;
        bytes32 bsvTxid;
    }

    /// @notice An Airnode clock slightly ahead of the chain's is tolerated by this much
    uint256 public constant MAX_CLOCK_SKEW = 60;
    /// @notice A post can never hedge more than this share of the vault, whatever the analyst says
    uint16 public constant MAX_EVENT_HEDGE_BPS = 2500;
    uint256 private constant TWITTER_EPOCH_MS = 1288834974657;

    uint256 public vaultCount;
    uint256 public intentCount;
    mapping(uint256 vaultId => VaultConfig) private configs;
    mapping(uint256 vaultId => VaultState) private states;
    mapping(uint256 vaultId => Price) private prices;
    mapping(uint256 vaultId => mapping(bytes32 requestHash => bool)) public isPostRequest;
    mapping(uint256 vaultId => mapping(uint256 postId => bool)) public isPostUsed;
    mapping(uint256 intentId => Intent) private intents;

    event VaultCreated(uint256 indexed vaultId, address indexed owner, address indexed agent);
    event PriceVerified(
        uint256 indexed vaultId,
        uint256 price,
        int256 change1h,
        uint256 updatedAt,
        uint256 signedAt,
        bytes32 requestHash
    );
    event PostVerified(
        uint256 indexed vaultId,
        uint256 indexed postId,
        uint256 postTime,
        uint256 signedAt,
        bytes32 requestHash,
        Verdict verdict,
        bytes32 analystSigHash
    );
    event IntentCreated(
        uint256 indexed intentId,
        uint256 indexed vaultId,
        Kind kind,
        Direction direction,
        uint256 maxSats,
        uint16 maxBps,
        uint256 minOut,
        uint256 maxOut,
        uint64 expiry,
        uint256 price,
        uint64 priceSignedAt,
        Source source
    );
    event RegimeChanged(uint256 indexed vaultId, Regime regime);
    event Settled(uint256 indexed intentId, bytes32 bsvTxid);

    error SignerMismatch(address signer);
    error WrongRequest(bytes32 requestHash);
    error StaleSignature();
    error StalePost();
    error Replay();
    error BudgetExceeded(uint256 remainingUsdToday);
    error Cooldown();
    error NotAgent();
    error NotOriginalPost();
    error InvalidAmount();
    error InvalidConfig();
    error AlreadySettled();

    /// @notice Creates a vault whose owner is the caller. The config cannot change afterwards.
    /// @param postRequestHashes One request hash per whitelisted account, signed by `config.postAirnode`
    function createVault(VaultConfig calldata config, bytes32[] calldata postRequestHashes)
        external
        returns (uint256 vaultId)
    {
        if (
            config.agent == address(0) || config.priceAirnode == address(0) || config.priceRequestHash == bytes32(0)
                || config.maxSignatureAge == 0 || config.maxDataAge == 0 || config.maxPostAge == 0
                || config.intentTtl == 0 || config.breakerHedgeBps > 10000 || config.eventHedgeBps > MAX_EVENT_HEDGE_BPS
                || config.slippageBps > 10000 || config.breakerBps >= config.reentryBps
        ) revert InvalidConfig();

        vaultId = ++vaultCount;
        VaultConfig storage stored = configs[vaultId];
        stored.owner = msg.sender;
        stored.agent = config.agent;
        stored.priceAirnode = config.priceAirnode;
        stored.priceRequestHash = config.priceRequestHash;
        stored.postAirnode = config.postAirnode;
        stored.dailyBudgetUsd = config.dailyBudgetUsd;
        stored.maxSignatureAge = config.maxSignatureAge;
        stored.maxDataAge = config.maxDataAge;
        stored.maxPostAge = config.maxPostAge;
        stored.cooldown = config.cooldown;
        stored.intentTtl = config.intentTtl;
        stored.breakerBps = config.breakerBps;
        stored.reentryBps = config.reentryBps;
        stored.breakerHedgeBps = config.breakerHedgeBps;
        stored.eventHedgeBps = config.eventHedgeBps;
        stored.slippageBps = config.slippageBps;
        for (uint256 i = 0; i < postRequestHashes.length; i++) {
            isPostRequest[vaultId][postRequestHashes[i]] = true;
        }
        states[vaultId].remainingUsdToday = config.dailyBudgetUsd;
        states[vaultId].day = uint64(block.timestamp / 1 days);
        emit VaultCreated(vaultId, msg.sender, config.agent);
    }

    /// @notice Verifies a signed BSV/USD price, creates a SPEND intent for `usdAmount` (0 for none) from today's
    /// budget, and runs the circuit breaker
    /// @dev The budget is debited when the intent is created, never refunded, and only restored by the daily reset.
    /// A new price never resets it.
    function submitPrice(uint256 vaultId, SignedResponse calldata response, uint256 usdAmount)
        external
        returns (uint256 spendIntentId)
    {
        VaultConfig storage config = configs[vaultId];
        if (msg.sender != config.agent) revert NotAgent();
        Price memory price = checkPrice(vaultId, response);

        VaultState storage state = states[vaultId];
        state.lastPriceTimestamp = uint64(price.signedAt);
        prices[vaultId] = price;
        emit PriceVerified(
            vaultId, price.price, price.change1h, price.updatedAt, price.signedAt, config.priceRequestHash
        );

        uint64 today = uint64(block.timestamp / 1 days);
        if (today > state.day) {
            state.day = today;
            state.remainingUsdToday = config.dailyBudgetUsd;
        }

        if (usdAmount > 0) {
            if (usdAmount > state.remainingUsdToday) revert BudgetExceeded(state.remainingUsdToday);
            uint256 maxSats = usdAmount * 1e10 / price.price;
            if (maxSats == 0) revert InvalidAmount();
            state.remainingUsdToday -= usdAmount;
            spendIntentId = createIntent(vaultId, Kind.SPEND, Direction.NONE, Source.BUDGET, maxSats, 0, price);
        }

        // In cooldown the breaker is skipped, never reverted, so a SPEND still goes through during a crash. GUARDED (a
        // post's partial hedge) moves to RISK_OFF on a crash, and leaves through the same re-entry as RISK_OFF, since
        // the brief defines no other way out of it.
        if (block.timestamp < uint256(state.lastRegimeChange) + config.cooldown) return spendIntentId;
        if (state.regime != Regime.RISK_OFF && price.change1h <= config.breakerBps) {
            setRegime(vaultId, Regime.RISK_OFF);
            createIntent(vaultId, Kind.SWAP, Direction.SATS_TO_DUSD, Source.BREAKER, 0, config.breakerHedgeBps, price);
        } else if (state.regime != Regime.NORMAL && price.change1h >= config.reentryBps) {
            setRegime(vaultId, Regime.NORMAL);
            createIntent(vaultId, Kind.SWAP, Direction.DUSD_TO_SATS, Source.REENTRY, 0, 10000, price);
        }
    }

    /// @notice Verifies a signed post of a whitelisted account and a signed price, and on a risk-off verdict hedges at
    /// most `eventHedgeBps` (≤ 25 %) of the vault
    /// @dev Analyst signature recovery is not done yet: only its hash is recorded as evidence.
    function submitEvent(
        uint256 vaultId,
        SignedResponse calldata postResponse,
        SignedResponse calldata priceResponse,
        Verdict verdict,
        bytes calldata analystSig
    ) external returns (uint256 hedgeIntentId) {
        VaultConfig storage config = configs[vaultId];
        if (msg.sender != config.agent) revert NotAgent();
        (uint256 postId, uint256 postTime, Price memory price) = checkEvent(vaultId, postResponse, priceResponse);

        isPostUsed[vaultId][postId] = true;
        emit PostVerified(
            vaultId, postId, postTime, postResponse.timestamp, postResponse.requestHash, verdict, keccak256(analystSig)
        );

        // Only a NORMAL vault hedges on a post: GUARDED already holds the hedge and RISK_OFF holds more.
        VaultState storage state = states[vaultId];
        if (verdict != Verdict.RISK_OFF || state.regime != Regime.NORMAL) return 0;
        if (block.timestamp < uint256(state.lastRegimeChange) + config.cooldown) revert Cooldown();
        setRegime(vaultId, Regime.GUARDED);
        hedgeIntentId =
            createIntent(vaultId, Kind.SWAP, Direction.SATS_TO_DUSD, Source.EVENT, 0, config.eventHedgeBps, price);
    }

    /// @notice Records the BSV transaction that carried out an intent. Once per intent, also after expiry, since
    /// expiry only binds the watcher.
    function settle(uint256 intentId, bytes32 bsvTxid) external {
        Intent storage intent = intents[intentId];
        if (intent.vaultId == 0 || msg.sender != configs[intent.vaultId].agent) revert NotAgent();
        if (intent.settled) revert AlreadySettled();
        intent.settled = true;
        intent.bsvTxid = bsvTxid;
        emit Settled(intentId, bsvTxid);
    }

    /// @notice Runs every check of submitPrice on a price without acting on it, with the same errors, so anyone (such
    /// as a judge) can test a response with eth_call
    function checkPrice(uint256 vaultId, SignedResponse calldata response) public view returns (Price memory price) {
        price = verifyPrice(configs[vaultId], response);
        if (response.timestamp <= states[vaultId].lastPriceTimestamp) revert Replay();
    }

    /// @notice Runs the checks of submitEvent on both responses without acting on them, with the same errors. The
    /// verdict-dependent Cooldown check is not part of it.
    /// @dev The price only has to be fresh: replay protection for an event is the post id.
    function checkEvent(uint256 vaultId, SignedResponse calldata postResponse, SignedResponse calldata priceResponse)
        public
        view
        returns (uint256 postId, uint256 postTime, Price memory price)
    {
        VaultConfig storage config = configs[vaultId];
        // The request hash only selects among stored ones, so a response can never bring its own.
        if (!isPostRequest[vaultId][postResponse.requestHash]) revert WrongRequest(postResponse.requestHash);
        verifySignature(config.postAirnode, config.maxSignatureAge, postResponse.requestHash, postResponse);

        // The id has to be a JSON string of digits: a bare number may have been rounded by the API's JSON encoder.
        postId = JSONParserLib.parseUint(ProjectedJson.readString(postResponse.data, "id"));
        if (isPostUsed[vaultId][postId]) revert Replay();
        // A post id is a Snowflake, so it carries the time it was posted.
        postTime = ((postId >> 22) + TWITTER_EPOCH_MS) / 1000;
        if (postTime > block.timestamp + MAX_CLOCK_SKEW || postTime + config.maxPostAge < block.timestamp) {
            revert StalePost();
        }
        if (LibString.startsWith(ProjectedJson.readString(postResponse.data, "text"), "RT @")) {
            revert NotOriginalPost();
        }

        price = verifyPrice(config, priceResponse);
    }

    function getIntent(uint256 intentId) external view returns (Intent memory) {
        return intents[intentId];
    }

    function getVaultConfig(uint256 vaultId) external view returns (VaultConfig memory) {
        return configs[vaultId];
    }

    /// @notice The budget left today, counting a daily reset that the next submitPrice would make
    function remainingUsdToday(uint256 vaultId) external view returns (uint256) {
        if (block.timestamp / 1 days > states[vaultId].day) return configs[vaultId].dailyBudgetUsd;
        return states[vaultId].remainingUsdToday;
    }

    function regime(uint256 vaultId) external view returns (Regime) {
        return states[vaultId].regime;
    }

    function lastPrice(uint256 vaultId) external view returns (Price memory) {
        return prices[vaultId];
    }

    function verifyPrice(VaultConfig storage config, SignedResponse calldata response)
        private
        view
        returns (Price memory price)
    {
        if (response.requestHash != config.priceRequestHash) revert WrongRequest(response.requestHash);
        verifySignature(config.priceAirnode, config.maxSignatureAge, config.priceRequestHash, response);

        price.signedAt = response.timestamp;
        price.price = ProjectedJson.readUint(response.data, "price", 8);
        if (price.price == 0) revert InvalidAmount();
        price.change1h = ProjectedJson.readInt(response.data, "change1h", 2);
        // A fresh signature can carry an old value, so the time the value was observed is checked too.
        price.updatedAt = ProjectedJson.readTimestamp(response.data, "updatedAt");
        if (
            price.updatedAt > response.timestamp + MAX_CLOCK_SKEW
                || price.updatedAt + config.maxDataAge < response.timestamp
        ) revert StaleSignature();
    }

    /// @dev Recovers against the stored request hash and signer, never the ones in the response. Any failure to
    /// recover, such as a malformed signature, reads as a signer mismatch.
    function verifySignature(address airnode, uint256 maxAge, bytes32 requestHash, SignedResponse calldata response)
        private
        view
    {
        bytes32 digest = keccak256(abi.encodePacked(requestHash, response.timestamp, response.data));
        (address signer, ECDSA.RecoverError recoverError,) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(digest), response.signature);
        if (recoverError != ECDSA.RecoverError.NoError || signer != airnode) revert SignerMismatch(signer);
        if (response.timestamp > block.timestamp + MAX_CLOCK_SKEW || response.timestamp + maxAge < block.timestamp) {
            revert StaleSignature();
        }
    }

    function setRegime(uint256 vaultId, Regime newRegime) private {
        states[vaultId].regime = newRegime;
        states[vaultId].lastRegimeChange = uint64(block.timestamp);
        emit RegimeChanged(vaultId, newRegime);
    }

    /// @dev A SWAP's band is the signed price ± slippage, in USD per BSV with 8 decimals. Its size is maxBps of the
    /// vault (or, for DUSD_TO_SATS, of the vault's dUSD).
    function createIntent(
        uint256 vaultId,
        Kind kind,
        Direction direction,
        Source source,
        uint256 maxSats,
        uint16 maxBps,
        Price memory price
    ) private returns (uint256 intentId) {
        VaultConfig storage config = configs[vaultId];
        intentId = ++intentCount;
        Intent storage intent = intents[intentId];
        intent.vaultId = vaultId;
        intent.kind = kind;
        intent.direction = direction;
        intent.source = source;
        intent.maxSats = maxSats;
        intent.maxBps = maxBps;
        if (kind == Kind.SWAP) {
            intent.minOut = price.price * (10000 - config.slippageBps) / 10000;
            intent.maxOut = price.price * (10000 + config.slippageBps) / 10000;
        }
        intent.expiry = uint64(block.timestamp + config.intentTtl);
        intent.price = price.price;
        intent.priceSignedAt = uint64(price.signedAt);
        emitIntentCreated(intentId);
    }

    function emitIntentCreated(uint256 intentId) private {
        Intent storage intent = intents[intentId];
        emit IntentCreated(
            intentId,
            intent.vaultId,
            intent.kind,
            intent.direction,
            intent.maxSats,
            intent.maxBps,
            intent.minOut,
            intent.maxOut,
            intent.expiry,
            intent.price,
            intent.priceSignedAt,
            intent.source
        );
    }
}
