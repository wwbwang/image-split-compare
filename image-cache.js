/* One persistent image budget and LRU index per browser origin, shared by all tabs. */
class SharedImageCache {
  constructor(limit, onStatus) {
    this.limit = limit;
    this.onStatus = onStatus;
    this.name = "image-compare-local-images-v1";
  }

  request(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async initialize() {
    if (!window.isSecureContext || !window.caches || !window.indexedDB || !navigator.locks) {
      throw new Error("浏览器不支持共享磁盘缓存，仅使用内存");
    }
    const opening = indexedDB.open(`${this.name}-index`, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore("state");
      db.createObjectStore("images", { keyPath: "key" }).createIndex("used", "used");
    };
    this.db = await this.request(opening);
    this.db.onversionchange = () => this.db.close();
    this.disk = await caches.open(this.name);
    await this.locked((state) => this.trim(state, 0));
    this.channel = new BroadcastChannel(this.name);
    this.channel.onmessage = ({ data }) => this.onStatus(data);
    navigator.storage?.persist?.().catch(() => {});
  }

  state() {
    return this.request(this.db.transaction("state").objectStore("state").get("total"));
  }

  entry(key) {
    return this.request(this.db.transaction("images").objectStore("images").get(key));
  }

  commit(state, { put = [], remove = [], reset = false } = {}) {
    state.revision = (state.revision || 0) + 1;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["state", "images"], "readwrite");
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("缓存索引写入失败"));
      const images = tx.objectStore("images");
      if (reset) images.clear();
      for (const key of remove) images.delete(key);
      for (const entry of put) images.put(entry);
      tx.objectStore("state").put(state, "total");
    });
  }

  async locked(action) {
    return navigator.locks.request(this.name, async () => {
      let state = await this.state();
      if (!state || state.dirty) state = await this.rebuild(state);
      const result = await action(state);
      this.onStatus(state);
      this.channel?.postMessage(state);
      return result;
    });
  }

  async rebuild(previous) {
    // Scan only on first upgrade or after an interrupted Cache Storage mutation.
    const state = { bytes: 0, count: 0, sequence: previous?.sequence || 0,
      generation: previous?.generation || 0, revision: previous?.revision || 0, dirty: true };
    await this.commit(state);
    const old = await this.request(this.db.transaction("images").objectStore("images").getAll());
    const used = new Map(old.map((entry) => [entry.key, entry.used]));
    const entries = [];
    for (const request of await this.disk.keys()) {
      const response = await this.disk.match(request);
      const size = Number(response?.headers.get("X-Local-Cache-Size"));
      if (!Number.isSafeInteger(size) || size <= 0) {
        await this.disk.delete(request);
        continue;
      }
      entries.push({ key: request.url, size, used: used.get(request.url) ?? ++state.sequence });
      state.bytes += size;
      state.count++;
    }
    state.dirty = false;
    await this.commit(state, { reset: true, put: entries });
    await this.trim(state, 0);
    return state;
  }

  victims(bytes) {
    return new Promise((resolve, reject) => {
      const cursor = this.db.transaction("images").objectStore("images").index("used").openCursor();
      const entries = [];
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result || bytes <= 0) { resolve(entries); return; }
        entries.push(cursor.result.value);
        bytes -= cursor.result.value.size;
        cursor.result.continue();
      };
    });
  }

  async trim(state, extra, target = this.limit) {
    if (state.bytes + extra <= target) return;
    const victims = await this.victims(state.bytes + extra - target);
    state.dirty = true;
    await this.commit(state);
    for (const entry of victims) {
      await this.disk.delete(entry.key);
      state.bytes -= entry.size;
      state.count--;
    }
    state.dirty = false;
    await this.commit(state, { remove: victims.map((entry) => entry.key) });
  }

  async touchEntry(state, entry) {
    entry.used = ++state.sequence;
    await this.commit(state, { put: [entry] });
  }

  touch(key) {
    return this.locked(async (state) => {
      const entry = await this.entry(key);
      if (entry) await this.touchEntry(state, entry);
    });
  }

  read(key) {
    return this.locked(async (state) => {
      const entry = await this.entry(key);
      const response = entry && await this.disk.match(key);
      if (response) await this.touchEntry(state, entry);
      else if (entry) {
        state.bytes -= entry.size;
        state.count--;
        await this.commit(state, { remove: [key] });
      }
      return { response, generation: state.generation };
    });
  }

  write(key, blob, generation) {
    return this.locked(async (state) => {
      if (generation !== state.generation || blob.size > this.limit) return;
      const existing = await this.entry(key);
      if (existing && await this.disk.match(key)) {
        await this.touchEntry(state, existing);
        return;
      }
      if (existing) {
        state.bytes -= existing.size;
        state.count--;
        await this.commit(state, { remove: [key] });
      }
      await this.trim(state, blob.size);
      const save = async () => {
        state.dirty = true;
        await this.commit(state);
        await this.disk.put(key, new Response(blob, { headers: {
          "Content-Type": blob.type || "application/octet-stream",
          "X-Local-Cache-Size": String(blob.size)
        } }));
      };
      try { await save(); }
      catch (error) {
        if (error.name !== "QuotaExceededError") throw error;
        await this.trim(state, blob.size, Math.min(this.limit, state.bytes * 0.7));
        await save();
      }
      state.bytes += blob.size;
      state.count++;
      state.dirty = false;
      await this.commit(state, { put: [{ key, size: blob.size, used: ++state.sequence }] });
    });
  }

  clear() {
    return this.locked(async (state) => {
      state.generation++;
      state.dirty = true;
      await this.commit(state);
      for (const request of await this.disk.keys()) await this.disk.delete(request);
      Object.assign(state, { bytes: 0, count: 0, dirty: false });
      await this.commit(state, { reset: true });
    });
  }
}

