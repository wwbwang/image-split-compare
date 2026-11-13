// Run with: node --test tests/image-cache.test.cjs (requires Playwright + Chromium).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

let browser, server, origin;
const downloads = new Map();
const delayed = new Map();
before(async () => {
  const script = fs.readFileSync(path.join(__dirname, "../image-cache.js"));
  server = http.createServer((req, res) => {
    if (req.url === "/image-cache.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(script);
    } else if (req.url.startsWith("/image/")) {
      downloads.set(req.url, (downloads.get(req.url) || 0) + 1);
      if (req.url.includes("slow")) delayed.set(req.url, res);
      else res.end("1234");
    } else res.end('<!doctype html><meta charset="utf-8"><script src="/image-cache.js"></script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
});
after(async () => {
  for (const response of delayed.values()) response.end("1234");
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function initialize(page, diskLimit = 12) {
  await page.evaluate(async limit => {
    window.statuses = [];
    window.cache = new LocalImageCache({ diskLimit: limit, memoryLimit: 100,
      activeKeys: () => new Set(), activeURLs: () => new Set(),
      onStatus: state => statuses.push(state) });
    await cache.ready;
    if (!cache.disk) throw new Error(cache.warning);
  }, diskLimit);
}
async function open(context, diskLimit = 12) {
  const page = await context.newPage();
  await page.goto(origin);
  await initialize(page, diskLimit);
  return page;
}
async function get(page, name) {
  return page.evaluate(async name => {
    const url = await cache.get(`/image/${name}`);
    await cache.queue;
    return fetch(url).then(response => response.text());
  }, name);
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const disk = await caches.open("image-compare-local-images-v1");
    const keys = await disk.keys();
    const sizes = await Promise.all(keys.map(async key => (await (await disk.match(key)).blob()).size));
    const state = await cache.shared.state();
    return { keys: keys.map(key => new URL(key.url).pathname).sort(),
      bytes: sizes.reduce((sum, size) => sum + size, 0), state };
  });
}

test("legacy bytes survive upgrade; reopening uses the index without a cache scan", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage(); await page.goto(origin);
  const previous = downloads.get("/image/legacy") || 0;
  await page.evaluate(async () => {
    const disk = await caches.open("image-compare-local-images-v1");
    await disk.put("/image/legacy", new Response("old!", { headers: { "X-Local-Cache-Size": "4" } }));
  });
  await initialize(page);
  assert.equal(await get(page, "legacy"), "old!");
  await page.reload();
  await page.evaluate(() => { Cache.prototype.keys = () => { throw new Error("unexpected full scan"); }; });
  await initialize(page);
  assert.equal(await get(page, "legacy"), "old!");
  assert.equal(downloads.get("/image/legacy") || 0, previous);
});

test("memory hits update disk LRU, which survives page reload", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await open(context);
  for (const name of ["a", "b", "c", "a"]) assert.equal(await get(page, name), "1234");
  await page.reload(); await initialize(page);
  await get(page, "d");
  const result = await snapshot(page);
  assert.deepEqual(result.keys, ["/image/a", "/image/c", "/image/d"]);
  assert.equal(result.bytes, 12);
  assert.equal(result.state.bytes, 12);
});

test("directories and concurrent tabs share one total budget", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const pages = await Promise.all([open(context, 20), open(context, 20)]);
  await Promise.all(pages.map(page => page.evaluate(() => {
    window.overruns = [];
    const put = Cache.prototype.put;
    Cache.prototype.put = async function(...args) {
      await put.apply(this, args);
      let bytes = 0;
      for (const key of await this.keys()) bytes += (await (await this.match(key)).blob()).size;
      if (bytes > 20) overruns.push(bytes);
    };
  })));
  await Promise.all(pages.map((page, tab) => page.evaluate(async tab => {
    for (let i = 0; i < 16; i++) {
      await cache.get(`/image/directory-${i % 3}/${tab}-${i}`);
      await cache.queue;
    }
  }, tab)));
  const result = await snapshot(pages[0]);
  assert.equal(result.bytes, 20);
  assert.equal(result.state.bytes, result.bytes);
  assert.equal(result.state.count, result.keys.length);
  for (const page of pages) assert.deepEqual(await page.evaluate(() => overruns), []);
  await pages[1].waitForFunction(() => cache.diskBytes === 20 && cache.diskCount === 5);
  await Promise.all(pages.map(page => get(page, "same")));
  const deduplicated = await snapshot(pages[0]);
  assert.equal(deduplicated.state.bytes, deduplicated.bytes);
  assert.equal(deduplicated.state.count, deduplicated.keys.length);
});

