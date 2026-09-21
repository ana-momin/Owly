/**
 * What Owly knows, between one question and the next.
 *
 * Until now every turn arrived with no past: the same site could be tested
 * three times in a row and Owly would greet it as a stranger each time, and
 * "did I fix it?" was a question it had no way at all to answer. That is not
 * a model problem - no amount of prompting invents a fact nobody kept.
 *
 * So the browser keeps a small record and sends it up with each turn. It
 * lives in the browser on purpose: Owly has no accounts, and inventing a
 * server-side profile keyed on someone's IP address would be both worse
 * privacy and worse identity. The person's own machine holds their own
 * history, and Owly reasons over it.
 *
 * Everything here is pure: no clock, no network, no model. That is what lets
 * the interesting part - deciding what changed between two runs - be tested
 * properly rather than by reading a prompt and hoping.
 */

export interface RememberedFinding {
  severity: string;
  title: string;
  kind?: string;
}

export interface RememberedRun {
  /** Host only: "acme.dev". */
  site: string;
  /** ISO date. */
  at: string;
  mode: string;
  headline: string;
  findings: RememberedFinding[];
}

export interface Memory {
  /** Sites the person told Owly are theirs, or that verified themselves. */
  mine: string[];
  /** Runs this browser has seen, newest first. */
  runs: RememberedRun[];
  /** Anything else worth keeping: "we deploy on Fridays", "ignore the blog". */
  facts: string[];
}

export const EMPTY: Memory = { mine: [], runs: [], facts: [] };

/** Host of a url or bare address, lowercased, without a leading www. */
export function hostOf(value: string): string {
  const raw = value.trim().replace(/^https?:\/\//i, "").split("/")[0]!.split(":")[0]!;
  return raw.replace(/^www\./i, "").toLowerCase();
}

/** Accepts whatever the browser sent and returns something safe to reason over. */
export function clean(input: unknown): Memory {
  const m = (input ?? {}) as Partial<Memory>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  return {
    mine: (Array.isArray(m.mine) ? m.mine : []).map((s) => hostOf(text(s, 300))).filter(Boolean).slice(0, 40),
    facts: (Array.isArray(m.facts) ? m.facts : []).map((s) => text(s, 300)).filter(Boolean).slice(0, 30),
    runs: (Array.isArray(m.runs) ? m.runs : [])
      .slice(0, 40)
      .map((r) => {
        const run = (r ?? {}) as Partial<RememberedRun>;
        return {
          site: hostOf(text(run.site, 300)),
          at: text(run.at, 40),
          mode: text(run.mode, 20) || "passive",
          headline: text(run.headline, 300),
          findings: (Array.isArray(run.findings) ? run.findings : []).slice(0, 30).map((f) => {
            const one = (f ?? {}) as Partial<RememberedFinding>;
            return {
              severity: text(one.severity, 20) || "info",
              title: text(one.title, 300),
              ...(one.kind ? { kind: text(one.kind, 60) } : {}),
            };
          }),
        };
      })
      .filter((r) => r.site),
  };
}

/** The runs Owly has done on one site, newest first. */
export function runsFor(memory: Memory, site: string): RememberedRun[] {
  const host = hostOf(site);
  return memory.runs.filter((r) => r.site === host);
}

export interface Change {
  fixed: RememberedFinding[];
  still: RememberedFinding[];
  fresh: RememberedFinding[];
  since: string;
}

/**
 * What changed since the last time this site was tested.
 *
 * Matched on the title, because that is what a person reads and what they
 * would call "the same bug". Kind and page are already inside the title for
 * everything Owly reports.
 */
export function changeSince(previous: RememberedRun, current: RememberedFinding[]): Change {
  const key = (f: RememberedFinding) => `${f.severity}|${f.title}`.toLowerCase();
  const before = new Map(previous.findings.map((f) => [key(f), f]));
  const now = new Map(current.map((f) => [key(f), f]));

  return {
    fixed: [...before.entries()].filter(([k]) => !now.has(k)).map(([, f]) => f),
    still: [...now.entries()].filter(([k]) => before.has(k)).map(([, f]) => f),
    fresh: [...now.entries()].filter(([k]) => !before.has(k)).map(([, f]) => f),
    since: previous.at,
  };
}

/** One line a person would actually say about that comparison. */
export function changeLine(change: Change): string {
  const bits: string[] = [];
  if (change.fixed.length) bits.push(`${change.fixed.length} fixed`);
  if (change.still.length) bits.push(`${change.still.length} still there`);
  if (change.fresh.length) bits.push(`${change.fresh.length} new`);
  if (!bits.length) return "Nothing found this time, and nothing last time either.";
  return `Since the last run: ${bits.join(", ")}.`;
}

/**
 * Memory as a few lines the model can read.
 *
 * Deliberately compact. A model handed forty full reports starts quoting
 * findings from the wrong site, which is exactly the kind of confident
 * wrongness this whole product exists to avoid.
 */
export function brief(memory: Memory): string {
  const lines: string[] = [];

  if (memory.mine.length) lines.push(`Sites this person has said are theirs: ${memory.mine.join(", ")}.`);
  else lines.push("This person has not yet said which sites are theirs.");

  if (memory.runs.length) {
    const bySite = new Map<string, RememberedRun[]>();
    for (const r of memory.runs) bySite.set(r.site, [...(bySite.get(r.site) ?? []), r]);
    lines.push("Tests done from this browser before now:");
    for (const [site, runs] of [...bySite.entries()].slice(0, 8)) {
      const latest = runs[0]!;
      const counts = latest.findings.length
        ? latest.findings
            .reduce<string[]>((out, f) => {
              const at = out.findIndex((x) => x.endsWith(f.severity));
              if (at >= 0) out[at] = `${Number(out[at]!.split(" ")[0]) + 1} ${f.severity}`;
              else out.push(`1 ${f.severity}`);
              return out;
            }, [])
            .join(", ")
        : "nothing found";
      lines.push(`- ${site}: ${runs.length} run${runs.length === 1 ? "" : "s"}, last on ${latest.at.slice(0, 10)} (${counts})`);
    }
  } else {
    lines.push("No test has been run from this browser before.");
  }

  if (memory.facts.length) lines.push(`Things worth remembering: ${memory.facts.join("; ")}.`);
  return lines.join("\n");
}
