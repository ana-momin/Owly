/**
 * The conversation layer.
 *
 * Owly's findings never come from a language model and never will: they come
 * from a browser that did the thing and recorded what happened. What a model
 * is good at is the part around that - understanding "can you check if signup
 * is broken on acme.dev", explaining a finding in plainer words, answering
 * "what does lost write mean". So that is all it does here.
 *
 * Two hard rules, enforced in the prompt and by what this file passes in:
 *
 *   1. The model is never given the power to invent a finding. It only ever
 *      sees the report Owly already produced, and is told to refuse to go
 *      beyond it. If no run has happened, it has nothing to describe.
 *   2. The model cannot start a test on its own authority. It emits an
 *      intent; the server applies the same rate limits, ownership checks and
 *      URL guards to it as it would to a button press.
 *
 * With no API key configured the whole thing degrades to a plain URL
 * detector, which is exactly what the page did before. The product works
 * without a model; the model only makes it nicer to talk to.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatDecision {
  /** What to say back. Empty when the reply is only an action. */
  reply: string;
  /** A site the visitor asked Owly to test, if the turn asked for one. */
  test: string | null;
  /** True when a model wrote the reply, so the page can say so. */
  byModel: boolean;
}

/**
 * Providers, in the order they are tried. Both speak the OpenAI chat shape,
 * so one client covers them. Groq and Gemini both have a free tier that does
 * not need a card, which is the whole reason they are the defaults.
 */
interface Provider {
  name: string;
  env: string;
  url: string;
  /**
   * In preference order. Hosted free tiers retire models without warning -
   * the llama-3.3 this was written against was gone within weeks, and the
   * only symptom was a 404 and Owly quietly answering like it had no model at
   * all. A second name means that is a wobble rather than an outage.
   */
  models: string[];
}

const PROVIDERS: Provider[] = [
  {
    name: "groq",
    env: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "groq/compound"],
  },
  { name: "cerebras", env: "CEREBRAS_API_KEY", url: "https://api.cerebras.ai/v1/chat/completions", models: ["gpt-oss-120b", "llama-3.3-70b"] },
  {
    name: "gemini",
    env: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    models: ["gemini-2.0-flash", "gemini-1.5-flash"],
  },
];

export function activeProvider(env: NodeJS.ProcessEnv = process.env): Provider | null {
  for (const p of PROVIDERS) {
    const key = env[p.env];
    if (key && key.trim()) return p;
  }
  return null;
}

/**
 * Something that looks like a website address, said in the middle of an
 * ordinary sentence. Deliberately conservative: a false match here starts a
 * real browser on someone's server.
 */
const SITE = /\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(\/[^\s,;)]*)?/i;

/** Words that are domains but never what someone means by "test my site". */
const NOT_A_SITE = /^(e\.g|i\.e|etc|vs|a\.m|p\.m|node\.js|next\.js|vue\.js)$/i;

export function findSite(text: string): string | null {
  const m = SITE.exec(text);
  if (!m || !m[1]) return null;
  const host = m[1];
  if (NOT_A_SITE.test(host.replace(/\.$/, ""))) return null;
  // A bare word with a common file extension is a filename, not a host.
  if (/\.(js|ts|md|json|css|html|png|jpg|txt|py|go|rs|java|rb|php|yml|yaml|sh)$/i.test(host)) return null;
  return host + (m[2] ?? "");
}

const SYSTEM = `You are Owly, an autonomous QA agent. You test websites by opening them in a real browser as a new user would.

How you work, so you can explain it accurately:
- You attempt the site's main task (usually signing up), then check pages for broken links, layout problems on a phone, accessibility failures, keyboard traps, failing requests and security problems.
- If the owner has verified the site, you also type into forms and press buttons. If not, you only look - no typing, no pressing. You always say which it was.
- You never report anything you could not reproduce. Every finding was checked again in a fresh browser first.
- You test what is behind a login by signing up as your own synthetic user.

Absolute rules you never break:
- NEVER invent, guess at, or embellish a finding. You may only describe results you were given in this conversation. If you were not given results, say the test has not run yet.
- NEVER claim a site is fine if no test ran. "Nothing was tested" is not "nothing is wrong", and you say so plainly.
- You cannot start a test yourself. If the person wants one, ask them to confirm the address and it will be started for you.
- You are not a general assistant. If asked something unrelated to testing their site, say briefly that this is all you do.

How you talk: plain words, short. No emoji. No exclamation marks. Do not use headings or bullet lists unless you are listing findings. Never pad with "Great question" or "I'd be happy to". You are a competent colleague, not a chatbot.`;

async function ask(provider: Provider, messages: Array<{ role: string; content: string }>, signal?: AbortSignal): Promise<string | null> {
  const key = process.env[provider.env];
  if (!key) return null;

  for (const model of provider.models) {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 700 }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      console.log(`chat: ${provider.name}/${model} answered ${res.status}`);
      // A missing model is worth trying the next name for. A bad key or a
      // spent quota is not, and hammering the list would only make it worse.
      if (res.status === 404 || res.status === 400) continue;
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) return text.trim();
    return null;
  }
  return null;
}

/**
 * Work out what this turn means.
 *
 * `report` is the text of the run that has already happened, when there is
 * one. It is the ONLY source the model is allowed to describe.
 */