test("clear reaches other tabs and older downloads cannot repopulate shared storage", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const first = await open(context), second = await open(context);
  await get(second, "clear-me");
  await first.evaluate(() => cache.clear());
  await second.waitForFunction(() => cache.memory.size === 0 && cache.diskBytes === 0);
  // Disable notifications to exercise the durable generation guard independently.
  await second.evaluate(() => {
    cache.shared.channel.close();
    cache.shared.channel = null;
    window.slowResult = cache.get("/image/slow-clear").then(() => "loaded", () => "cancelled");
  });
  await assertEventually(() => delayed.has("/image/slow-clear"));
  await first.evaluate(() => cache.clear());
  delayed.get("/image/slow-clear").end("1234");
  delayed.delete("/image/slow-clear");
  await second.evaluate(async () => { await slowResult; await cache.queue; });
  const result = await snapshot(first);
  assert.deepEqual(result.keys, []);
  assert.equal(result.state.bytes, 0);
});

test("an interrupted disk mutation rebuilds accounting without losing valid bytes", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await open(context);
  await get(page, "before-crash");
  await page.evaluate(async () => {
    const state = await cache.shared.state();
    state.dirty = true;
    await cache.shared.commit(state);
    await cache.shared.disk.put("/image/interrupted", new Response("kept", {
      headers: { "X-Local-Cache-Size": "4" }
    }));
  });
  await page.reload(); await initialize(page);
  assert.equal(await get(page, "interrupted"), "kept");
  const result = await snapshot(page);
  assert.equal(result.state.bytes, 8);
  assert.equal(result.state.count, 2);
  assert.equal(result.state.dirty, false);
});

test("quota failure keeps images viewable and reports failed persistence", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await open(context);
  await page.evaluate(() => {
    Cache.prototype.put = async () => { throw new DOMException("full", "QuotaExceededError"); };
  });
  assert.equal(await get(page, "quota"), "1234");
  assert.match(await page.evaluate(() => cache.warning), /失败/);
});

test("unsupported shared storage falls back to memory", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  const page = await context.newPage(); await page.goto(origin);
  await page.evaluate(async () => {
    window.cache = new LocalImageCache({activeKeys:()=>new Set(), activeURLs:()=>new Set(), onStatus:()=>{}});
    await cache.ready;
  });
  assert.equal(await page.evaluate(() => cache.disk), false);
  assert.equal(await get(page, "memory-only"), "1234");
});

test("cached images bypass the bounded FIFO queue, and a failed download releases its slot", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await open(context, 100);
  await get(page, "cached-before-queue");
  await page.reload(); await initialize(page, 100);
  await page.evaluate(() => {
    window.results = Promise.allSettled(Array.from({length: 6}, (_, i) => cache.get(`/image/slow-order-${i}`)));
  });
  await page.waitForFunction(() => cache.downloading === 3 && cache.downloadQueue.length === 3);
  await assertEventually(() => delayed.has("/image/slow-order-2"));
  for (let i = 0; i < 3; i++) assert(delayed.has(`/image/slow-order-${i}`));
  for (let i = 3; i < 6; i++) assert(!delayed.has(`/image/slow-order-${i}`));
  assert.equal(await get(page, "cached-before-queue"), "1234");
  delayed.get("/image/slow-order-0").writeHead(500).end("failed");
  delayed.delete("/image/slow-order-0");
  await assertEventually(() => delayed.has("/image/slow-order-3"));
  assert(!delayed.has("/image/slow-order-4"));
  for (let i = 1; i < 6; i++) {
    await assertEventually(() => delayed.has(`/image/slow-order-${i}`));
    delayed.get(`/image/slow-order-${i}`).end("1234");
    delayed.delete(`/image/slow-order-${i}`);
  }
  const result = await page.evaluate(async () => {
    const result = await results;
    await cache.queue;
    return {statuses: result.map(item => item.status), max: Math.max(...statuses.map(item => item.downloading))};
  });
  assert.deepEqual(result.statuses, ["rejected", ...Array(5).fill("fulfilled")]);
  assert.equal(result.max, 3);
});

