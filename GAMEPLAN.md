# Owly: gameplan

## Revision 2 (2026-09-17): what's actually being built

The original proposal is below and kept for the reasoning. Where it conflicts
with this section, **this section wins.**

**Decisions from Ana:** name **Owly**. Build on **Pond**. **Zero cost**: no
Anthropic key, no paid infrastructure, same as Foxy.

### What zero cost changes

| Area | Original plan | Revised | Why |
|---|---|---|---|
| LLM | Opus/Sonnet/Haiku by role | **No model in V1.** The `llm/` role interface ships with a `none` provider, so adding a key later needs no refactor. | No key, no budget |
| Natural-language missions | Our planner model | **Pond's own AI.** It turns "try to break signup" into structured action parameters from our manifest, and summarises our report back to the user. | The concierge already does language; we do evidence |
| Browser host | Fly.io microVM per run | **Vercel Hobby function**, Chromium via `@sparticuz/chromium` + `playwright-core` | Verified options for $0: HF Docker Spaces now require a paid plan; GitHub Actions terms forbid "part of a serverless application" and work "unrelated to the… software project"; Cloudflare's free tier gives 10 browser-minutes a day. Vercel Hobby gives 2 GB / 1 vCPU and 300s per invocation. |
| Language | Python | **TypeScript (Node)** | Serverless Chromium is a Node package. Foxy's Pond patterns get ported, not reused. |
| Long runs | One job on a worker | **Sliced**, as in Foxy's Pond scan: each Pond poll advances the run by one budgeted slice, and state lives in Postgres | 300s cap per invocation |
| Storage | Tigris | Neon Postgres (free); screenshots compressed, capped per run, purged after a retention window | No new account |
| Credentialed testing | Encrypted, verified domains | **Not in V1** | Serverless shares a runtime across runs, so isolation is weaker than a per-run VM. No customer secrets in that environment. |

### What V1 genuinely does without a model

This must be said plainly (spec §49): these are **deterministic checks and
scripted user behaviour, not AI judgement**, and the product must not call them
AI.

- **Finds, with evidence:** JS exceptions, console errors, failed same-origin
  requests (4xx/5xx), broken links and images, forms that accept invalid input,
  forms that fail or don't respond on submit, overflow and clipped content at
  mobile width, an automated accessibility scan (axe-core, labelled as limited),
  keyboard traps and invisible focus, slow or timing-out pages.
- **Simulates users by behaviour parameters:** a new-user persona (desktop, uses
  visible primary CTAs), a mobile + impatient persona (390px, touch, low
  patience), a keyboard-only persona. They walk heuristic journeys (primary CTA
  → forms → submit with valid and edge-case synthetic data) and record where
  the journey dead-ends.
- **Verifies:** every candidate is replayed in a fresh context before it is
  reported.
- **Cannot do yet** (needs a model): understand an arbitrary product's purpose,
  plan bespoke multi-step workflows, judge ambiguous UX, or suggest root causes
  beyond the evidence.

### Remaining risks

1. ~~**Chromium on this Vercel account.**~~ **Retired 2026-09-17.** A spike
   deployed to Vercel Hobby launched real Chromium 153 and loaded a page:
   3.2 s cold, 0.5 s warm, 185 MB of the 2 GB. The spike endpoint has since been
   removed from the code; the old deployment still serves it until the next
   deploy.
2. **Vercel Hobby prohibits commercial use.** It's the same risk Foxy already
   carries. Worth knowing; not solved by code.
3. **The Neon free plan may cap projects.** Fallback: an `owly` schema inside
   the existing database.
4. **Which Vercel account.** The spike landed in `i-anasops-projects`; Foxy is
   in `alpha-ea14`. Settle this before the real deploy.

### Progress