/* Per-page blobs for immediate display; disk bytes and eviction are shared. */
class LocalImageCache {
  constructor({ activeKeys, activeURLs, onStatus, diskLimit = 10 * 1024 ** 3, memoryLimit = 128 * 1024 ** 2, downloadLimit = 3 }) {
    this.activeKeys = activeKeys;
    this.activeURLs = activeURLs;
    this.onStatus = onStatus;
    this.memoryLimit = memoryLimit;
    this.memory = new Map();
    this.retiredURLs = new Set();
    this.pending = new Map();
    this.downloadQueue = [];
    this.downloading = 0;
    this.downloadLimit = downloadLimit;
    this.memoryBytes = 0;
    this.diskBytes = 0;
    this.diskCount = 0;
    this.generation = null;
    this.revision = -1;
    this.warning = "";
    this.epoch = 0;
    this.queue = Promise.resolve();
    this.shared = new SharedImageCache(diskLimit, (state) => {
      if (this.generation !== null && state.generation < this.generation) return;
      if (state.generation === this.generation && state.revision < this.revision) return;
      if (this.generation !== null && state.generation !== this.generation) this.clearMemory();
      this.generation = state.generation;
      this.revision = state.revision;
      this.diskBytes = state.bytes;
      this.diskCount = state.count;
      this.status();
    });
    this.ready = this.initialize();
  }

  async initialize() {
    try {
      await this.shared.initialize();
      this.disk = true;
    } catch {
      this.disk = false;
      this.warning = "磁盘缓存不可用，仅使用内存";
    }
    this.status();
  }

  status() {
    this.onStatus({ persistent: !!this.disk, count: this.disk ? this.diskCount : this.memory.size,
      bytes: this.disk ? this.diskBytes : this.memoryBytes, warning: this.warning,
      downloading: this.downloading, queued: this.downloadQueue.length });
  }

  track(operation) {
    const result = operation.catch(() => {
      this.warning = "磁盘缓存操作失败，部分图片可能需要重新下载";
      this.status();
    });
    this.queue = Promise.all([this.queue, result]).then(() => {});
  }

