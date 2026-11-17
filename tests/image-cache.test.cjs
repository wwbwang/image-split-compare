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
  browser = await chromium.launch({ headless: true, args: ["--headless=new"],
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
async function setPaneVisible(page, key, visible) {
  if (!await page.locator("#visibilityMenu").evaluate(menu => menu.open)) {
    await page.locator("#visibilityMenu summary").click();
  }
  await page.locator(`#visible${key}`).setChecked(visible);
}
async function clearDirectory(page, key) {
  if (!await page.locator("#clearMenu").evaluate(menu => menu.open)) {
    await page.locator("#clearMenu summary").click();
  }
  await page.locator(`#clear${key}`).click();
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

test("a directory request preempts another tab's transfers and resumes every image afterwards", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const first = await open(context, 100), second = await open(context, 100);
  await get(first, "cached-during-priority");
  await first.evaluate(() => {
    window.results = Promise.all(Array.from({length: 5}, (_, i) => cache.get(`/image/slow-priority-${i}`)));
  });
  await assertEventually(() => delayed.has("/image/slow-priority-2"));
  let releaseMetadata, metadataStarted = false;
  const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
  await second.route("**/directory-priority", async route => {
    metadataStarted = true;
    await metadataGate;
    await route.fulfill({status: 200, body: "directory"});
  });
  await second.evaluate(() => {
    window.metadata = cache.withPriority(() => fetch("/directory-priority", {priority: "high"}).then(response => response.text()));
  });
  await assertEventually(() => metadataStarted);
  assert.equal(await first.evaluate(() => cache.pending.size === 5 &&
    [...cache.pending.values()].every(job => !job.controller.signal.aborted)), true);
  for (let i = 0; i < 5; i++) assert.equal(downloads.get(`/image/slow-priority-${i}`) || 0, i < 3 ? 1 : 0);
  assert.equal(await get(first, "cached-during-priority"), "1234");
  releaseMetadata();
  assert.equal(await second.evaluate(() => metadata), "directory");
  for (let i = 0; i < 5; i++) {
    const name = `/image/slow-priority-${i}`;
    await assertEventually(() => downloads.get(name) === (i < 3 ? 2 : 1) && delayed.has(name) && !delayed.get(name).destroyed);
    delayed.get(name).end("1234");
    delayed.delete(name);
  }
  assert.equal(await first.evaluate(async () => { const result = await results; await cache.queue; return result.length; }), 5);
  assert.equal((await snapshot(first)).state.count, 6);
});

async function startApplication(t, directories = ["A", "B"], count = 11, documents = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "image-compare-queue-test-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
  for (const dir of directories) {
    fs.mkdirSync(path.join(fixture, dir));
    for (let i = 1; i <= count; i++) fs.writeFileSync(path.join(fixture, dir, `${i}.png`), png);
  }
  for (const [name, bytes] of Object.entries(documents)) {
    const file = path.join(fixture, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, bytes);
  }
  const child = spawn(process.env.PYTHON || "python3", ["server.py", "--port", "0", "--image-root", fixture], {
    cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill(); await stopped;
    }
    fs.rmSync(fixture, {recursive: true, force: true});
  });
  return new Promise((resolve, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Application did not start: ${errors}`)), 15000);
    child.stderr.on("data", data => { errors += data; });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Application exited (${code}): ${errors}`)); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
}

test("ten rapid arrow presses cache every visited image and keep the final frame selected", async t => {
  const appURL = await startApplication(t);
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

test("the directory picker pauses transfers, replaces stale browsing, and resumes its queue on close", async t => {
  const appURL = await startApplication(t, ["A", "B"], 6);
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage();
  const mediaGates = [], errors = [];
  let holdMedia = true, mediaRequests = 0, browseRequests = 0, releaseBrowse;
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${appURL}/?a=QQ&b=Qg`);
  await page.waitForFunction(() => imageCache.pending.size === 0 && loaded.imageA && loaded.imageB);
  await page.evaluate(() => imageCache.queue);
  const root = await page.evaluate(() => selected.A.path.slice(0, selected.A.path.lastIndexOf("/")));
  await page.route("**/media/**", async route => {
    mediaRequests++;
    if (holdMedia) await new Promise(resolve => mediaGates.push(resolve));
    await route.continue().catch(() => {});
  });
  const firstBrowse = new Promise(resolve => { releaseBrowse = resolve; });
  await page.route("**/api/browse?**", async route => {
    browseRequests++;
    if (browseRequests === 1) await firstBrowse;
    await route.continue().catch(() => {});
  });
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await assertEventually(() => mediaRequests === 3);
  await page.waitForFunction(() => imageCache.pending.size === 10 && imageCache.downloadQueue.length === 7);
  await page.locator("#chooseA").click();
  await assertEventually(() => browseRequests === 1);
  await page.waitForFunction(() => picker.open && imageCache.pauseDepth > 0 && imageCache.downloading === 0 && imageCache.downloadQueue.length === 10);
  assert.match(await page.locator("#cacheStatus").innerText(), /目录操作优先/);
  assert.equal(await page.evaluate(() => [...imageCache.pending.values()].every(job => !job.controller.signal.aborted)), true);
  await page.locator("#pickerPath").fill(`${root}/B`);
  await page.locator("#jumpPath").click();
  await page.waitForFunction(() => pickerData?.current.path === "B");
  releaseBrowse();
  await page.locator("#parentDirectory").click();
  await page.waitForFunction(() => pickerData?.current.id === "root");
  await page.locator("#refreshDirectories").click();
  await assertEventually(() => browseRequests === 4);
  await page.waitForFunction(() => !document.getElementById("pickerStatus").textContent.includes("正在"));
  assert.equal(mediaRequests, 3, "No picture transfer may restart while the picker is open");
  holdMedia = false;
  for (const release of mediaGates) release();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !picker.open && imageCache.pending.size === 0 && loaded.imageA && loaded.imageB);
  await page.evaluate(() => imageCache.queue);
  assert.equal(await page.evaluate(() => imageCache.diskCount), 12);
  assert.equal(await page.evaluate(() => files[index]), "6.png");
  assert.deepEqual(errors, []);
});

test("top-right PDF picker opens server files without changing image selections", async t => {
  const stream = "BT /F1 18 Tf 20 100 Td (PDF preview test) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let document = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(document);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const appURL = await startApplication(t, ["A", "B"], 1, {
    "papers/论文 2.PDF": document, "papers/论文 10.pdf": document, "papers/notes.txt": "notes"
  });
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${appURL}/?a=QQ&b=Qg`);
  await page.waitForFunction(() => loaded.imageA && loaded.imageB);
  await page.evaluate(() => imageCache.queue);
  const before = await page.evaluate(() => ({url: location.href, selected, count: imageCache.diskCount}));
  const button = await page.locator("#openPdf").boundingBox();
  const toolbar = await page.locator(".toolbar").boundingBox();
  assert(button.x + button.width > 1400 && button.y < toolbar.y);
  await page.locator("#openPdf").click();
  await page.waitForFunction(() => pickerData?.current.id === "QQ" && pickerTarget === "PDF");
  assert.equal(await page.locator("#pickerTitle").innerText(), "打开服务器 PDF");
  await page.locator("#directoryList .picker-status").waitFor();
  assert.equal(await page.evaluate(() => imageCache.pauseDepth > 0), true);
  const root = await page.evaluate(() => pickerData.root);
  await page.locator("#pickerPath").fill(`${root}/papers`);
  await page.locator("#jumpPath").click();
  await page.waitForFunction(() => pickerData?.current.path === "papers");
  assert.deepEqual(await page.locator("#directoryList a").allTextContents(), ["论文 2.PDF ↗", "论文 10.pdf ↗"]);
  const link = page.locator("#directoryList a").first();
  const url = await link.getAttribute("href");
  const response = await context.request.get(`${appURL}${url}`, {headers: {Range: "bytes=0-7"}});
  assert.equal(response.status(), 206);
  assert.equal((await response.body()).toString(), "%PDF-1.4");
  assert.equal(response.headers()["content-type"], "application/pdf");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.match(await link.getAttribute("rel"), /noopener/);
  const popupEvent = context.waitForEvent("page");
  await link.click();
  const popup = await popupEvent;
  await popup.waitForURL(`${appURL}${url}`);
  await popup.close();
  await page.bringToFront();
  await page.locator("#parentDirectory").click();
  await page.waitForFunction(() => pickerData?.current.id === "root");
  await page.getByRole("button", {name: "📁 papers", exact: true}).click();
  await page.waitForFunction(() => pickerData?.current.path === "papers");
  await page.locator("#refreshDirectories").click();
  await page.waitForFunction(() => !document.getElementById("pickerStatus").textContent.includes("正在"));
  await page.locator("#closePicker").click();
  await page.waitForFunction(() => !picker.open && imageCache.pauseDepth === 0);
  assert.deepEqual(await page.evaluate(() => ({url: location.href, selected, count: imageCache.diskCount})), before);
  await page.locator("#openPdf").click();
  await page.waitForFunction(() => pickerData?.current.path === "papers");
  await page.keyboard.press("Escape");
  await page.locator("#chooseA").click();
  await page.waitForFunction(() => pickerTarget === "A" && pickerData?.current.id === "QQ");
  assert.equal(await page.locator("#directoryList a").count(), 0);
  assert.equal(await page.getByRole("button", {name: /^选择当前目录/}).count(), 1);
  assert.deepEqual(errors, []);
});

test("replacing, clearing or hiding a directory cancels only its unfinished downloads", async t => {
  const appURL = await startApplication(t, ["A", "B", "C", "D", "LQ", "GT", "New"], 6);
  for (const [action, directory] of [["hide", "A"], ["hide", "B"], ["hide", "C"], ["hide", "D"], ["replace", "A"], ["replace", "LQ"], ["clear", "GT"]]) {
    await t.test(`${action} ${directory}`, async t => {
      const context = await browser.newContext(); t.after(() => context.close());
      const page = await context.newPage();
      const id = Buffer.from(directory).toString("base64url");
      const requests = [], failures = [], gates = [];
      let hold = true;
      page.on("requestfailed", request => {
        if (new URL(request.url()).pathname.startsWith("/media/")) failures.push(request.url());
      });
      await page.route(`**/media/${id}/**`, async route => {
        const filename = Buffer.from(new URL(route.request().url()).pathname.split("/").pop(), "base64url").toString();
        requests.push(filename);
        if (hold && filename !== "1.png") await new Promise(resolve => gates.push(resolve));
        await route.continue().catch(() => {}); // An aborted fetch can finish before this gate opens.
      });
      const params = new URLSearchParams(["A", "B", "C", "D", "LQ", "GT"].map(key => [key.toLowerCase(), Buffer.from(key).toString("base64url")]));
      await page.goto(`${appURL}/?${params}`);
      await page.waitForFunction(() => index === 0 && imageCache.diskCount === 6 && imageCache.pending.size === 0);
      const savedKey = await page.evaluate(id => [...imageCache.memory.keys()].find(key => new URL(key).pathname.startsWith(`/media/${id}/`)), id);
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
      await page.waitForFunction(id => [...imageCache.pending.values()].filter(job => job.directoryId === id).length === 5 &&
        imageCache.downloadQueue.filter(job => new URL(job.key).pathname.startsWith(`/media/${id}/`)).length === 2, id);
      await assertEventually(() => requests.length === 4);
      await page.evaluate(id => { window.cancelledJobs = [...imageCache.pending.values()].filter(job => job.directoryId === id); }, id);
      if (action === "replace") {
        await page.evaluate(key => { pickerTarget = key; selectDirectory(btoa("New").replace(/=/g, ""), "/New"); }, directory);
      } else if (action === "hide") await setPaneVisible(page, directory, false);
      else await clearDirectory(page, directory);
      await page.waitForFunction(id => ![...imageCache.pending.values()].some(job => job.directoryId === id) &&
        !imageCache.downloadQueue.some(job => new URL(job.key).pathname.startsWith(`/media/${id}/`)), id);
      assert.equal(await page.evaluate(() => cancelledJobs.every(job => job.controller.signal.aborted)), true);
      hold = false;
      for (const release of gates) release();
      await assertEventually(() => failures.length >= 3);
      assert(failures.every(url => new URL(url).pathname.startsWith(`/media/${id}/`)), "Other directories must not be cancelled");
      await page.waitForFunction(() => imageCache.pending.size === 0 && visiblePaneKeys().every(key => loaded[images.original[key].id]));
      await page.evaluate(() => imageCache.queue);
      assert.deepEqual(requests, ["1.png", "2.png", "3.png", "4.png"]);
      assert.deepEqual(await page.evaluate(async key => ({
        memory: imageCache.memory.has(key), disk: !!await imageCache.shared.disk.match(key)
      }), savedKey), {memory: true, disk: true});
      // Showing/reselecting the directory loads only the current frame, not cancelled history.
      if (action === "hide") await setPaneVisible(page, directory, true);
      else await page.evaluate(({key, id}) => { pickerTarget = key; selectDirectory(id, `/${key}`); }, {key: directory, id});
      await page.waitForFunction(id => imageCache.pending.size === 0 && [...imageCache.memory.keys()].some(key => {
        const parts = new URL(key).pathname.split("/");
        return parts[2] === id && atob(parts[3]) === "6.png";
      }), id);
      assert.deepEqual(requests, ["1.png", "2.png", "3.png", "4.png", "6.png"]);
    });
  }
});

test("hiding one pane retains downloads still used by another pane or reference", async t => {
  const appURL = await startApplication(t, ["A", "B", "LQ"], 6);
  for (const directory of ["A", "LQ"]) {
    await t.test(`C shares ${directory}`, async t => {
      const context = await browser.newContext(); t.after(() => context.close());
      const page = await context.newPage();
      const id = Buffer.from(directory).toString("base64url");
      const gates = [];
      let hold = true;
      await page.route(`**/media/${id}/**`, async route => {
        const name = Buffer.from(new URL(route.request().url()).pathname.split("/").pop(), "base64url").toString();
        if (hold && name !== "1.png") await new Promise(resolve => gates.push(resolve));
        await route.continue();
      });
      const params = new URLSearchParams({a: "QQ", b: "Qg", c: id, lq: "TFE"});
      await page.goto(`${appURL}/?${params}`);
      await page.waitForFunction(() => imageCache.pending.size === 0 && imageCache.diskCount === 3);
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
      await page.waitForFunction(id => [...imageCache.pending.values()].filter(job => job.directoryId === id).length === 5 &&
        imageCache.downloadQueue.filter(job => new URL(job.key).pathname.startsWith(`/media/${id}/`)).length === 2, id);
      await page.evaluate(id => { window.keptJobs = [...imageCache.pending.values()].filter(job => job.directoryId === id); }, id);
      await setPaneVisible(page, "C", false);
      assert.equal(await page.evaluate(() => keptJobs.every(job => !job.controller.signal.aborted && [...imageCache.pending.values()].includes(job))), true);
      hold = false;
      for (const release of gates) release();
      await page.waitForFunction(() => imageCache.pending.size === 0 && loaded.imageA && loaded.imageB);
      await page.evaluate(() => imageCache.queue);
      assert.equal(await page.evaluate(async id => (await imageCache.shared.disk.keys()).filter(key => new URL(key.url).pathname.startsWith(`/media/${id}/`)).length, id), 6);
    });
  }
});

test("visibility menu supports one or zero panes and restores A/B hiding from the URL", async t => {
  const appURL = await startApplication(t, ["A", "B", "C", "D"], 2);
  for (const mode of ["side", "overlay"]) {
    await t.test(mode, async t => {
      const context = await browser.newContext(); t.after(() => context.close());
      const page = await context.newPage();
      const errors = [], media = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/media/")) media.push(request.url()); });
      await page.goto(`${appURL}/?a=QQ&b=Qg&c=Qw&d=RA`);
      await page.waitForFunction(() => imageCache.pending.size === 0 && paneKeys.every(key => loaded[images.original[key].id]));
      await page.evaluate(() => imageCache.queue);
      const rect = await page.evaluate(() => { const {left, top, width, height} = imageRect("A"); return {left, top, width, height}; });
      await page.mouse.move(rect.left + rect.width * 0.2, rect.top + rect.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(rect.left + rect.width * 0.8, rect.top + rect.height * 0.8);
      await page.mouse.up();
      await page.locator(mode === "side" ? "#modeSide" : "#modeOverlay").click();
      await page.locator(mode === "side" ? "#patchModeSide" : "#patchModeOverlay").click();
      for (const [i, key] of ["A", "B", "C"].entries()) {
        await setPaneVisible(page, key, false);
        const expected = ["A", "B", "C", "D"].slice(i + 1);
        assert.deepEqual(await page.locator("#stage .image-pane:visible").evaluateAll(panes => panes.map(pane => pane.id.slice(4))), expected);
        assert.deepEqual(await page.locator("#patchStage .patch-pane:visible").evaluateAll(panes => panes.map(pane => pane.id.slice(9))), expected);
        assert.equal(await page.locator(`#info${key}`).isVisible(), false);
      }
      assert.equal(await page.locator("#stage .split-lines").isVisible(), false);
      assert.equal(await page.locator("#patchStage .split-lines").isVisible(), false);
      assert.equal(await page.evaluate(() => patchCanvases.D.width > 0), true);
      const pane = await page.locator("#paneD").boundingBox(), stage = await page.locator("#stage").boundingBox();
      assert(Math.abs(pane.width - stage.width) <= 2, "The single remaining pane should fill the stage");
      await setPaneVisible(page, "D", false);
      assert.equal(await page.locator("#stage .image-pane:visible").count(), 0);
      assert.equal(await page.locator("#patchStage .patch-pane:visible").count(), 0);
      assert.match(await page.locator("#emptyHint").innerText(), /所有对比栏已隐藏/);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#visibilityMenu").evaluate(menu => menu.open), false);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => index === 1);
      assert.equal(media.length, 4, "Hidden directories should not download the next frame");
      assert.equal(new URL(page.url()).searchParams.get("hide"), "a,b,c,d");
      await page.reload();
      await page.waitForFunction(() => index === 1 && hiddenPanes.size === 4 && imageCache.diskCount === 4);
      assert.equal(await page.locator("#stage .image-pane:visible").count(), 0);
      assert.equal(media.length, 4);
      await setPaneVisible(page, "D", true);
      await page.waitForFunction(() => loaded.imageD && imageCache.pending.size === 0);
      assert.deepEqual(await page.evaluate(() => visiblePaneKeys()), ["D"]);
      assert.equal(media.length, 5);
      assert.equal(new URL(page.url()).searchParams.get("hide"), "a,b,c");
      assert.deepEqual(errors, []);
    });
  }
});

test("one clear menu removes all six directory choices independently of image cache", async t => {
  const appURL = await startApplication(t, ["A", "B", "C", "D", "LQ", "GT"], 1);
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(`${appURL}/?a=QQ&b=Qg&c=Qw&d=RA&lq=TFE&gt=R1Q`);
  await page.waitForFunction(() => imageCache.pending.size === 0 && paneKeys.every(key => loaded[images.original[key].id]));
  await page.evaluate(() => imageCache.queue);
  await page.keyboard.press("1");
  assert.equal(await page.evaluate(() => paneSources.A), "LQ");
  await clearDirectory(page, "LQ");
  await page.waitForFunction(() => imageCache.pending.size === 0 && loaded.imageA);
  assert.equal(await page.evaluate(() => paneSources.A), "original");
  await setPaneVisible(page, "A", false);
  await page.locator("#clearMenu summary").click();
  assert.equal(await page.locator("#visibilityMenu").evaluate(menu => menu.open), false);
  await page.locator("#clearA").click();
  assert.equal(await page.locator("#visibleA").isDisabled(), true);
  assert.equal(await page.locator("#visibleA").isChecked(), false);
  assert.equal(new URL(page.url()).searchParams.has("a"), false);
  assert.equal(new URL(page.url()).searchParams.has("hide"), false);
  for (const key of ["B", "C", "D", "GT"]) await clearDirectory(page, key);
  assert.equal(await page.evaluate(() => directoryKeys.every(key => !selected[key])), true);
  assert.equal(await page.evaluate(() => imageCache.diskCount), 6);
  await page.locator("#visibilityMenu summary").click();
  for (const key of ["A", "B", "C", "D"]) assert.equal(await page.locator(`#visible${key}`).isDisabled(), true);
  await page.locator("h1").click();
  assert.equal(await page.locator("#visibilityMenu").evaluate(menu => menu.open), false);
  await page.locator("#clearMenu summary").click();
  for (const key of ["A", "B", "C", "D", "LQ", "GT"]) assert.equal(await page.locator(`#clear${key}`).isDisabled(), true);
  await page.locator("#clearImageCache").click();
  await page.waitForFunction(() => imageCache.diskCount === 0 && imageCache.memory.size === 0);
  assert.equal(await page.locator("#clearMenu").evaluate(menu => menu.open), false);
});

async function assertEventually(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for a download");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