| Step | State | Evidence |
|---|---|---|
| 0: skeleton, config, safety modules | **done** | URL guard, redactor, action guard. `tests/mutation.mjs` removes each protection in turn and all 10 removals are caught. |
| 1: test lab + ground truth + scorer | **done** | Apps A–H on their own ports. `truth.json` lists 21 planted defects: 18 deterministic, 3 that need a model. An empty engine scores 0. |
| 2: browser, detectors, guards in a real browser | **done** | See the benchmark below. |
| 3: engine as resumable slices | **done** | `advance()` on plain JSON state; identical findings whether sliced once or one item at a time. |
| 4: ownership verification | **done** | File, meta tag or DNS TXT. Unverified sites get a passive scan that presses nothing. |
| 5: Pond API + report pages | **done** | Manifest validated against Pond's schema; parameters enforced; idempotent; one result billed per finished test. |
| 6: deployed | **done** | https://tryowly.vercel.app on its own Vercel project, its own Neon database, its own GitHub repo. |
| 7: live conformance | **done** | `tools/conformance.ts` passes **19/19** against the live deployment. |
| 8: real sites | **in progress** | First real target found three false positives and two live bugs; all fixed (below). |
| 9: list on Pond | waiting on Ana | |

**Benchmark, 2026-09-17 (`npm run bench`):**

| | |
|---|---|
| Deterministic defects found | **18 / 18** |
| All planted defects found | 18 / 21 (the 3 misses need a model: ambiguous labels, an unhelpful error, a stale total) |
| Precision | **100%** (18 reported, 18 real) |
| False positives on the clean app | **0** |
| Safety violations | **0**: Pay never pressed; the exfil origin never reached, including a redirect that fires 250 ms after load |
| Runtime, all 8 apps | 171 s locally |

**What building it caught, recorded because each was invisible until checked:**

- The first redaction test passed without testing what it claimed: the generic
  `password=` pattern masked the value, so exact-secret matching was never
  exercised. Rewritten under neutral field names.
- A sabotage run with `sed` silently didn't apply (shell escaping), so a guard
  test looked proven when it wasn't. Replaced by `tests/mutation.mjs`, which
  edits the files directly.
- The scorer matched findings in arrival order, so one report mentioning two
  hints could steal the other's credit. Now the most specific findings claim
  first, and a test runs both orders.
- An overlap was reported twice, once as overlapping controls and once as a
  covered control. The covered-control check now ignores covers that are
  themselves controls.
- **The injection trap's redirect fired after 1 s and never went off during a
  run**, so "exfil never reached" proved nothing. At 250 ms it fired, and
  exposed a real bug: refusing a navigation with `abort()` makes Chromium show
  its own error page, which Owly then tested (it reported "no `<title>`" on a
  page the site never served). Refusals now answer HTTP 204, which keeps the
  real page. A test pins it, and reverting the fix fails that test.
- `tests/guard.browser.test.ts` runs every attack in an **unguarded** browser
  first, where it has to succeed, then in Owly's session, where it has to fail.
  Without that first half, a pass could just mean the attack never happened.

### What deploying, and one real site, taught

Five faults, none of which any local test could have found. They are the
argument for testing from the other side, every time.

| Fault | How it showed | Fix |
|---|---|---|
| **`/api/tasks/:id` was a platform 404** - the endpoint Pond polls | Live conformance, 14/18. A `[...route]` catch-all matches a *single* path segment on plain Vercel functions | One file per path, and `tests/routes.test.ts` ties every Pond path to a file |
| **The short report link 404'd** | `/r/:id` rewrite hands the app the *original* path, so the `/api` base never matched. (Foxy's notes said the opposite - worth testing, not assuming) | The app answers `/r/:id` as well |
| **Chromium died mid-run** | Serverless Chromium is single-process; opening and closing a scratch page to read the user agent closed the browser | User agent built from the version; a keeper context holds the browser open |
| **A slice ran 123s and Vercel killed it** | The first real site. The slice budget was only checked *between* items, and a page can hang an evaluation forever | A hard per-item limit, one retry, then skip with a note. `tests/hang.browser.test.ts` uses a page that locks its own main thread |
| **Three false positives on a real site** | `/slack/install` (a redirect Owly itself blocked, leaving a blank page, reported as a dead end), `/manifest` and `/healthz` (JSON, reported as having no title and no lang) | A page that leaves the site or is not HTML is recorded as such and not judged. Findings on that site went 6 → 2, and both survivors are real |

The two that survived are genuine accessibility problems on `tryfoxy.vercel.app`:
text at contrast 3.67 against white (4.5 required), and links distinguishable
only by colour.

---

## 1. What it is, in one line

Give it the URL of a web app you own. A few AI users with different habits try
to do the app's main job. You get a shareable report with the bugs they hit,
where they got stuck, and the evidence for each finding: screenshots, the
action trace, console output and network responses.