export async function decide(history: ChatMessage[], report: string | null): Promise<ChatDecision> {
  const last = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const site = findSite(last);
  const provider = activeProvider();

  // Asking for a site to be tested is unambiguous enough to act on without a
  // model, and doing so keeps the common path fast and free.
  if (site) {
    const refusal = notYours(site);
    if (refusal) return { reply: refusal, test: null, byModel: false };
  }

  // "It is mine" after Owly declined a well-known site. The refusal is a
  // guess about ownership, and a guess has to be correctable by the person
  // who actually knows - otherwise it is just a wall.
  if (!site && MINE.test(last)) {
    const declined = lastDeclined(history);
    if (declined) return { reply: "", test: declined, byModel: false };
  }

  if (site && !report) {
    return { reply: "", test: site, byModel: false };
  }

  if (!provider) {
    return { reply: fallback(last, report), test: null, byModel: false };
  }

  const messages: Array<{ role: string; content: string }> = [{ role: "system", content: SYSTEM }];
  if (report) {
    messages.push({
      role: "system",
      content: `This is the result of the test you just ran. It is the only thing you may describe. Do not add to it.\n\n---\n${report.slice(0, 12_000)}\n---`,
    });
  } else {
    messages.push({ role: "system", content: "No test has run in this conversation yet. You have no results to describe." });
  }
  for (const m of history.slice(-10)) messages.push({ role: m.role, content: m.content.slice(0, 4000) });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const text = await ask(provider, messages, controller.signal);
    if (text) return { reply: text, test: null, byModel: true };
  } catch (err) {
    console.log(`chat: ${provider.name} failed: ${String(err).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
  return { reply: fallback(last, report), test: null, byModel: false };
}

/**
 * Sites nobody asking Owly a question owns.
 *
 * Someone typed facebook.com and Owly spent a minute reading it and handed
 * back a report - and the report was useless, because you cannot fix
 * Facebook's keyboard focus. Worse, it cost one of that visitor's three free
 * tests to learn nothing. An agent worth the name knows the difference
 * between a site you are asking about and a site you can act on.
 *
 * Deliberately a short list of the obvious ones rather than a clever guess.
 * A wrong refusal is much more annoying than a wrong run: someone whose own
 * product happens to be small and unknown must never be told it is not
 * theirs. So this only ever names companies where the answer is not in doubt.
 */
const NOT_YOURS = [
  "google", "youtube", "facebook", "instagram", "whatsapp", "x", "twitter", "tiktok", "linkedin",
  "reddit", "wikipedia", "amazon", "apple", "microsoft", "netflix", "openai", "anthropic", "claude",
  "github", "gitlab", "stackoverflow", "yahoo", "bing", "baidu", "spotify", "twitch", "discord",
  "telegram", "snapchat", "pinterest", "paypal", "stripe", "shopify", "ebay", "zoom", "slack",
  "notion", "figma", "canva", "dropbox", "vercel", "cloudflare", "meta", "xai", "deepseek",
];

/** The registrable-ish name: "www.facebook.com/x" -> "facebook". */
function brandOf(site: string): string {
  const host = site.replace(/^https?:\/\//i, "").split("/")[0]!.split(":")[0]!.toLowerCase();
  const parts = host.replace(/^www\./, "").split(".");
  // For "x.ai" that is "x"; for "google.co.uk" it is still "google".
  return parts.length > 2 && parts[parts.length - 2] === "co" ? parts[parts.length - 3]! : parts[0]!;
}

export function notYours(site: string): string | null {
  const brand = brandOf(site);
  if (!NOT_YOURS.includes(brand)) return null;
  const host = site.replace(/^https?:\/\//i, "").split("/")[0]!;
  return (
    `That is ${host}, which I am guessing is not yours to change.\n\n` +
    `I could read its pages, but I would only be able to tell you about problems you cannot fix - and it would use one of your free tests to do it. ` +
    `Give me your own site instead and I will open it as a new user would. If you want to watch me work first, try owly-demo-rho.vercel.app, which is broken on purpose.\n\n` +
    `If ${host} really is yours, say so and I will run it.`
  );
}

/** Someone telling Owly the site it declined really is theirs. */
const MINE = /\b(it('?s| is)? ?mine|is mine|i own (it|that)|my (site|domain)|yes,? ?(it('?s| is)? ?mine)?|run it|do it anyway|go ahead)\b/i;

/** The site named in the last refusal, so an owner can overrule it. */
function lastDeclined(history: ChatMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "assistant") continue;
    const said = /^That is ([^,]+), which I am guessing is not yours/.exec(m.content);
    if (said) return said[1]!.trim();
  }
  return null;
}

/** What Owly says when there is no model, or the model did not answer. */
function fallback(last: string, report: string | null): string {
  if (/^(hi|hey|hello|yo|sup)\b/i.test(last.trim())) {
    return "Give me a web address and I will open it in a real browser and tell you what breaks.";
  }
  if (/what|how|why|explain|mean/i.test(last) && report) {
    return "The report above is everything I recorded. Open the full report for the screenshots and the exact requests behind each line.";
  }
  if (/what|how|why|can you|do you/i.test(last)) {
    return "I test websites. Paste an address and I will open it as a new user would - attempt the main task, check the pages, and report only what I could reproduce.";
  }
  return "Paste a web address and I will take a look.";
}
