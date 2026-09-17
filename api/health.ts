// GET /api/health. Routing lives in the shared app; see src/api/production.ts
// for why each path has its own file.
import { handler } from "../src/api/production.js";

export const GET = handler;
