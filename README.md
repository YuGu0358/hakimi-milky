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
| Masumi Payment Service | a846392 | MIT | Escrow, registration, purchases, refunds |
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

## Platforms

CI runs every test on macOS and Windows, including starting a specialist agent as its own process. Paid runs on Preprod have not been done yet on either system. The Payment Service has not been installed on Windows.

## Demo limits

- Nothing here has settled on chain yet. This section will name the transaction hashes once it has.
- All the agents we hire are our own. The Preprod registry had no third-party agent we could hire when we checked.
- The specialist agents listen on 127.0.0.1, so a demo runs on one machine.
- A specialist agrees to every refund on its own. A real seller could dispute.
- Acceptance proves that no row was lost or invented, that frozen fields did not change and that copy follows its written rules. It cannot tell whether a product text is true.