test("clear cancels both queued and active downloads without starting waiting requests", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await open(context, 100);
  await page.evaluate(() => {
    window.results = Promise.allSettled(Array.from({length: 8}, (_, i) => cache.get(`/image/slow-cancel-${i}`)));
  });
  await page.waitForFunction(() => cache.downloading === 3 && cache.downloadQueue.length === 5);
  await assertEventually(() => delayed.has("/image/slow-cancel-2"));
  await page.evaluate(() => cache.clear());
  const result = await page.evaluate(async () => {
    const result = await results;
    await cache.queue;
    return result.map(item => item.status);
  });
  assert.deepEqual(result, Array(8).fill("rejected"));
  for (let i = 3; i < 8; i++) assert.equal(downloads.get(`/image/slow-cancel-${i}`), undefined);
  for (let i = 0; i < 3; i++) {
    delayed.get(`/image/slow-cancel-${i}`).end("1234");
    delayed.delete(`/image/slow-cancel-${i}`);
  }
  await page.waitForFunction(() => cache.downloading === 0 && cache.downloadQueue.length === 0);
  assert.equal((await snapshot(page)).bytes, 0);
});

test("ten rapid arrow presses cache every visited image and keep the final frame selected", async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "image-compare-queue-test-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
  for (const dir of ["A", "B"]) {
    fs.mkdirSync(path.join(fixture, dir));
    for (let i = 1; i <= 11; i++) fs.writeFileSync(path.join(fixture, dir, `${i}.png`), png);
  }
  const child = spawn(process.env.PYTHON || "python3", ["server.py", "--port", "0", "--image-root", fixture], {
    cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "inherit"]
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill(); await stopped;
    }
    fs.rmSync(fixture, {recursive: true, force: true});
  });
  const appURL = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Application did not start")), 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", data => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage();
  const requests = [], errors = [], gates = [];
  let released = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/media/**", async route => {
    requests.push(route.request().url());
    if (!released) await new Promise(resolve => gates.push(resolve));
    await route.continue();
  });
  await page.goto(`${appURL}/?a=${Buffer.from("A").toString("base64url")}&b=${Buffer.from("B").toString("base64url")}`);
  await page.waitForFunction(() => files.length === 11 && imageCache.downloading === 2);
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  // Revisit pending frames as well: neither their requests nor their queue slots should duplicate.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => index === 10 && imageCache.pending.size === 22 &&
    imageCache.downloading === 3 && imageCache.downloadQueue.length === 19);
  assert.match(await page.locator("#cacheStatus").innerText(), /下载中 3 · 排队中 19/);
  released = true;
  for (const release of gates) release();
  await page.waitForFunction(() => imageCache.pending.size === 0 && loaded.imageA && loaded.imageB);
  await page.evaluate(() => imageCache.queue);
  const result = await page.evaluate(async () => ({
    selected: files[index], count: imageCache.diskCount,
    keys: (await imageCache.shared.disk.keys()).map(key => key.url),
    displayed: ["imageA", "imageB"].map(id => document.getElementById(id).dataset.cacheKey)
  }));
  assert.equal(result.selected, "11.png");
  assert.equal(result.count, 22);
  assert.equal(requests.length, 22);
  assert.equal(new Set(requests).size, 22);
  assert.equal(new Set(result.keys).size, 22);
  for (const url of result.displayed) assert.equal(Buffer.from(new URL(url).pathname.split("/").pop(), "base64url").toString(), "11.png");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => index === 0 && loaded.imageA && loaded.imageB);
  assert.equal(requests.length, 22);
  await page.reload();
  await page.waitForFunction(() => index === 0 && loaded.imageA && loaded.imageB);
  assert.equal(requests.length, 22);
  assert.deepEqual(errors, []);
});

async function assertEventually(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for a download");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