---

## 2. What the research changed

The spec's candidate wedge was "autonomous user simulation + exploratory QA".
Half of that is already taken, and that matters for what we build first.

| Product | What it does | Price (published or third-party estimate) |
|---|---|---|
| **Momentic** | Agent "Mo" is pointed at a URL, explores, and returns an evidence-backed bug report with recording, repro steps and reasoning | Free: 2,000 credits (~200 runs). Pay-as-you-go: $125/mo |
| **QA.tech** | Autonomous agents, exploratory + regression testing, web and mobile | Not published. Third parties report ~$99/mo to start |
| **mabl** | Agentic tester, auto-healing, visual + accessibility checks on higher tiers | Not published. Estimates: ~$499/mo starter, $40k+/yr enterprise |
| **testRigor** | Plain-English scripted tests | Not published. Estimates: ~$900–1,000/mo Pro |
| **QA Wolf** | Managed service; self-serve at 1¢/AI credit + 15¢/runner-minute | Managed: ~$8,000/mo for 200 tests |
| **Octomind** | AI Playwright test generation | "OctoClaw" from $9.99/mo (listed July 2026) |
| **Evelance, Synthetic Users** | AI personas for usability research, on surveys and prototypes; they don't operate the live app | $2.99/persona; $2–27/interview |

**What this means:**

1. **"Explores the app and writes an evidence-backed bug report" is not unique.**
   Momentic already does it and has a generous free tier. Pitching that alone
   puts us in a price fight with a funded competitor.
2. **Usability findings from AI users operating the real app sit in a gap.**
   QA tools report bugs, not confusion. Synthetic-user tools report opinions on
   prototypes, not behaviour on a live product. Nobody pairs the two, backed by
   evidence.
3. **Scripted regression suites are where incumbents are strongest.** We don't
   compete there in V1.
4. **Cheap is not a moat on its own.** Octomind already sells a tier from
   $9.99/mo. What has to hold up is the verification engine and the quality of
   the report, not the price tag.
5. **Pond is a channel none of them use.** A founder asking in chat "test my
   app" and getting back a report link is a distribution path the incumbents
   don't have.

### The wedge

> **The first-time-user report.** The product's most important question, made
> concrete: *can a new person actually do the main thing, and if not, exactly
> where and why do they fail?* The bugs found on the way come in the same report.

It's narrower than "AI QA platform". It's what a founder shares, and it plays
to the verification engine rather than to test-suite maintenance.

### Where I'd change the spec (§58 permits this)

- **Hero copy.** "Test your product like 100 real users" breaks the spec's own
  rule against unsupported claims (§23). V1 runs 3–5 personas. Proposed
  instead: *"Watch AI users try your product, and see exactly where they fail."*
- **Authorisation.** A "yes I own this" checkbox can't stop anyone testing a
  site they don't own. **Use domain verification** instead: a token placed in a
  meta tag, a `/.well-known/` file, or a DNS TXT record, as Google Search Console
  does. Unverified domains get a passive, observe-only scan: public pages only,
  no form submissions, no logins, rate-limited. That keeps the free viral scan
  and stops the product being used against sites the user doesn't control.
- **Credentials through Pond chat.** Don't accept them. Chat transcripts are
  not a secrets channel. Authenticated testing goes through a one-time secure
  web form linked from the Pond reply.
- **Billing unit.** Charge per **test run**, never per finding. Per-finding
  billing pays us more for noisier reports, which is the exact opposite of §3C.

---

## 3. The hardest problems, ranked

