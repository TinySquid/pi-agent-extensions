/**
 * OpenCode Go usage — footer status line + usage table for the OpenCode Go plan.
 *
 * opencode.ai publishes no usage API and serves no /api/*. The
 * /workspace/<wrk_…>/go page is a SolidStart app that serializes the resolved
 * values straight into the delivered HTML:
 *
 *   rollingUsage:$R[12]={status:"ok",resetInSec:17400,usagePercent:42}
 *
 * This extension fetches that page with the browser `auth` cookie and reads
 * the percentages + reset times out of the markup. It reports percentages and
 * countdowns only — the page carries no dollar amounts.
 */

export { default } from "./src/extension.ts";
