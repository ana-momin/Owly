/**
 * What Pond reads to learn what Owly does.
 *
 * Pond's schema shapes three things here, learned on Foxy:
 *   - the manifest must validate exactly, or Pond reports that "the manifest,
 *     runs, and tasks endpoints could not be found" - which is not a routing
 *     problem, however much it sounds like one. A test validates this object
 *     against the vendored schema.
 *   - `billing_interval` is always "month", and `included_units` is a positive
 *     number: there is no yearly plan and no "unlimited".
 *   - `usage_unit` must match what terminal responses report. Owly bills one
 *     "result" per completed test, so a busy report and an empty one cost the
 *     same, and a failed or refused test costs nothing.
 */

import type { InputSchema } from "./params.js";

export const PROTOCOL_VERSION = "1.0";
export const AGENT_VERSION = "2026.09.21";
export const MAX_REQUEST_BYTES = 262_144;

export const FOCUS = ["everything", "forms", "mobile", "accessibility"] as const;

export interface ActionSpec {
  id: string;
  name: string;
  description: string;
  input_schema: InputSchema;
}

export const ACTIONS: ActionSpec[] = [
  {
    id: "start_test",
    name: "Test a website",
    description:
      "Use when the user wants their website or web app tested, checked for bugs, or checked on mobile or for accessibility. " +
      "Owly opens it in a real browser as a new desktop user, a phone user and a keyboard-only user, and reports problems it could reproduce, with steps and evidence. " +
      "Sites whose owner has verified them get a full test that also fills in forms and presses buttons; other sites get a passive scan. " +
      "Takes a few minutes.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full address of the site to test, starting with https://.",
          minLength: 8,
          maxLength: 2000,
        },
        focus: {
          type: "string",
          description:
            "What to concentrate on. 'everything' by default; 'forms' for signup, login and other forms; 'mobile' for phone layout; 'accessibility' for keyboard use and accessibility checks.",
          enum: [...FOCUS],
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    id: "get_report",
    name: "Get a test report",
    description: "Use when the user asks for the results of an earlier Owly test, by its test id.",
    input_schema: {
      type: "object",
      properties: {
        test_id: { type: "string", description: "The test id Owly gave when the test was started.", minLength: 6, maxLength: 64 },
      },
      required: ["test_id"],
      additionalProperties: false,
    },
  },
  {
    id: "verify_site",
    name: "Verify site ownership",
    description:
      "Use when the user wants a full test instead of a passive scan, asks how to verify their site, or says they have added the verification token. " +
      "Returns the token and where to put it, and reports whether the site is already verified.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The address of the site to verify.", minLength: 8, maxLength: 2000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    id: "health_check",
    name: "Check Owly is working",
    description: "Use only when the user asks whether Owly itself is up.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export function manifest(): Record<string, unknown> {
  return {
    protocol: "marketplace-agent",
    protocol_version: PROTOCOL_VERSION,
    agent_version: AGENT_VERSION,
    metadata: {
      name: "Owly",
      logo_url: "https://tryowly.vercel.app/logo.png",
      short_description: "Tests your website like a new user would, in a real browser, and shows proof of every problem it finds.",
      description:
        "<p>Owly opens your site in a real browser and uses it the way people do: as a new desktop user, as an impatient phone user, and with only a keyboard. " +
        "It crawls your pages, fills in forms with obviously fake test data, presses buttons, and watches what breaks.</p>" +
        "<p>Every suspected problem is replayed in a fresh browser before it is reported, so what you get is a short list of issues that actually reproduce, " +
        "each with steps to reproduce, what was expected, what happened, and the evidence: failing requests, console errors, measurements.</p>",
      category: "coding",
      key_features:
        "<ul>" +
        "<li>Finds failing forms, forms that accept invalid input, JavaScript errors, broken links and images, and failing or slow requests</li>" +
        "<li>Checks phone layouts: sideways scrolling, clipped text, overlapping or covered buttons</li>" +
        "<li>Checks keyboard use and runs an automated WCAG 2.1 A/AA scan</li>" +
        "<li>Replays every issue in a fresh browser before reporting it</li>" +
        "<li>Copy any issue straight into GitHub</li>" +
        "</ul>",
      use_cases:
        "<p>Founders and small teams without a QA person who want to know what a new user will hit before they ship, and developers who want a reproducible bug report instead of \"it's broken on my phone\".</p>",
      setup_instructions:
        "Give Owly the address of your site. To let it fill in forms and press buttons, verify that you own the site by adding a token Owly gives you; without that it runs a passive scan.",
      pricing_plans: [
        {
          name: "Free",
          pricing_model: "free",
          amount_minor: 0,
          usage_unit: "result",
          included_units: 5,
          validity_days: 0,
          description: "Five tests a month. Each finished test counts once, however many issues it finds.",
          sort_order: 1,
        },
        {
          name: "Nest",
          pricing_model: "subscription",
          // Minor units: $12.00. The site's pricing page quotes the same
          // number, and the two have to agree - someone reading one and
          // being charged the other is the fastest way to lose them.
          amount_minor: 1200,
          billing_interval: "month",
          usage_unit: "result",
          included_units: 60,
          description: "Sixty tests a month. A test that could not open your site is not a result and is not counted.",
          sort_order: 2,
        },
      ],
      faqs: [
        {
          question: "Is this AI?",
          answer:
            "<p>Not in its checks. Owly runs rule-based checks and scripted user behaviour in a real browser, and every issue it reports comes from something the browser recorded. " +
            "There is a model in the conversation - here, and on Owly's own site - and it is fenced off from the testing: it can explain a report and it can ask for a test to be started, " +
            "but it cannot start one and it is never the source of a finding. Ask about a site it has not tested and it will say it has not tested it, rather than guessing.</p>",
        },
        {
          question: "What is the difference between a full test and a passive scan?",
          answer:
            "<p>A passive scan only looks: pages, layout, links, accessibility, keyboard focus. A full test also fills in forms and presses buttons, which Owly only does on a site whose owner has verified it.</p>",
        },
        {
          question: "Will it buy something, delete data or email people?",
          answer:
            "<p>No. It refuses to press anything that looks like paying, deleting, sending or inviting, never follows your site to other websites, and only ever enters obvious test data such as owly.qa@example.com.</p>",
        },
        {
          question: "How do I know an issue is real?",
          answer:
            "<p>Every issue is replayed in a fresh browser before it is reported, and the report shows how many attempts reproduced it and exactly what the browser saw.</p>",
        },
        {
          question: "What does it not find?",
          answer:
            "<p>Problems that need judgement - a confusing label, an unhelpful error message, a total that is wrong but still displays. It reports what it can prove, and says so.</p>",
        },
      ],
    },
    actions: ACTIONS,
    capabilities: {
      sync: true,
      streaming: false,
      async_tasks: true,
      cancellation: false,
      attachments: false,
      feedback: false,
    },
    input_modes: ["text/plain"],
    output_modes: ["text/markdown"],
    limits: {
      max_request_bytes: MAX_REQUEST_BYTES,
      max_attachment_bytes: 10_485_760,
      max_run_seconds: 600,
    },
  };
}
