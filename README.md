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

## Setup and run

To be written.

## Demo limits

To be written.
