/**
 * The conversation layer.
 *
 * Owly's findings never come from a language model and never will: they come
 * from a browser that did the thing and recorded what happened. What a model
 * is good at is everything around that - understanding "is signup broken on
 * acme.dev", noticing this is the third run of the same site this week,
 * deciding that testing facebook.com would waste the one thing the person
 * has a limited number of.
 *
 * So the model is given judgement and the means to act on it: memory of what
 * has been tested before, and tools it can call. What it is never given is
 * the ability to invent a result, or to start a run on its own authority -
 * it proposes, and this file's caller applies the same rate limits,
 * ownership checks and URL guards it would to a button press.
 *
 * With no API key configured the whole thing falls back to spotting an
 * address in the text, which is what the page did before any of this. The
 * product works without a model; the model makes it better at knowing what
 * is worth doing.
 */

import { brief, clean, hostOf, type Memory } from "./memory.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatDecision {
  /** What to say back. Empty when the reply is only an action. */
  reply: string;
  /** A site Owly decided to test this turn. */
  test: string | null;
  /** Facts the model asked to keep, for the browser to store. */
  remember: string[];
  /** A site the model was told is the person's own. */
  mine: string | null;
  /** True when a model wrote the reply, so the page can say so. */
  byModel: boolean;
}

export interface Context {
  report: string | null;
  memory: Memory;
  /** Free tests left today, as the server counted them. */
  left: number;
}

/**
 * Providers, in the order they are tried. All speak the OpenAI chat shape,
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

/**
 * Sites almost nobody asking Owly a question owns.
 *
 * This is a hint to the model, not a wall: with memory, "you told me it is
 * mine" beats the list. It stays a hard gate only on the no-model path,
 * where nothing else is capable of the judgement.
 */
const WELL_KNOWN = [
  "google", "youtube", "facebook", "instagram", "whatsapp", "x", "twitter", "tiktok", "linkedin",
  "reddit", "wikipedia", "amazon", "apple", "microsoft", "netflix", "openai", "anthropic", "claude",
  "github", "gitlab", "stackoverflow", "yahoo", "bing", "baidu", "spotify", "twitch", "discord",
  "telegram", "snapchat", "pinterest", "paypal", "stripe", "shopify", "ebay", "zoom", "slack",
  "notion", "figma", "canva", "dropbox", "vercel", "cloudflare", "meta", "xai", "deepseek",
];

function brandOf(site: string): string {
  const host = hostOf(site);
  const parts = host.split(".");
  return parts.length > 2 && parts[parts.length - 2] === "co" ? parts[parts.length - 3]! : parts[0]!;
}

export function wellKnown(site: string): boolean {
  return WELL_KNOWN.includes(brandOf(site));
}

/** The refusal, for the path where there is no model to write one. */
export function notYours(site: string): string | null {
  if (!wellKnown(site)) return null;
  const host = hostOf(site);
  return (
    `That is ${host}, which I am guessing is not yours to change.\n\n` +
    `I could read its pages, but I would only be able to tell you about problems you cannot fix - and it would use one of your free tests to do it. ` +
    `Give me your own site instead and I will open it as a new user would. If you want to watch me work first, try owly-demo-rho.vercel.app, which is broken on purpose.\n\n` +
    `If ${host} really is yours, say so and I will run it.`
  );
}

/** Someone telling Owly the site it declined really is theirs. */
const MINE = /\b(it('?s| is)? ?mine|is mine|i own (it|that)|my (site|domain)|yes,? ?(it('?s| is)? ?mine)?|run it|do it anyway|go ahead)\b/i;

/**
 * "acme.dev is my site" - a claim of ownership naming the site in the same
 * breath. Worth catching without a model, because forgetting it is the
 * difference between Owly knowing someone next visit and not.
 */
export function ownershipClaim(text: string): string | null {
  const site = findSite(text);
  if (!site) return null;
  const owns = /\b(is|are)\s+(my|our|mine)\b|\bmy\s+(site|website|app|domain|product|project)\b|\bi\s+(own|run|built|made)\b|\bwe\s+(own|run|built|made)\b/i;
  return owns.test(text) ? hostOf(site) : null;
}

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