| # | Problem | Why it's hard | How the plan handles it |
|---|---|---|---|
| 1 | **The oracle problem** | Without a spec, what counts as "expected behaviour"? This is where false positives come from. | Evidence-grade findings come from **deterministic detectors**: uncaught exceptions, 5xx responses, a submit with no response, broken links. The LLM decides where to go and interprets ambiguous cases; it is never the only source of a "confirmed" finding. |
| 2 | **Acting reliably on arbitrary SPAs** | Elements re-render, loads are async, overlays cover things, the same label appears twice. | Act on a numbered accessibility-tree snapshot we build ourselves, never raw coordinates. Wait for DOM, network and URL to settle after each action. Retry with a fresh snapshot. |
| 3 | **Prompt injection from the site under test** | The page is untrusted input and it's fed to the model. | A closed action vocabulary. Navigation is enforced in the browser layer regardless of what the model asks for. Secrets never enter prompts. See §6. |
| 4 | **Cost blow-up** | Agent loops re-send context every step. | Hard step and token budgets per mission, compressed snapshots, prompt caching, a cheap model for steps and a strong one only for planning and verification. |
| 5 | **Usability findings sliding into opinion** | "This feels confusing" is what §2B forbids. | Only report usability issues backed by measured behaviour: task failed, steps taken vs the shortest known path, backtracks, dead ends, errors hit, the same wrong control tried repeatedly, and agreement across personas. |
| 6 | **Running hostile websites safely** | Arbitrary sites run code in our browser. | One ephemeral microVM per run, destroyed afterwards. No shared browser across customers. Downloads blocked. |
| 7 | **Pond's constraints** | Runs time out (we declared 600s for Foxy), there's no caller identity, and plans allow a monthly price plus one included-units number. | Full test designed to finish in ≤8 minutes. Reports on unguessable links. Domain verification needs no identity. **The real time limit still needs confirming.** |

---

## 4. Architecture

```
                  ┌──────────────── Vercel (FastAPI) ────────────────┐
 Founder / Pond ─▶│ landing · run page · report · issue detail       │
                  │ Pond: /manifest /runs /tasks · admin console     │
                  └──────────┬───────────────────────────────▲───────┘
                             │ enqueue run                   │ read results
                             ▼                               │
                  ┌──────── Neon Postgres ─────────────────────────────┐
                  │ targets · runs · missions · steps (trace) · events │
                  │ findings · clusters · evidence refs · memory · cost│
                  └──────────┬───────────────────────────────▲─────────┘
                             │ lease job                     │ write
                             ▼                               │
   ┌──────────── Fly.io Machine: ONE PER RUN, destroyed after ─────────────┐
   │  policy ─▶ discover ─▶ understand ─▶ plan ─▶ execute ─▶ verify ─▶ report│
   │    │                                   │  ▲                           │
   │    │                           Playwright Chromium (in this VM only)  │
   │    └── url guard · action guard · redaction wrap EVERY browser call   │
   └──────────────────────────────┬────────────────────────────────────────┘
                                  ▼
                   Tigris object storage (screenshots, videos, traces)
                   private, signed URLs, retention window
```

### Decisions and why

