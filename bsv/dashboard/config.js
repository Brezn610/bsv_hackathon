// Public connection configuration only. No sample transactions or test results.
// demoHedgeVaults: copies of vault 5 the API3 side hedges on, so the SPEND stays on vault 5. No BSV behind them.
// earlierFloatScript: the agent wallet that received withdrawals before `tg rebind-float` (intent 2, RESULTS.md).
// otherRequests.btcUsd: CoinPaprika BTC/USD, same Airnode as BSV/USD. The forgery check swaps it in to show that a
// vault accepts only the one request it stores (WrongRequest). posts: the whitelisted accounts' request hashes
// (api3/deployments.json); the page asks the contract (isPostRequest) whether each is really whitelisted.
// paymentOutcomes: what the merchant answered to each HTTP 402 payment, from the agent's log
// (bsv/data/evidence/http402-*.json). The chain shows the payment; only the log shows whether data came back.
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
    "demoHedgeVaults": [
      9,
      10,
      11,
      12
    ],
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
    },
    "otherRequests": {
      "btcUsd": {
        "name": "CoinPaprika BTC/USD",
        "requestHash": "0xcadca27a1c6328b3abbe1a10feeeec01f5e49ef4ad7de3e54797265df80850d8"
      }
    },
    "posts": {
      "airnode": "0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB",
      "accounts": [
        { "handle": "WhiteHouse", "requestHash": "0x783a61a36250c7dfdf26d9ea96ca3cc5894a286c9f4b4139798345cb4d9395e9" },
        { "handle": "federalreserve", "requestHash": "0xceecf6d2b5c25f57242052a0a59ca73222bf017e41a7ec13418fe1207b7b9ec6" },
        { "handle": "956_kakashi", "requestHash": "0x2aa759a5578bd4b6f7e18cb12821e2aa4d5d27ef609c1332e961accc56985a12", "note": "team demo account" }
      ]
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
    "earlierFloatScript": "76a91419e272af3877858a136f6b5a9c67a390bb13b7e088ac",
    "swapAndPay": { "txid": "ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c", "makerVout": 0, "merchantVout": 1 },
    "paymentOutcomes": {
      "54082a714816ce2e9b2a67c23c5e04da67c2f93b8df30136b7126b715802b320": { "http": 200, "merchant": "team demo merchant" },
      "6cf0ff26409e0173d663ad2893a4e3d24306defd9fa81a01882d64de3d2a6134": { "http": 200, "merchant": "team demo merchant" },
      "abe8f2e90f4c4a52920f467abeb5797ec36d52836d6768c3bf1d1f0da12170d5": { "http": 200, "merchant": "Analyst service" },
      "e4ada6c69c7928ef08751adc6ba8fba6faa1fdf7a98aeced78c3f5c25dc328f6": { "http": 524, "merchant": "Analyst service" },
      "ccb8dc1872aab97a6b08dbb6f596a940a17574355aebd34b9f6cd2254f04431e": { "http": 200, "merchant": "team demo merchant" }
    }
  }
});
