# VeriTag — an AI-verified claim registry on GenLayer

Anyone can claim anything. A tweet says a package is safe. A vendor says a
dependency has no known CVEs. A marketplace listing says an item is genuine.
None of those claims carry weight on their own — there is nothing stopping the
claimant from writing whatever is convenient.

VeriTag makes the claim checkable.

A claim is submitted together with an **evidence URL**. A leader validator
fetches that page, extracts a bounded excerpt, and asks an LLM whether the
content actually supports the claim. The other validators repeat the check
independently — each does its own fetch and forms its own judgement — and
consensus only commits when they agree. The verdict, the evidence excerpt, the
submitter and a timestamp are recorded on-chain.

- **Live app**: <https://adebisi1111.github.io/veritag/>
- **Deployed contract**: `0x9973a029E5E0b6AdfA8aa5f56fA4F9bd1C60584f`
- **Network**: GenLayer Studio **dev** (chain `61997`), RPC `https://studio-dev.genlayer.com/api`
- **Source**: [`contracts/veritag.py`](contracts/veritag.py)

The linked source **is** the deployed contract — not a later revision of it. You
can confirm that yourself against the chain:

```bash
genlayer network set studio-dev
genlayer code 0x9973a029E5E0b6AdfA8aa5f56fA4F9bd1C60584f > deployed.py
diff deployed.py contracts/veritag.py
```

The only difference is trailing blank lines. Anyone reviewing this can verify the
source, the deployed bytecode's source and the explorer address all refer to the
same artifact.

---

## Verified working

Deployed and exercised against the live network. Three claims, both verdict
outcomes, one rejected transaction:

| Claim | Question (about python.org/downloads) | Verdict |
|---|---|---|
| `claim-1` | Does this page mention Python downloads? | `supported` |
| `claim-2` | Does this page describe Antarctic penguin migration patterns? | `not_supported` |
| `claim-3` | *(same question, re-submitted)* | `not_supported` |

Each record carries the evidence excerpt, the submitter
(`0x61fd0047…e3dc3`), a real transaction timestamp and the consensus result.
The committee distinguishes **true from false claims about the same page** —
it is not rubber-stamping everything as supported.

**A bad URL is rejected cleanly.** Submitting `https://example.invalid/…`
produced `FINISHED_WITH_ERROR` on the leader and wrote nothing to the registry.
An unreachable page cannot manufacture a verdict.

**A split committee writes nothing.** An earlier claim — *"Does this page list
Python 3.13 as a stable release?"* — was decided `UNDETERMINED`, no validator
majority, and no record was created. A verdict only exists when validators agree.

The live frontend at <https://adebisi1111.github.io/veritag/> was
browser-verified against the deployed contract: it reads 3 claims, renders green
`supported` and red `refuted` badges distinctly, and shows the evidence excerpt
on every card.

(The badge word `refuted` is the UI's label for the on-chain verdict
`not_supported`. The contract stores only `supported` and `not_supported`;
the frontend maps them for display and matches `not_supported` exactly first, so
it can never misread one as the other.)

## Why this needs GenLayer

VeriTag does not compute anything a normal contract could compute. The task is
"fetch a page you have never seen, and decide whether it says what the claimant
says it says." That needs a live HTTP request and a language model — exactly the
two primitives only an Intelligent Contract can do.

The AI is load-bearing, not decorative:

- the leader's fetch result is **not** trusted by the validators
- each validator repeats the fetch and the judgement independently
- a validator accepts only if it independently reaches the same conclusion
- the commit happens only through `gl.vm.run_nondet`, so a verdict the
  committee cannot agree on is never written

## What it does and does not do

| | |
|---|---|
| **Verified** | evidence page is fetched over HTTP by the contract |
| **Verified** | an LLM judges the excerpt against the claim |
| **Verified** | validators independently repeat both steps |
| **Verified** | verdict, excerpt, submitter and timestamp stored on-chain |
| **Verified** | consensus required — a split committee writes nothing |
| **Not verified** | that the *source page itself* is truthful |
| **Not verified** | that the source page stays unchanged later |

VeriTag answers "does this page support this claim?" — not "is this claim true
in the world". The evidence is named in every record precisely so a reader can
judge the source for themselves.

## Real uses

- **supply chain** — "this dependency version has no known advisories"
- **content attestation** — "this page states X", with a permanent timestamp
- **abuse filtering** — "this message contains a phishing link"
- **off-chain event binding** — "this event happened", corroborated by independent fetches

---

## Contract

| method | kind | returns |
|---|---|---|
| `submit_claim(url, question)` | write | the new claim id |
| `get_verdict(claim_id)` | view | the full record, including `excerpt` and `submitter` |
| `list_claims()` | view | every claim (id, question, url, verdict, timestamp) |
| `total_claims()` | view | count |

`question` must be phrased so that **yes** means the page supports the claim:

> "Does this page list Python 3.13 as a stable release?"

The verdict is `supported` when the committee agrees the excerpt supports the
claim, and `not_supported` when it agrees it does not.

### Runtime notes

Three API details that are easy to get wrong, all confirmed on-chain:

