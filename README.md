# Owly

Owly opens your website in a real browser and tries to do what it is for:
follow the main call to action, fill the form in, press the button. The report
opens with the answer -

> **A new visitor could not create an account.** Stopped at step 4 of 4:
> pressing "Create account" - the server failed (HTTP 500).

- with a screenshot of every step, and then the problems it hit on the way:
as a new desktop user, as an impatient phone user, and with only a keyboard.

**Live:** https://tryowly.vercel.app · **On Pond:** ask it to test your site.

**A real report:** https://tryowly.vercel.app/demo-report.html - Owly testing
`owly-demo-rho.vercel.app`, a small site in `demo-site/` whose signup fails on
purpose. Nothing in it is staged: the screenshots are what the browser showed.

It is not an AI in its checks. Owly runs rule-based checks and scripted user
behaviour, and everything it reports comes from something the browser actually
recorded. The conversation you have with it is Pond's.

---

## What it finds

| | |
|---|---|
| **The main journey** | whether a newcomer can finish the site's main task, which step stopped them, and why - with the screen at that moment |
| **Forms** | submissions that fail on the server, submissions that produce no visible result at all, fields that accept an obviously invalid email |
| **Errors** | uncaught JavaScript exceptions (with the line of source that threw), console errors, failed and slow requests |
| **Links and images** | links that lead to error pages, images that do not load |
| **Phones** | sideways scrolling, text cut off by a too-small box, overlapping controls, buttons covered by something else |
| **Keyboard and accessibility** | focus that cannot be seen, dialogs a keyboard user cannot leave, an automated WCAG 2.1 A/AA scan (axe-core) |
| **Reliability** | a save that works twice and fails the third time |

It does **not** find problems that need judgement: a confusing label, an
unhelpful error message, a total that is wrong but still renders. Those are
listed in the lab's ground truth as needing a model, and the benchmark reports
them as misses rather than pretending otherwise.

## What it will not do

- Press anything that looks like paying, deleting, sending, inviting or
  subscribing, or visit a URL that acts on a plain visit (`/logout`, `/delete`)
- Follow the site under test anywhere off its own origin, including a redirect
  the page performs itself
- Reach a private, loopback, link-local or cloud-metadata address, whatever the
  hostname resolves to
- Fill in a form on a site whose owner has not verified it (see below)
- Put anything but obvious synthetic data into a field: `owly.qa+…@example.com`

## Verification

Any site can be scanned passively - Owly looks, but does not click or type. To
allow a full test, prove you control the site by publishing a token Owly derives
from the hostname (ask it on Pond). Any one of these works:

```
/.well-known/owly-verification.txt      containing the token
<meta name="owly-verification" content="owly-…">     on the home page
DNS TXT   owly-verification=owly-…
```

## How it runs

A test is a state machine, not a long-running job. `advance()` does as much
work as fits in a time budget and hands back plain JSON; the next Pond poll
picks it up, possibly on another instance. Nothing is held in memory between
slices, and every work item has a hard time limit, so one hanging page cannot
take the whole run down with it.

```
discover   crawl as a new desktop user, running the chosen checks on each page
personas   revisit the pages as an impatient phone user and a keyboard user
verify     replay every unit that raised a candidate, in a fresh browser
done       cluster duplicates, redact, write the report
```

**Nothing is reported unless it reproduced.** Anything seen once and not again
is kept out of the findings and listed separately as unverified.

## Layout

```
src/policy/     what Owly may reach, press and say (url guard, action guard, redaction, ownership)
src/browser/    the guarded session; page scripts live in inpage.ts as plain JS strings
src/engine/     probes (one per kind of check), the resumable machine, clustering
src/report/     the Pond summary, the GitHub issue, the HTML report page
src/api/        the Pond protocol: manifest, runs, tasks
lab/            deliberately broken apps, the ground truth, and the scorer
tools/          conformance.ts - drives a live deployment the way Pond does
```

## Running it

```bash
npm install
npx playwright install chromium

npm test          # 188 tests, including real-browser ones against the lab
npm run bench     # score the engine against the lab
npm run lab       # serve the lab apps to poke at by hand

npx tsx tools/conformance.ts --base https://tryowly.vercel.app --key "$POND_ACCESS_KEY"
```

## The lab

Eight small apps, each on its own port so each is its own origin:

| | |
|---|---|
| A–F | one kind of defect each: a broken signup, confusing onboarding, a broken phone layout, a flaky API, accessibility failures, a synthetic checkout |
| **G** | **nothing wrong.** Any finding here is a false positive, full stop |
| **H** | a page that tries to hijack the tester: hidden instructions, a disguised link, a form that posts elsewhere, and a redirect off-site |

`lab/truth.json` lists all 21 planted defects and says which need a model.
The benchmark fails the build if the control app produces a finding or a safety
rule is broken.

Current score: **19/19** of the defects Owly is built to detect, **100%**
precision, **0** false positives, **0** safety violations.

## Known and deliberate

- **Vercel prints `error TS2688: Cannot find type definition file for 'node'`**
  on every deploy. Its per-function compiler cannot resolve the `types` entry
  in `tsconfig.json`; removing the entry breaks local type checking instead
  (TypeScript 7 does not add `@types` automatically). The build succeeds and
  the functions run.
- **The lab cannot reproduce every production bug.** Headless Chromium renders
  a JSON URL differently than it did on the site where that bug was found, so
  the guard against testing non-HTML has a direct test in
  `tests/offsite.browser.test.ts` rather than a lab case.
