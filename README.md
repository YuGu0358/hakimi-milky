# Hakimi Milky

Agents can hire agents — on a leash.

A shop owner hands an agent a data job whose acceptance rules can be written down. The agent hires specialist agents through Masumi escrow on Cardano Preprod, checks every quote against the owner's mandate before paying, and requests a refund when the delivered work fails its acceptance test.

Work in progress during the TUM Blockchain & AI Hackathon, 30–31 October 2026.

## How this repository was built

- The first commit is the unmodified official starter, [tum-hackathon-quickstart](https://github.com/masumi-network/tum-hackathon-quickstart) at `d93783b`, under `frontdesk/`.
- Everything after that commit was written during the event. The git history is the record.
- Before the event we prepared accounts, the local environment and a written design. We wrote no project code.

## Components we reuse

| Component | Version | License | Used for |
| --- | --- | --- | --- |
| tum-hackathon-quickstart | d93783b | No license file; partner starter kit allowed by the event FAQ | Front desk, seller API, hash rules, settlement check |
| Masumi Payment Service | a846392, plus the two small patches below | MIT | Escrow, registration, purchases, refunds |
| @masumi_network/sokosumi | 1.1.0 | MIT | Sokosumi CLI (the starter pins 1.0.4, whose `--personal` path returned 404 on Preprod) |
| zod | 4.6.5 | MIT | Schema validation |
| ai, @ai-sdk/openai-compatible | 7.0.127, 3.0.62 | Apache-2.0 | Model calls |
| @typesafe-ai/sdk | 0.7.0 | MIT | Jev decision model for the reviewer |
| async-mutex | 0.5.0 | MIT | Budget lock |
| csv-parse | 7.0.3 | MIT | Reading the shop owner's table |
| fast-check | 4.10.2 | MIT | Generated guard test cases |
| cross-spawn | 7.0.6 | MIT | Calling the Sokosumi CLI on Windows, where it is a `.cmd` file |

## Setup and run

You need Node 24 or newer. The commands are the same on macOS and Windows.

```
npm ci
npm test
```

Copy `.env.example` to `.env` and fill it in. Tests need none of it. `.env` and `.local/` stay out of git.

### Offline run

Real planner and real Jev reviewer, with a mock payment client instead of the chain. It needs the `ZAI_*` settings and `TYPESAFE_API_KEY`.

```
npm run offline -- c1
```

`c1` hires two agents and merges their work. `c2` has one agent deliver two rows short, which leads to a refund and a second hire. `c3` puts a prompt injection in the supplier table. `c3m` swaps in a malicious planner.

### Specialist agents

Three sellers from one codebase: a standard normalizer (0.3 tUSDM), a cheap normalizer (0.2) and a copywriter (0.2). They need a running Masumi Payment Service, `MPS_URL`, `ADMIN_KEY`, `AGENT_AUTHOR` and ADA in the selling wallet.

```
npm run specialists:register -- key
npm run specialists:register -- register
npm run specialists:register -- status
```

Repeat `status` until all three show `RegistrationConfirmed`. It writes the mandate's allowlist to `.local/specialists/allowlist.json`. Then start them on ports 4101 to 4103:

```
npm run specialists
```

The copywriter also needs the `ZAI_*` settings. For the refund demo, set `FAULT=drop_rows:2` or `FAULT=no_show`. Only the cheap agent takes a fault.

### The front desk

The Coworker in `frontdesk/` takes paid tasks through Sokosumi and needs `npm ci` in that folder too. A task whose text holds a supplier table goes to the specialists through the orchestrator, under a mandate with the owner's budget. Anything else gets a plain answer from the model and hires nobody.

The table is CSV with the columns `sku,name,category,unit,price`, and may add `stock` and `note`. It can have at most 50 rows, and its categories and units have to fit `shared/fixtures/acceptance.json`. A table that could not pass those checks also gets the plain answer, so nobody is paid for a job that cannot succeed.

Each paid task refills the orchestrator's limited key once, so the worker reads `ADMIN_KEY` from `frontdesk/.local/mps.env` for that one call. The reviewer needs `TYPESAFE_API_KEY` in `frontdesk/.env`.

If the worker crashes during a job it picks the job up from the evidence, buys nothing twice and checks every delivered result against the chain again. A job that fails for a passing reason gets up to five tries, a minute apart. If the reviewer asks the owner to decide, if the tries run out or if the deadline passes, the owner is told, no result goes on chain and the seller cannot collect.

### Testing the guard

```
npm run batch
npm run redteam
```

`batch` runs 1000 generated out-of-mandate cases, 100 legal ones, each limit at the edge and one unit over, a replay and a race for one budget. It needs no network; add `-- --with-jev` to include the reviewer. `redteam` has a model write attacks on the guard and runs hand-written injection notes against the real planner. Both write a report to `.local/`.

```
npm run rejections
```

`rejections` tries three calls with the orchestrator's limited key against the real Payment Service: an order above its credit, a seller's payment request and an order on Mainnet. All three have to be refused, which shows the limit holds underneath our own guard. It lowers the key's credit for a moment, so never run it during a paid task.

### Track record and evidence page

```
npm run track-record
npm run evidence
```

`track-record` reads the last 300 transactions of the escrow contract on Preprod and counts, for each agent, the jobs it was paid for and the jobs it refunded. It writes `.local/track-records.json`, and the planner reads that on its next run. Only the chain writes this record, so an agent cannot talk its way into a better one.

`evidence` builds `evidence/index.html` from the runs listed in `evidence/runs.json`.

### Keeping everything online

```
npm run online
npm run online:status
npm run online:stop
```

`online` starts a small supervisor in the background. It watches the Payment Service, the Coworker's agent, worker and seller API, and the three specialists. What is down gets started, what stops answering gets restarted, and a service already running by hand is left alone until it dies. It also checks the Sokosumi login, which only a person can renew, and keeps a Mac from idle sleep. A closed lid still sleeps the machine. Logs go to `.local/online/`.

Run it from a shell where Node 24 is on the PATH. It expects the Coworker in `frontdesk/` and the Payment Service in `../masumi-payment-service`; set `COWORKER_DIR` or `MPS_DIR` to use other folders. To demo a refund, stop it and start it again with `FAULT=drop_rows:2 npm run online`. On Windows it has been tested only with a small test server: set the power plan so the machine does not sleep.

### Payment Service patches

Run the Payment Service with both of these. Neither changes any contract code.

```
git -C masumi-payment-service apply ../hakimi-milky/patches/masumi-payment-service-refund-result-hash.patch
git -C masumi-payment-service apply ../hakimi-milky/patches/masumi-payment-service-keep-running.patch
```

The first one is needed or a refund for a purchase that already has a result is never collected. When a seller authorizes a refund, the contract empties the result hash. The service stores `new hash ?? old hash` on the purchase, so the empty value is overwritten with the old one, and its job that collects refunds only picks purchases with no hash. The patch keeps the empty value.

The second one keeps the service running. got 11, which the Blockfrost client uses, can schedule a retry for a request whose promise has already settled. The timer then throws `The onCancel handler was attached after the promise settled` where no caller can catch it, and that stopped the service twice within a minute on 30 October. The patch logs and ignores that one error. Any other uncaught error still ends the process, and `npm run online` starts it again.

## What has run on Preprod

All of this used test tokens, and every agent we hired is our own. `evidence/index.html` shows the runs step by step, built from the raw records in `evidence/runs/`.

### A paid task in the TUM workspace, with the front desk hiring

This is the paid job for the Cardano track. Task `01a18d23-4f8f-77a8-b71f-35843d6000ae` for Coworker `01a189e8-8258-707e-97c5-c06718385eb7`, in the TUM-Hackathon workspace, with a 20-row table. The owner paid 1 tUSDM into escrow. The front desk hired the cheap normalizer and the copywriter for 0.4 tUSDM, checked both results and delivered 7.2 minutes after it started the task. The text posted on Sokosumi hashes to the result hash on chain.

| Step | Transaction |
| --- | --- |
| Owner's 1 tUSDM locked | [a2bed83f…](https://preprod.cardanoscan.io/transaction/a2bed83f8722f0a1989524fbe9872dcd026e830e3d768a018ff88e8b9b85c0ce) |
| Both hires locked in one transaction | [40a42068…](https://preprod.cardanoscan.io/transaction/40a4206832c1ad868919d8805e3bbb902fc5c3c64ffdfab5c4db3012186f3107) |
| Table result | [e1c38c65…](https://preprod.cardanoscan.io/transaction/e1c38c65a5b42f4d9b160b11803800183d2a7b513bb58b270810f31125a2c2cd) |
| Product texts result | [50b75cff…](https://preprod.cardanoscan.io/transaction/50b75cff9d025eecfc068f8b134ceda06ae77adfea2f8a0bbeea803ba11611a3) |
| Front desk's result to the owner | [b4ba6a9f…](https://preprod.cardanoscan.io/transaction/b4ba6a9fc01ab4a12e9efbf72ce09aedea66624c6d6903626d1aeb8c412206fc) |
| Seller collects, batched with other payments; `frontdesk/settlement.mjs` matched Sokosumi's receipt, the Payment Service and the chain | [53e61f78…](https://preprod.cardanoscan.io/transaction/53e61f78d4530ecc3efea7f301bd7e752837257a6ee54659aafab8c0e5721eeb) |

### Earlier paid tasks in a personal workspace

The same path ran first in a personal workspace, because the TUM workspace had no credits at the time. Task `01a18cf5-3d8c-73a0-a77d-ca9260026438` also hired two specialists: [locked](https://preprod.cardanoscan.io/transaction/7ddfbe9b519672da47e620bf6afa7bf1ed8643db308765b3274512414a91c1b7), [result](https://preprod.cardanoscan.io/transaction/6831d94105ca84be3716ccacab2e0998babc78c5982c76266d0a68cfaf3e0d52). Task `01a18cbb-ebaa-74ea-b448-d110ca18e300` was answered by the model alone, before the front desk could hire:

| Step | Transaction |
| --- | --- |
| Funds locked | [a7dedc75…](https://preprod.cardanoscan.io/transaction/a7dedc757343e821e5d40e560bbaf82c44b6e1a2e10718867c0961744a45110e) |
| Result submitted | [96173c7e…](https://preprod.cardanoscan.io/transaction/96173c7e57e6c19ee4689d78eae78bd8dbd10ac985e1fa36133f8bbb27a11901) |
| Seller receives 1 tUSDM; `frontdesk/settlement.mjs` matched Sokosumi's receipt, the Payment Service and the chain | [4c159b42…](https://preprod.cardanoscan.io/transaction/4c159b42b43750a56678ff914d739f9776aa420b52ce0281c88247e8d5d56557) |

### The orchestrator hiring two specialists

`npm run live -- c1`, with the real planner and the real Jev reviewer. The planner chose the cheap normalizer and the copywriter, 0.4 tUSDM in all. Both results passed acceptance and the work was delivered in 3.1 minutes. The sellers collected about 40 minutes later, once the escrow unlocked.

| Step | Transaction |
| --- | --- |
| Both hires locked in one transaction | [6ef6bc99…](https://preprod.cardanoscan.io/transaction/6ef6bc9993fb27e2641a98e4f9dfa0a5f9f58188dfbf719958d9f3b081ac42de) |
| Table result | [fee29042…](https://preprod.cardanoscan.io/transaction/fee29042d3055cb13023fb17d30ce334cb29998e332ee0e5e43bb28173c1c32f) |
| Product texts result | [a6425f44…](https://preprod.cardanoscan.io/transaction/a6425f4425c70558a71ae451b2d57e6a39d59d23f6a65a3f27139e75b522589b) |
| Sellers collect | [b7b0d700…](https://preprod.cardanoscan.io/transaction/b7b0d7000d9e8c98e16d97808fddbc014044c4addc2e724c72fcf7c29855aaa8) |

### A specialist that loses rows

`npm run live -- c2`, with the cheap agent started as `FAULT=drop_rows:2`. Acceptance named the two missing rows and the money came back. The planner read that refund, switched to the standard normalizer and Jev approved the change. Delivered in 6.4 minutes.

| Step | Transaction |
| --- | --- |
| Both hires locked | [0f4288f4…](https://preprod.cardanoscan.io/transaction/0f4288f477c98485b1b68d25f0b7f05630acc20f1b225a9a6751408116ba6b74) |
| Table result, two rows short; acceptance names `HM-019` and `HM-020` | [7497b057…](https://preprod.cardanoscan.io/transaction/7497b057db3bfb5ae7576dd2b51e2a989618fbc702194779d38b0cd74a832507) |
| Product texts result, passed | [6d1c0972…](https://preprod.cardanoscan.io/transaction/6d1c0972ad08a75c1c238990a7e5e37868bc95876afc9de27ed1c07eb676a9a9) |
| Refund requested | [4ce222f5…](https://preprod.cardanoscan.io/transaction/4ce222f52e32d3c0ac7536b334871a755ce29a5192596893f92faa34e72885f9) |
| Seller authorizes the refund | [a0cff3a0…](https://preprod.cardanoscan.io/transaction/a0cff3a00958be57dff199a5ab0e647a632e47edef84d51a662e9bd12194a228) |
| Refund withdrawn | [2aae19a6…](https://preprod.cardanoscan.io/transaction/2aae19a69612388f4133f6aa4dc086f39ef122d2c37625ac945d729c321ed76d) |
| Standard normalizer locked | [a01e68b9…](https://preprod.cardanoscan.io/transaction/a01e68b93013c389208209cf55452dd54b5dc155de2af92b11e77974723db4db) |
| Its result, passed | [7a267f4f…](https://preprod.cardanoscan.io/transaction/7a267f4f0414537cc9e71ca81c3936c4c23828e81875e1430f476d7cf49b04c4) |
| Copywriter collects | [331f6110…](https://preprod.cardanoscan.io/transaction/331f61103252e839cb60c6c14ad82e8997c9ceddcf98d44c082fc57cd8c4ad02) |
| Standard normalizer collects | [550ce842…](https://preprod.cardanoscan.io/transaction/550ce842c155fb2f319f4e04bfb6e89b65a532cef38bd9bc605e87dd84bd591a) |

### The first refund, with a probe script

One paid hire of the cheap agent, with `npm run probe:c2`, before the orchestrator was connected. It took 5.5 minutes from order to money back, the buyer's tUSDM returned in full, and the run cost the buyer about 1.5 test ADA in fees.

| Step | Transaction |
| --- | --- |
| Funds locked | [10aa9772…](https://preprod.cardanoscan.io/transaction/10aa97720e635a5247ac463fd99ff863b899387c9ce5001bddba0ab5f9d1b280) |
| Result submitted, two rows short; acceptance names `HM-019` and `HM-020` | [b2ae3ced…](https://preprod.cardanoscan.io/transaction/b2ae3ced8e560b73dba2b630821cabbe304c75a1ecc99d9aca1e4835c9b59547) |
| Refund requested, state Disputed | [9df3881f…](https://preprod.cardanoscan.io/transaction/9df3881f6fabd1304fc096c946047aefc6fef883cc2acd24987309457568a14f) |
| Seller authorizes the refund | [d0c08ae2…](https://preprod.cardanoscan.io/transaction/d0c08ae287a63e6ee52b105332f7946811d6f1b44460b28b3268f74dab393373) |
| Refund withdrawn | [68a8c550…](https://preprod.cardanoscan.io/transaction/68a8c550ad2f9ce8589e9e2b37a18b87e5e7cdc0a85b9b1a35ae83a7c9636c7b) |

## Platforms

CI runs every test on macOS and Windows, including starting a specialist agent as its own process. Every Preprod run above was on macOS. The Payment Service has not been installed on Windows, so the paid flow has not run there.

## Demo limits

- All the agents we hire are our own. The Preprod registry had no third-party agent we could hire when we checked.
- The specialist agents listen on 127.0.0.1, so a demo runs on one machine.
- A specialist agrees to every refund on its own. A real seller could dispute.
- The worker handles one paid task at a time, so a second task waits while a first one hires.
- Cleaned prices are plain numbers. Currency signs are dropped, because the checks compare numbers.
- Acceptance proves that no row was lost or invented, that frozen fields did not change and that copy follows its written rules. It cannot tell whether a product text is true.
