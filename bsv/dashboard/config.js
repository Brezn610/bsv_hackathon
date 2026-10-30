// Public connection configuration only. No sample transactions or test results.
// earlierFloatScript: the agent wallet that received withdrawals before `tg rebind-float` (intent 2, RESULTS.md).
'use strict';
window.TG_CONFIG = Object.freeze({
  "base": {
    "chainId": 84532,
    "network": "Base Sepolia",
    "rpcDefault": "https://sepolia.base.org",
    "explorer": "https://sepolia.basescan.org",
    "contract": "0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773",
    "vaultId": 5,
    "runnerVaultId": 8,
    "judgeVaultId": 6,
    "liveJudgeVaultId": 7,
    "retiredVaults": [
      1,
      2,
      3,
      4
    ],
    "feeds": {
      "bsvUsd": {
        "name": "CoinPaprika BSV/USD",
        "airnode": "0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732",
        "requestHash": "0x18b782163c79529c7bbe757343b930284f3aef690e45560f0aa771b629399480"
      }
    }
  },
  "bsv": {
    "network": "BSV mainnet",
    "explorer": "https://whatsonchain.com",
    "api": "https://api.whatsonchain.com/v1/bsv/main",
    "binding": "tg-vault-vault-5-v1-2026-10-30+float-wallet",
    "vaultScriptSha256": "0f5b17cb97ddaf4e6d6ea2ab2a90f2ef67cdbf0be72aa2fb4ee5cfbd122c0244",
    "floatAddress": "11GrdqLCiF1WtzhXqPo5bBb2jCfCTMz8z",
    "floatScript": "76a914000d3c59311f64d8806fb5bf5a1daaf0dd15b27988ac",
    "earlierFloatScript": "76a91419e272af3877858a136f6b5a9c67a390bb13b7e088ac"
  }
});