- `gl.nondet.web.request(url, method="GET")` returns a `Response` whose fields
  are `.status`, `.headers` and `.body`. **There is no `.status_code`.**
- The nondeterministic entry point is `gl.vm.run_nondet(leader, validator)`.
- The validator receives a `Result` wrapper, so it must compare against
  `leader_res.calldata`, not the raw value.
- Transaction time comes from `datetime.now(timezone.utc)`. GenVM pins the
  Python clock to the transaction timestamp, so every validator re-executing the
  call sees the same value and the recorded time is deterministic. Verified
  on-chain: the deployed code took this path and `claim-1` carries a real
  timestamp (`2026-10-01 15:42:49Z`), not a zero fallback.

Consensus v0.6 charges fees on deploy and write. Hand-signed EVM transactions
are rejected at admission with `NO_MAJORITY` and zero rounds, because they
carry no fee distribution. Use the CLI so it can build the estimate:

```bash
genlayer network set studio-dev
genlayer deploy --contract contracts/veritag.py --fees '<preset>' --fee-value <wei>
genlayer write <address> submit_claim --args <url> <question> --fees '<preset>' --fee-value <wei>
```

Contract arguments always go through `--args`; passing them positionally fails
with `too many arguments for 'call'`.

```bash
```

`genlayer estimate-fees <address> <method> --args ...` prints a ready-to-use
preset. Studio dev needs CLI **v0.40 RC** — earlier CLIs do not list the
network at all.

## Frontend

React + Vite + TypeScript + Tailwind CSS v4.

- **Reads** go through `gen_call` with GenVM's own tagged-varint codec in
  `src/genlayer.ts`.
- **Writes** go through `src/writes.ts` on `genlayer-js` `2.0.0-rc.1`, using the
  `studioDevnet` chain definition (`61997`) that matches this deployment's RPC.
  The user signs with their own browser wallet; the frontend holds no keys and
  requires no backend.

A GenLayer write is a **rollup transaction with a fee policy**, not an EVM
`eth_sendRawTransaction`. Two consequences the code handles explicitly:

1. `estimateTransactionFeesForWrite` must run before `writeContract`, or
   admission rejects the transaction. The estimate is cached per page load.
2. `ACCEPTED` / `FINALIZED` does **not** mean the contract call succeeded, so
   the finalized transaction is checked with `isSuccessful()` before success is
   reported.

The CLI remains available for scripted writes and for redeploying.

```bash
npm install
npm run dev
npm run build
node check-writes.cjs   # asserts the frontend calls the contract, not a link
```

### Submitting from the UI

The submit control signs a real transaction. It requires:

- a browser wallet (MetaMask, or the MetaMask app browser);
- that wallet switched to Studio dev (`chainId 61997` / `0xf22d`) — the app
  requests the switch on connect;
- funds on Studio dev to cover the fee.

Consensus is AI-powered, so a submit can take around a minute: each validator
independently fetches the evidence URL and reaches its own verdict. The UI shows
the live stage and, on success, the consensus transaction hash. Without a wallet
the control is present but reports why it cannot submit instead of failing
silently.

An earlier build offered a "Submit in GenLayer Studio" link that navigated to
Studio instead of calling the contract. That was removed: it read as a write but
performed none.

### Note for reviewers

**Reading the registry needs nothing** — no wallet, no funds, no setup. Open the
app and the three recorded claims load straight from Studio dev over RPC.

**Submitting a new claim needs a wallet with Studio-dev funds.** If you are
reviewing on a laptop, this is the step that will stop you, and it is a funding
requirement rather than a defect:

| Requirement | Value |
| --- | --- |
| Wallet | MetaMask, or any EIP-1193 wallet |
| Network | GenLayer Studio **dev**, chain `61997` (`0xf22d`) |
| RPC | `https://studio-dev.genlayer.com/api` |
| Funds | GEN on Studio dev, to cover the transaction fee |

The app requests the network switch itself on connect, and shows an explicit
message when no wallet is detected rather than failing silently.

For funds, GenLayer Studio serves a faucet at
`https://studio.genlayer.com/faucet`. (The public
`testnet-faucet.genlayer.foundation` faucet is for **Asimov**, chain `4221`, and
will not fund a `61997` wallet.) If the Studio faucet does not serve `61997`
either, a reviewer can still verify everything on-chain through the CLI without
touching the browser UI:

```bash
genlayer network set studio-dev
genlayer call 0x9973a029E5E0b6AdfA8aa5f56fA4F9bd1C60584f list_claims
genlayer call 0x9973a029E5E0b6AdfA8aa5f56fA4F9bd1C60584f get_verdict --args claim-1
```

So a missing wallet degrades the review, it does not block it: the recorded
verdicts, the excerpts and the consensus history are all readable without one.

## Project structure

```
veritag/
├── contracts/veritag.py        # Intelligent Contract (Python) — the deployed one
├── contracts/stream_payments.py# unused earlier StreamPay draft, kept for history
├── src/genlayer.ts             # Studio RPC + GenVM codec (reads)
├── src/writes.ts               # wallet-signed consensus transactions (writes)
├── src/App.tsx                 # React UI
├── check-writes.cjs            # asserts the UI calls the contract
└── vite.config.ts
```

## Licence

MIT