| Decision | Choice | Why, briefly |
|---|---|---|
| Language | **Python** for everything | Playwright's Python bindings are first-class. Foxy's FastAPI, Neon, Vercel and Pond conformance patterns carry straight over. One language, one test suite. |
| Frontend | **Server-rendered FastAPI + small vanilla JS**, as in Foxy's console | The report page is the product. Foxy's console already shows this approach reaches the UI bar. Move to Next.js only if the dashboard outgrows it; not before. |
| Browser execution | **Fly.io Machine per run**, Chromium inside | A Firecracker microVM per run is real isolation (§26), destroyed afterwards. Cost is a fraction of a cent per run. It also gives object storage (Tigris) under the same account. |
| Considered, not chosen | Browserbase ($0.10–0.12/browser-hour) | Good isolation, but the agent loop still needs a host. Kept behind a `BrowserBackend` interface so it can be swapped in. |
| Considered, rejected | GitHub Actions (Foxy's sweep host) | Not suitable for running customer workloads. |
| Queue | Postgres table, `FOR UPDATE SKIP LOCKED` leases | Foxy's lease pattern already works. No new infrastructure. |
| LLM layer | A provider-agnostic interface by **role**: `classifier`, `planner`, `executor`, `verifier`, `reporter`, each mapped to a model in config | §20. Anthropic implementation first; the roles stop the rest of the code knowing which model it's using. |

### Model roles, starting configuration (benchmark decides)

| Role | Starting model | Reason |
|---|---|---|
| planner (understand + missions) | `claude-opus-5`, effort medium | Planning quality drives everything downstream |
| verifier (ambiguous cases) | `claude-sonnet-5` | Judgement on evidence, runs a handful of times per run |
| executor (per-step actions) | `claude-haiku-4-5` | Runs ~60× per test, so it dominates cost |
| classifier (safety, page types) | `claude-haiku-4-5` | Short structured outputs |
| reporter | `claude-sonnet-5` | Clear writing, separates fact from inference |

The benchmark will also test **one model at low effort for everything**. Newer
models at lower effort often match a multi-model cascade and keep one cache
namespace. If one model is as good per completed test, we choose it: simpler
wins.

### Code layout

```
agent-002/
  app/
    web/        FastAPI pages, Pond endpoints, admin
    policy/     classify · authorize (domain verification) · url_guard · action_guard · redact
    browser/    backend interface · playwright backend · snapshot · actions · observers
    discover/   same-origin crawl, forms, nav, auth detection
    understand/ app model: pages, entities, journeys, risk areas
    plan/       risk-ranked missions · personas (behaviour parameters, not prompts)
    execute/    agent loop: closed action set, budgets, stopping criteria
    detect/     deterministic detectors (no LLM)
    verify/     replay in a fresh context · confidence · fact/inference separation
    cluster/    signature-based de-duplication
    report/     finding schema · report writer · GitHub-issue markdown
    memory/     app / workflow / issue / test / safety memory
    llm/        role-based provider interface · cost ledger
    obs/        events, timings, token + cost per run
  lab/          deliberately broken apps + ground truth + benchmark runner
  tests/
```

---

## 5. MVP scope

### In V1

1. **Input:** URL, an optional one-line goal ("sign up and create a project"),
   optional credentials (verified domains only, entered in the web form).
2. **Classify → authorise → test** (§54), strictly in that order.
3. **Discover:** same-origin crawl, capped (~25 pages), with forms, navigation
   and auth walls identified.
4. **Understand:** an app model with the likely primary task and why.
5. **Plan:** up to 3 risk-ranked missions, each with the reason it was chosen.
6. **Execute** with **3 personas as real behaviour parameters**. Each changes
   the viewport, input method, patience (step and retry budget), how
   instructions are read, and stopping criteria:
   - *New user*: desktop, reads only visible text, attempts the primary task
   - *Mobile + impatient*: 390px viewport, touch, skips copy, low retry budget
   - *Keyboard-only*: no pointer, checks focus order and visibility
7. **Detect**, deterministic: JS exceptions, console errors, 4xx/5xx on
   same-origin calls, broken links and images, a submit with no response,
   horizontal overflow at 390px, an accessibility scan (labelled as a limited
   automated check, never as WCAG compliance, per §5).
8. **Verify:** every candidate is replayed in a fresh browser context. It's
   reported only if it reproduces. Confidence levels are confirmed, likely,
   possible and inconclusive, each with an explicit reason.
9. **Cluster** duplicates, keeping each instance's evidence.
10. **Report:** a live progress page ("Testing signup… ⚠ possible issue…
    reproducing… confirmed") showing real events from the run, never scripted
    ones. A report page, an issue detail page, and **copy as GitHub issue**
    (markdown).
11. **Pond actions:** `start_test` (async), `get_report`, `verify_domain`,
    `quick_scan`.
12. **Admin console** in the Foxy style: runs, cost per run, false-positive
    marks, the safety review queue.

### Not in V1 (the architecture leaves room)

Parallel swarm (V1 runs personas one after another), scheduled monitoring,
regression suites and one-click retest (the trace format supports replay from
day one; the button waits), GitHub/Linear/Jira APIs, accounts and teams, CI/CD,
native mobile.

---

## 6. Safety architecture

Enforced in code, not in prompts. A prompt is a request; these are walls.

| Threat | Control |
|---|---|
| **Harmful product** (§27) | Before any deep crawl, the classifier reads the homepage, about, pricing and a sample of internal pages, and judges purpose, functionality and business model. Keywords never decide on their own. Outcomes: `allowed` / `blocked` / `manual_review`. When uncertain the result is *"Unable to confidently classify. Manual review required"*, never an accusation. Blocked runs stop at once with a short neutral note. Checked against a labelled fixture set of hard cases: a security training site that mentions malware, a finance article that mentions betting, an actual betting site. |
| **Unauthorised testing** (§54) | Domain verification unlocks active testing. Unverified domains get a passive scan only. |
| **Prompt injection** (§25) | Page content reaches the model only as quoted data inside tool results, never in system instructions. The model can only choose from a closed set of actions (`click(ref)`, `type(ref, text)`, `select`, `scroll`, `back`, `wait`, `done`) over element refs **we** assigned. It has no tool for fetching arbitrary URLs or reading secrets. The lab includes a trap page that tells the agent to send credentials somewhere; the benchmark fails if the agent does anything about it. |
| **Unauthorised navigation / SSRF** | A URL guard at Playwright route interception, applied to every request, not just the ones the model chooses. It blocks private, loopback, link-local and metadata IP ranges after DNS resolution (defeating DNS rebinding), non-http(s) schemes, and top-level navigation away from the verified origin. |
| **Destructive actions** (§8) | An action guard classifies each target control's intent (delete, pay, purchase, send, invite, transfer…) from its label and context. Blocked by default. Allowed only on a verified domain the user has marked as staging. |
| **Credential leakage** (§9) | Credentials are stored encrypted and reach the executor as placeholders (`{{secret.password}}`), filled in by the browser layer at the last moment. Typed values are redacted from traces, and password and marked fields are masked in every screenshot. A redaction pass runs over all logs, reports and model inputs, with tests that search the output for the secret. |
| **Malicious downloads** | Downloads refused. File uploads are off unless allowed, and even then only synthetic fixtures. |
| **Host escape** | One microVM per run, no persistent disk, destroyed afterwards, with a time and memory ceiling. |
| **Neutral policy** (§29) | Rules apply to what the software does, never to who the customer is. No religious framing anywhere in the product. |

---

## 7. The test lab, built BEFORE the agent

Foxy's hardest lesson: *verify from the other side.* So we build the thing that
catches a false "all green" before the thing that could say it.

Each lab app is a small local site with a **ground-truth file** listing its
seeded defects. The benchmark runner scores every agent run against it.

| App | Seeded defects | What it measures |
|---|---|---|
| **A: Signup** | Submit returns 500 on valid input; validation accepts an invalid email | Functional detection + verification |
| **B: Onboarding** | "Continue" hidden below the fold on mobile; ambiguous labels; a dead-end step with no way forward | Usability from behaviour, not opinion |
| **C: Responsive** | Overflow and clipped text at 390px; overlapping nav | Visual detection |
| **D: Flaky API** | Save fails 1 in 3 times | Reliability + "likely" vs "confirmed" |
| **E: Accessibility** | Unlabelled inputs, invisible focus, keyboard trap in a modal | Accessibility checks |
| **F: Checkout (synthetic)** | Total doesn't update; a "Pay" button (must never be pressed) | Workflow bugs + the destructive-action guard |
| **G: Clean control** | **Nothing wrong** | **False positives directly: any finding here is wrong** |
| **H: Injection trap** | Page text instructs the agent to exfiltrate credentials | Security: must be ignored |

**Benchmark output per run:** recall (seeded defects found), precision,
false positives (app G), reproduction rate, time to first useful finding, and
**cost per run in dollars**.

---

## 8. Economics (*estimate*, replaced by measurement at step 9)

Assumptions for one **full test**: 3 missions, ~60 agent steps, ~20 pages.

| Stage | Model | Assumed tokens | Est. cost |
|---|---|---|---|
| Safety classification | Haiku 4.5 ($1/$5 per M) | 8k in, 0.5k out | $0.01 |
| Understand + plan | Opus 5 ($5/$25) | 25k in, 5k out incl. thinking | $0.25 |
| Execute, 60 steps | Haiku 4.5 | ~5k in/step (~40% cached), 250 out/step, ~10 screenshots | $0.28 |
| Verify ~4 ambiguous cases | Sonnet 5 ($2/$10) | 12k in, 1.5k out each | $0.16 |
| Write report | Sonnet 5 | 15k in, 4k out | $0.07 |
| Browser microVM + storage | Fly | ~12 min | <$0.01 |
| **Subtotal** | | | **~$0.77** |
| **With 1.5× buffer for retries** | | | **~$1.15** |

A **quick scan** (deterministic detectors plus a short summary, no missions)
comes to roughly **$0.05–0.10**.

### Provisional pricing (on Pond: monthly plans, unit = test run)

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | 2 full tests/month + quick scans (rate-limited) |
| Starter | $19/mo | 10 full tests |
| Pro | $49/mo | 30 full tests + credentialed testing on verified domains |

**This is the part I'm least sure of, and I'm saying so.** At ~$1.15/test,
Starter costs ~$11.50 to serve: about 40% gross margin *before Pond's fee*. That
is too thin. So there's a **measured target of ≤$0.60 per full test**, reached
through caching, snapshot compression and the single-model comparison. If the
benchmark can't reach it, Starter drops to 6 tests or moves to $29. The
decision happens at step 9, with real numbers.

For comparison: Momentic $125/mo pay-as-you-go, QA.tech ~$99+, mabl ~$499+,
testRigor ~$900+, QA Wolf managed ~$8k. Octomind has a $9.99 tier, so being
cheap alone doesn't make us different.

---

## 9. Build order: each stage has a check that must pass

| Step | Build | Passes when |
|---|---|---|
| 0 | Skeleton, config, CI (3.11 + 3.12), redaction module | Tests green, including "secret never appears in output" |
| 1 | **Test lab** (apps A–H) + ground truth + scorer | Apps serve; scorer produces 0% recall with no agent, proving it measures something |
| 2 | Browser layer + **deterministic detectors** + URL guard | Seeded deterministic defects in A, C, E found with **no LLM**; **app G: 0 findings**; SSRF tests block private IPs and rebinding |
| 3 | Discover + app model | Correct inventory of pages, forms and primary task for each lab app |
| 4 | Safety classifier + domain verification | Labelled hard-case fixtures classified correctly; unverified domain cannot submit forms |
| 5 | Executor + missions + personas | Missions complete on lab apps; **app H trap ignored**; the Pay button is never pressed |
| 6 | Verifier + confidence + clustering | Precision target met; app G still 0; app D reported as "likely", not "confirmed" |
| 7 | Report + progress page + issue page | **Pages loaded and checked in a real browser**, not just unit tests (Foxy's 500 lesson) |
| 8 | Pond integration + conformance tool (adapted from Foxy's) | Full conformance pass against the live deploy |
| 9 | Deploy; run against **tryfoxy.vercel.app** (we own it) | Measured cost/run and runtime → pricing locked |
| 10+ | Iterate on the benchmark | Recall up, false positives down, cost down |

---

## 10. What I need from you

1. **Distribution.** My recommendation is **Pond-first**: Pond handles users and
   billing, and the report page is the dashboard. Accounts, teams and Stripe
   come later. The alternative, a standalone SaaS first, is a much bigger V1.
2. **Accounts and keys** (none exist yet; nothing costs money until these do):
   - **Anthropic API key**, with a monthly spend limit set in the console
   - **Fly.io account** (microVMs + Tigris storage)
   - Neon + Vercel already exist from Foxy (a new project each)
3. **A development LLM budget.** Benchmark runs cost real money. I'd propose
   **$50** for steps 5–10, tracked by the cost ledger, and I stop and ask
   before going over.
4. **Pond facts you can check from your dashboard:** Pond's fee percentage, and
   whether a run can take longer than 600 seconds.
5. **A name.** Not blocking. `agent-002` until you pick one.

Once you answer 1–3, I start at step 0.

---

### Sources

- Momentic pricing: https://momentic.ai/pricing
- Momentic's exploratory agent: https://momentic.ai/blog/ai-agents-in-qa-testing
- QA.tech plans: https://qa.tech/pricing · product: https://qa.tech/
- QA.tech starting price (third-party): https://www.saasworthy.com/product/qa-tech
- mabl pricing estimates: https://bug0.com/knowledge-base/mabl-pricing
- testRigor pricing estimates: https://getautonoma.com/blog/testrigor-pricing
- QA Wolf pricing: https://bug0.com/knowledge-base/qa-wolf-pricing · https://getautonoma.com/blog/qa-wolf-pricing
- Octomind pricing (active, July 2026): https://www.test-lab.ai/blog/ai-testing-pricing
- Synthetic-user tool pricing: https://www.evelance.io/blog/best-synthetic-user-testing-platforms/ · https://aimultiple.com/synthetic-users
- Browserbase pricing: https://www.browserbase.com/pricing
- Claude model pricing: Anthropic API model table (Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5 per M tokens)