const SYSTEM = [
  "You are Owly, an autonomous QA agent. You test websites by opening them in a real browser as a new user would.",
  "",
  "How you work, so you can explain it accurately:",
  "- You attempt the site's main task (usually signing up), then check pages for broken links, layout problems on a phone, accessibility failures, keyboard traps, failing requests and security problems.",
  "- If the owner has verified the site you also type into forms and press buttons. If not, you only READ the pages - no typing, no pressing. A read-only pass is still real work and still takes a minute or two, so never imply you will do nothing.",
  "- You never report anything you could not reproduce. Every finding was checked again in a fresh browser first.",
  "- You test what is behind a login by signing up as your own synthetic user.",
  "",
  "YOU decide what happens each turn. You have tools:",
  "- start_test: open a site and test it.",
  "- remember: keep a fact worth having next time - which site is theirs, what they are building, what to ignore.",
  "Or simply reply, when talking is the right answer.",
  "",
  "Judgement you are expected to use, rather than rules you follow blindly:",
  "- A test costs the person one of a few free runs a day and takes a minute or two. Spend it on something they can act on.",
  "- A large public site - facebook.com, youtube.com, google.com - is almost certainly not theirs to change, so a report on it would be useless. Say so and offer owly-demo-rho.vercel.app instead. But if your memory says they told you it IS theirs, believe them and test it.",
  "- If you have tested this site before, say what you found last time and offer to check whether it is fixed, instead of silently running it again as though you had never seen it.",
  "- If they have no free tests left, do not start one. Say when it resets.",
  "- If they name a site and ask you to check, test or look at it, and it is not a large public site, just run it. Asking them to confirm what they already said is not caution, it is friction. Ask only when it is genuinely ambiguous whether they want a test at all.",
  "- Starting a test says nothing on its own, and the run narrates itself. But if you have tested that site before, say in one line what you found last time as you start.",
  "- When someone tells you a site is theirs, or what they are building, or anything else you would want on the next visit, call remember. Do it in the SAME turn, alongside start_test if you are also testing.",
  "",
  "Absolute rules you never break:",
  "- NEVER invent, guess at, or embellish a finding. You may only describe results you were actually given. If you have no results for a site, say you have not tested it.",
  '- "Nothing was tested" is never "nothing is wrong", and you say so plainly.',
  "- Your memory records that a run happened and what it found. It is not a licence to describe detail you were not given.",
  "- You are not a general assistant. If asked something unrelated to testing their site, say briefly that this is all you do.",
  "",
  'How you talk: plain words, short. No emoji. No exclamation marks. No headings or bullet lists unless you are listing findings. Never pad with "Great question" or "I would be happy to". You are a competent colleague, not a chatbot.',
].join("\n");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "start_test",
      description:
        "Open a website in a real browser and test it. Costs the person one free test. Only call this when a test is what they want and the site is plausibly theirs to change.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The site to test, for example acme.dev or https://acme.dev/pricing" },
          because: { type: "string", description: "One short clause on why testing this now is the right call." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Keep a durable fact about this person for future turns. Use for ownership of a site, what they are building, or what they want ignored.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The fact, in one short sentence." },
          site_is_theirs: { type: "string", description: "A hostname they have said is theirs, if that is what this is." },
        },
        required: ["fact"],
      },
    },
  },
];

interface Reply {
  text: string | null;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

async function ask(provider: Provider, messages: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<Reply | null> {
  const key = process.env[provider.env];
  if (!key) return null;

  for (const model of provider.models) {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.3, max_tokens: 700 }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      console.log(`chat: ${provider.name}/${model} answered ${res.status}`);
      // A missing model is worth trying the next name for. A bad key or a
      // spent quota is not, and hammering the list would only make it worse.
      if (res.status === 404 || res.status === 400) continue;
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    };
    const message = data.choices?.[0]?.message;
    const calls: Reply["calls"] = [];
    for (const call of message?.tool_calls ?? []) {
      const name = call.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        /* a malformed argument object is the same as none */
      }
      calls.push({ name, args });
    }
    const text = typeof message?.content === "string" ? message.content.trim() : "";
    return { text: text || null, calls };
  }
  return null;
}

/**
 * Work out what this turn means.
 *
 * Everything the model is allowed to know arrives here: the report from the
 * run that just happened, the memory the browser is holding, and how many
 * free tests remain. Nothing else is in scope for it.
 */
