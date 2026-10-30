import {z} from 'zod';
import {MAX_PROMPT_CHARS} from './constants.mjs';

const AtomicAmount = z.string().regex(/^[1-9]\d{0,24}$/, 'must be a positive integer string in atomic units');
const EpochMs = z.coerce.number().int().positive();
const Hex = z.string().regex(/^[0-9a-fA-F]+$/, 'must be hex');

export const SUBTASKS = Object.freeze(['normalize', 'copy']);
const Subtask = z.enum(SUBTASKS);

export const Price = z.object({unit: z.string().max(150), amount: AtomicAmount});

export const AcceptanceSpec = z.object({
  required_columns: z.array(z.string()).min(1),
  key: z.string().min(1),
  immutable: z.array(z.string()),
  allowed_units: z.array(z.string()).min(1),
  allowed_categories: z.array(z.string()).min(1),
  price_positive: z.boolean(),
  copy: z.object({
    max_chars: z.number().int().positive(),
    must_mention: z.array(z.string()),
    banned_phrases: z.array(z.string()),
  }),
});

export const AllowlistEntry = z.object({
  agentIdentifier: z.string().min(57),
  sellerVkey: Hex.length(56),
  name: z.string().min(1),
  apiBaseUrl: z.url(),
  role: Subtask,
});

export const Mandate = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  budget: z.record(z.string(), AtomicAmount),
  perHire: z.record(z.string(), AtomicAmount),
  maxHires: z.number().int().positive(),
  allowlist: z.array(AllowlistEntry).min(1),
  deliverBy: EpochMs,
  lockUntil: EpochMs,
  acceptance: AcceptanceSpec,
  createdAt: EpochMs,
});

// Strict on purpose: a planner output with extra fields such as payTo is a rejected proposal.
export const Proposal = z.strictObject({
  proposalId: z.string().min(1),
  subtask: Subtask,
  agentIdentifier: z.string().min(1),
  maxPrice: Price,
  reason: z.string().max(500),
});

export const Listing = z.object({
  agentIdentifier: z.string().min(57),
  name: z.string().min(1),
  apiBaseUrl: z.string().min(1),
  pricingType: z.enum(['Fixed', 'Dynamic', 'Free']),
  price: Price.nullable(),
  supportedPaymentSourceIndex: z.number().int().min(0),
  tags: z.array(z.string()),
});

export const Job = z.object({
  kind: Subtask,
  table: z.array(z.record(z.string(), z.unknown())).min(1),
  acceptance: AcceptanceSpec,
  key: z.string().min(1),
});

export function jobPrompt(job) {
  const prompt = JSON.stringify(Job.parse(job));
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Job prompt has ${prompt.length} characters, the limit is ${MAX_PROMPT_CHARS}`);
  }
  return prompt;
}

export const Quote = z.object({
  jobId: z.string().min(1),
  blockchainIdentifier: z.string().min(1).max(8000),
  agentIdentifier: z.string().min(1),
  sellerVkey: z.string().min(1),
  inputHash: Hex,
  identifierFromPurchaser: Hex,
  paymentSourceType: z.string().min(1),
  supportedPaymentSourceIndex: z.number().int().min(0),
  payByTime: EpochMs,
  submitResultTime: EpochMs,
  unlockTime: EpochMs,
  externalDisputeUnlockTime: EpochMs,
});

// Maps the starter's start_job response, which mixes input_hash and sellerVKey, to Quote.
export function quoteFromStartJob(raw) {
  return Quote.parse({
    jobId: raw.id ?? raw.job_id,
    blockchainIdentifier: raw.blockchainIdentifier,
    agentIdentifier: raw.agentIdentifier,
    sellerVkey: raw.sellerVKey ?? raw.sellerVkey,
    inputHash: raw.input_hash ?? raw.inputHash,
    identifierFromPurchaser: raw.identifierFromPurchaser,
    paymentSourceType: raw.paymentSourceType,
    supportedPaymentSourceIndex: raw.supportedPaymentSourceIndex,
    payByTime: raw.payByTime,
    submitResultTime: raw.submitResultTime,
    unlockTime: raw.unlockTime,
    externalDisputeUnlockTime: raw.externalDisputeUnlockTime,
  });
}

const Tx = z.object({
  txHash: z.string().nullable(),
  status: z.string(),
  newOnChainState: z.string().nullable(),
});

const Funds = z.array(z.object({unit: z.string(), amount: z.string()}));

export const PurchaseView = z.object({
  blockchainIdentifier: z.string().min(1),
  onChainState: z.string().nullable(),
  resultHash: z.string().nullable(),
  nextAction: z.object({
    requestedAction: z.string().nullable(),
    errorType: z.string().nullable(),
    errorNote: z.string().nullable(),
  }),
  current: Tx.nullable(),
  history: z.array(Tx),
  withdrawnForBuyer: Funds,
  withdrawnForSeller: Funds,
});

const toTx = (tx) => (tx ? {txHash: tx.txHash ?? null, status: tx.status, newOnChainState: tx.newOnChainState ?? null} : null);
const toFunds = (funds) => (funds ?? []).map(({unit, amount}) => ({unit, amount: String(amount)}));

// Maps a Payment Service purchase response to PurchaseView.
export function purchaseViewFrom(raw) {
  return PurchaseView.parse({
    blockchainIdentifier: raw.blockchainIdentifier,
    onChainState: raw.onChainState ?? null,
    resultHash: raw.resultHash || null,
    nextAction: {
      requestedAction: raw.NextAction?.requestedAction ?? null,
      errorType: raw.NextAction?.errorType ?? null,
      errorNote: raw.NextAction?.errorNote ?? null,
    },
    current: toTx(raw.CurrentTransaction),
    history: (raw.TransactionHistory ?? []).map(toTx),
    withdrawnForBuyer: toFunds(raw.WithdrawnForBuyer),
    withdrawnForSeller: toFunds(raw.WithdrawnForSeller),
  });
}

// Same rule as the starter's confirmedState.
export const isConfirmed = (view, state) =>
  [view.current, ...view.history].some((tx) => tx?.status === 'Confirmed' && tx?.newOnChainState === state);

export const EvidenceLine = z.object({
  ts: EpochMs,
  taskId: z.string().min(1),
  step: z.string().min(1),
  proposalId: z.string().optional(),
  subtask: z.string().optional(),
  rule: z.string().optional(),
  code: z.string().optional(),
  decision: z.string().optional(),
  refs: z
    .object({
      jobId: z.string(),
      blockchainIdentifier: z.string(),
      txHash: z.string(),
      nonce: z.string(),
    })
    .partial()
    .optional(),
  amount: z.object({unit: z.string(), value: AtomicAmount}).optional(),
  terms: Quote.optional(),
  reason: z.string().optional(),
  detail: z.unknown().optional(),
});