  trimMemory() {
    const visibleURLs = this.activeURLs();
    for (const url of this.retiredURLs) {
      if (visibleURLs.has(url)) continue;
      URL.revokeObjectURL(url);
      this.retiredURLs.delete(url);
    }
    const active = this.activeKeys();
    for (const [key, entry] of this.memory) {
      if (this.memoryBytes <= this.memoryLimit) break;
      if (active.has(key)) continue;
      URL.revokeObjectURL(entry.url);
      this.memory.delete(key);
      this.memoryBytes -= entry.size;
    }
  }

  async get(rawURL) {
    const key = new URL(rawURL, location.href).href;
    const existing = this.memory.get(key);
    if (existing) {
      this.memory.delete(key);
      this.memory.set(key, existing);
      this.trimMemory();
      if (this.disk) this.track(this.shared.touch(key));
      return existing.url;
    }
    this.trimMemory();
    let job = this.pending.get(key);
    if (!job) {
      const controller = new AbortController();
      job = { controller, promise: this.load(key, this.epoch, controller.signal) };
      this.pending.set(key, job);
    }
    try { return await job.promise; }
    finally { if (this.pending.get(key) === job) this.pending.delete(key); }
  }

  download(key, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const job = { key, signal, resolve, reject };
      job.abort = () => {
        this.downloadQueue.splice(this.downloadQueue.indexOf(job), 1);
        reject(signal.reason);
        this.status();
      };
      signal.addEventListener("abort", job.abort, { once: true });
      this.downloadQueue.push(job);
      this.startDownloads();
    });
  }

  startDownloads() {
    while (this.downloading < this.downloadLimit && this.downloadQueue.length) {
      const job = this.downloadQueue.shift();
      job.signal.removeEventListener("abort", job.abort);
      this.downloading++;
      (async () => {
        const response = await fetch(job.key, { cache: "no-store", signal: job.signal });
        if (!response.ok) throw new Error(`图片加载失败 (${response.status})`);
        return response.blob();
      })().then(job.resolve, job.reject).finally(() => {
        this.downloading--;
        this.startDownloads();
      });
    }
    this.status();
  }

  async load(key, epoch, signal) {
    await this.ready;
    signal.throwIfAborted();
    let blob;
    let generation;
    try {
      if (this.disk) {
        const saved = await this.shared.read(key);
        generation = saved.generation;
        if (saved.response) blob = await saved.response.blob();
      }
    } catch {
      this.warning = "磁盘缓存读取失败，正在从服务器加载";
      this.status();
    }
    signal.throwIfAborted();
    if (!blob) {
      blob = await this.download(key, signal);
      signal.throwIfAborted();
      if (this.disk && generation !== undefined && epoch === this.epoch) {
        this.track(this.shared.write(key, blob, generation));
      }
    }
    // A clear action invalidates downloads that were already in progress.
    if (epoch !== this.epoch) throw new Error("缓存已清除，请重新切换图片");
    const url = URL.createObjectURL(blob);
    this.memory.set(key, { url, size: blob.size });
    this.memoryBytes += blob.size;
    this.trimMemory();
    this.status();
    return url;
  }

  clearMemory() {
    ++this.epoch;
    for (const job of this.pending.values()) job.controller.abort();
    this.pending.clear();
    // Keep only the currently displayed blobs until the next navigation.
    const visibleURLs = this.activeURLs();
    for (const entry of this.memory.values()) {
      if (visibleURLs.has(entry.url)) this.retiredURLs.add(entry.url);
      else URL.revokeObjectURL(entry.url);
    }
    this.memory.clear();
    this.memoryBytes = 0;
    this.trimMemory();
  }

  async clear() {
    await this.ready;
    this.clearMemory();
    try {
      if (this.disk) await this.shared.clear();
      this.warning = "";
    } catch {
      this.warning = "磁盘缓存清除失败，请重试";
    }
    this.status();
  }
}
