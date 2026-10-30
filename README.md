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
| Masumi Payment Service | a846392, plus the one-line patch below | MIT | Escrow, registration, purchases, refunds |
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

### Testing the guard

```
npm run batch
npm run redteam
```

`batch` runs 1000 generated out-of-mandate cases, 100 legal ones, each limit at the edge and one unit over, a replay and a race for one budget. It needs no network; add `-- --with-jev` to include the reviewer. `redteam` has a model write attacks on the guard and runs hand-written injection notes against the real planner. Both write a report to `.local/`.

### Keeping everything online

```
npm run online
npm run online:status
npm run online:stop
```

`online` starts a small supervisor in the background. It watches the Payment Service, the Coworker's agent and worker, and the three specialists. What is down gets started, what stops answering gets restarted, and a service already running by hand is left alone until it dies. It also checks the Sokosumi login, which only a person can renew, and keeps a Mac from idle sleep. A closed lid still sleeps the machine. Logs go to `.local/online/`.

Run it from a shell where Node 24 is on the PATH. It expects the Coworker in `../tum-hackathon-quickstart` and the Payment Service in `../masumi-payment-service`; set `COWORKER_DIR` or `MPS_DIR` to use other folders. To demo a refund, stop it and start it again with `FAULT=drop_rows:2 npm run online`. On Windows it has been tested only with a small test server: set the power plan so the machine does not sleep.

### Payment Service patch

Run the Payment Service with this patch, or a refund for a purchase that already has a result is never collected:

```
git -C masumi-payment-service apply ../hakimi-milky/patches/masumi-payment-service-refund-result-hash.patch
```

When a seller authorizes a refund, the contract empties the result hash. The service stores `new hash ?? old hash` on the purchase, so the empty value is overwritten with the old one, and its job that collects refunds only picks purchases with no hash. The patch keeps the empty value. It changes no contract code.

## What has run on Preprod

One paid hire of the cheap agent that ended in a refund, with `npm run probe:c2`. It took 5.5 minutes from order to money back, the buyer's tUSDM returned in full, and the run cost the buyer about 1.5 test ADA in fees.

| Step | Transaction |
| --- | --- |
| Funds locked | [10aa9772…](https://preprod.cardanoscan.io/transaction/10aa97720e635a5247ac463fd99ff863b899387c9ce5001bddba0ab5f9d1b280) |
| Result submitted, two rows short; acceptance names `HM-019` and `HM-020` | [b2ae3ced…](https://preprod.cardanoscan.io/transaction/b2ae3ced8e560b73dba2b630821cabbe304c75a1ecc99d9aca1e4835c9b59547) |
| Refund requested, state Disputed | [9df3881f…](https://preprod.cardanoscan.io/transaction/9df3881f6fabd1304fc096c946047aefc6fef883cc2acd24987309457568a14f) |
| Seller authorizes the refund | [d0c08ae2…](https://preprod.cardanoscan.io/transaction/d0c08ae287a63e6ee52b105332f7946811d6f1b44460b28b3268f74dab393373) |
| Refund withdrawn | [68a8c550…](https://preprod.cardanoscan.io/transaction/68a8c550ad2f9ce8589e9e2b37a18b87e5e7cdc0a85b9b1a35ae83a7c9636c7b) |

This run used a probe script, not the full orchestrator, which still waits for the real payment client. A paid job through Sokosumi has not run yet.

## Platforms

CI runs every test on macOS and Windows, including starting a specialist agent as its own process. The Preprod run above was on macOS. The Payment Service has not been installed on Windows.

## Demo limits

- All the agents we hire are our own. The Preprod registry had no third-party agent we could hire when we checked.
- The specialist agents listen on 127.0.0.1, so a demo runs on one machine.
- A specialist agrees to every refund on its own. A real seller could dispute.
- Acceptance proves that no row was lost or invented, that frozen fields did not change and that copy follows its written rules. It cannot tell whether a product text is true.
