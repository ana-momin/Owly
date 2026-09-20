// POST /api/chat. Routing lives in the shared app; see src/api/production.ts
// for why each path has its own file. This one must stay on the light bundle:
// talking never needs a browser.
import { handler } from "../src/api/production.js";

export const POST = handler;
