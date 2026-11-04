// Records the home page's crystal chess game, as it looks on a phone, into docs/demo.webp for the README.
// Usage: npm run demo:record [-- url]   (default http://localhost:8799, so run `npm run dev` first)
// Needs Chrome and img2webp (brew install webp). The page's clock is driven here, so every frame is evenly spaced.
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] || "http://localhost:8799/", url = base + (base.includes("?") ? "&" : "?") + "record";
const FPS = 12, SPEED = 1.3, OUT = "docs/demo.webp", SCALE = 2;
const dir = mkdtempSync(join(tmpdir(), "proofprobe-demo-"));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new" });
try {
  const page = await browser.newPage();
  // A phone-width page, tall enough that the whole game is on screen.
  await page.setViewport({ width: 390, height: 1400, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => {
    let t = 0; const queue = [];
    performance.now = () => t;
    window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
    window.cancelAnimationFrame = () => {};
    window.__step = (ms) => { t += ms; queue.splice(0).forEach((cb) => cb(t)); };
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  // One flat background, so the edge of the fixed glow never shows as a strip in the frame.
  await page.addStyleTag({ content: "#acct{visibility:hidden!important} .moves{pointer-events:none} body::before{display:none!important} html,body{background:#060A12!important} *{transition:none!important}" });
  await page.waitForSelector("#game.ready");
  await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  // The stage description, the board and the turns, edge to edge.
  const clip = await page.$eval("#game", (e) => { const r = e.getBoundingClientRect(); return { x: 0, y: Math.floor(r.top + scrollY) - 14, width: innerWidth, height: Math.ceil(r.height) + 28 }; });
  // One full game: the seven moves plus the pause on checkmate, then it loops.
  const total = (3.8 + 4.4 + 3.8 + 4.4 + 4.2 + 4 + 5.2) * 1000 + 2600; // matches the page: 2.6 s on checkmate before it loops
  const step = (1000 / FPS) * SPEED, frames = Math.ceil(total / step);
  await page.evaluate(() => window.__step(1));
  for (let i = 0; i < frames; i++) {
    await page.evaluate((ms) => window.__step(ms), step);
    await page.screenshot({ path: join(dir, String(i).padStart(4, "0") + ".png"), clip });
  }
  const files = Array.from({ length: frames }, (_, i) => join(dir, String(i).padStart(4, "0") + ".png"));
  // Lossless keeps every pixel exact. Lossy modes leave blotches in the dark squares that build up over frames.
  execFileSync("img2webp", ["-loop", "0", "-lossless", "-q", "75", "-m", "4", "-exact", "-d", String(Math.round(1000 / FPS)), "-o", OUT, ...files], { stdio: "inherit" });
  console.log(`${OUT}: ${frames} frames, ${(statSync(OUT).size / 1048576).toFixed(2)} MB, ${clip.width * SCALE}x${clip.height * SCALE}`);
} finally {
  await browser.close();
  if (process.env.KEEP_FRAMES) console.log("frames kept in " + dir); else rmSync(dir, { recursive: true, force: true });
}
