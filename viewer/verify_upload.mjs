// Verify an uploaded STEP renders (task-form URL) in a headless browser.
//
// Usage (no hardcoded paths — everything comes from the environment):
//   VERIFY_URL="http://127.0.0.1:3245/?task=<taskId>&file=x.STEP&features=x.特征识别.json" \
//     node verify_upload.mjs
// Optional: VERIFY_LOG (default <repo>/verify_upload.log), VERIFY_SHOT (default <repo>/verify-upload.png).
import { chromium } from "playwright";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = process.env.VERIFY_LOG || path.join(REPO_ROOT, "verify_upload.log");
const SHOT = process.env.VERIFY_SHOT || path.join(REPO_ROOT, "verify-upload.png");
const URL = process.env.VERIFY_URL || "";
const log = (msg) => {
  appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  console.log(msg);
};

if (!URL) {
  log("FATAL: VERIFY_URL is required (task-form URL, e.g. ?task=<taskId>&file=... )");
  process.exit(1);
}

try {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(`console: ${msg.text()}`); });

  log("goto " + URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("canvas", { timeout: 90000 });
  // Wait for the STEP sheet toggle (model loaded) and the feature tree section.
  await page.waitForSelector('button[aria-label^="展开"]', { timeout: 120000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("h3,div,span,button")].some((el) => (el.textContent || "").includes("特征信息树")),
    { timeout: 30000 }
  );
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    const body = document.body.innerText;
    const hasFeaturesSection = body.includes("特征信息树");
    const hasOverview = body.includes("整体信息");
    const hasGeometry = body.includes("几何信息");
    const hasSurface = body.includes("加工面信息");
    const hasContour = body.includes("轮廓信息");
    const hasPart = body.includes("零件");
    const canvas = document.querySelector("canvas");
    return {
      hasFeaturesSection,
      hasOverview,
      hasGeometry,
      hasSurface,
      hasContour,
      hasPart,
      canvas: canvas ? Math.round(canvas.getBoundingClientRect().width) : null,
      bodyHead: body.slice(0, 300).replace(/\n+/g, " | ")
    };
  });
  log("STATE: " + JSON.stringify(state, null, 1));
  log("ERRORS: " + JSON.stringify(errors));
  await page.screenshot({ path: SHOT });
  await browser.close();
  log("done");
} catch (err) {
  log("FATAL: " + (err && err.stack ? err.stack : String(err)));
}
process.exit(0);