export async function decide(history: ChatMessage[], context: Context | string | null): Promise<ChatDecision> {
  // The old signature passed the report text on its own. Still accepted, so
  // a caller that has not been updated keeps working.
  const ctx: Context =
    context && typeof context === "object"
      ? { report: context.report, memory: clean(context.memory), left: context.left }
      : { report: typeof context === "string" ? context : null, memory: clean(null), left: 3 };

  const last = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const provider = activeProvider();
  const nothing: ChatDecision = { reply: "", test: null, remember: [], mine: null, byModel: false };

  if (!provider) return withoutModel(history, last, ctx);

  const messages: Array<Record<string, unknown>> = [{ role: "system", content: SYSTEM }];
  messages.push({ role: "system", content: `What you remember about this person:\n${brief(ctx.memory)}` });
  messages.push({
    role: "system",
    content:
      ctx.left > 0
        ? `They have ${ctx.left} free test${ctx.left === 1 ? "" : "s"} left today.`
        : "They have no free tests left today. Do not start one; the allowance resets at midnight UTC.",
  });
  if (ctx.report) {
    messages.push({
      role: "system",
      content: `The test you just finished produced this. It is the only thing you may describe in detail. Do not add to it.\n\n---\n${ctx.report.slice(0, 12_000)}\n---`,
    });
  }
  for (const m of history.slice(-10)) messages.push({ role: m.role, content: m.content.slice(0, 4000) });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22_000);
  let answer: Reply | null = null;
  try {
    answer = await ask(provider, messages, controller.signal);
  } catch (err) {
    console.log(`chat: ${provider.name} failed: ${String(err).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!answer) return withoutModel(history, last, ctx);

  const out: ChatDecision = { ...nothing, reply: answer.text ?? "", byModel: true };
  for (const call of answer.calls) {
    if (call.name === "start_test" && typeof call.args.url === "string") {
      const url = findSite(call.args.url) ?? call.args.url;
      // The model proposes; the rules still apply. It cannot spend a test the
      // person does not have, and it cannot talk itself past the well-known
      // check unless memory says the person claimed the site.
      if (ctx.left <= 0) continue;
      if (wellKnown(url) && !ctx.memory.mine.includes(hostOf(url))) continue;
      out.test = url;
    }
    if (call.name === "remember") {
      if (typeof call.args.fact === "string" && call.args.fact.trim()) out.remember.push(call.args.fact.trim().slice(0, 300));
      if (typeof call.args.site_is_theirs === "string" && call.args.site_is_theirs.trim()) out.mine = hostOf(call.args.site_is_theirs);
    }
  }

  // A tool call with nothing said alongside it is fine for a test, because
  // the run narrates itself. Remembering something silently is not: the
  // generic "paste a web address" that used to come out here was a non
  // sequitur after someone had just told Owly about their product.
  if (!out.reply && !out.test) {
    if (out.mine) out.reply = `Noted - ${out.mine} is yours. Say the word and I will test it.`;
    else if (out.remember.length) out.reply = "Noted, I will remember that.";
    else out.reply = fallback(last, ctx.report);
  }

  // A safety net under the model's memory, not a replacement for it. Models
  // forget to call tools; "acme.dev is my site" is unambiguous enough that
  // Owly should not need one to be told to have noticed.
  if (!out.mine) {
    const claimed = ownershipClaim(last);
    if (claimed) out.mine = claimed;
  }
  return out;
}

/**
 * The same decisions, made by rules, for when there is no model configured.
 * Less clever, never wrong in a way that costs someone a test.
 */
function withoutModel(history: ChatMessage[], last: string, ctx: Context): ChatDecision {
  const base: ChatDecision = { reply: "", test: null, remember: [], mine: null, byModel: false };
  const site = findSite(last);

  if (site) {
    if (ctx.left <= 0) {
      return { ...base, reply: "That is today's free tests used up. They reset at midnight UTC." };
    }
    if (wellKnown(site) && !ctx.memory.mine.includes(hostOf(site))) {
      return { ...base, reply: notYours(site)! };
    }
    // A report already on screen means a question that names the site is
    // almost certainly ABOUT that report. With no model to tell the
    // difference, the cheap reading is the safe one: never spend a second
    // test to answer what might be a question about the first.
    if (ctx.report) return { ...base, reply: fallback(last, ctx.report) };
    return { ...base, test: site };
  }

  if (MINE.test(last)) {
    const declined = lastDeclined(history);
    if (declined) return { ...base, test: declined, mine: hostOf(declined) };
  }

  return { ...base, reply: fallback(last, ctx.report) };
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
