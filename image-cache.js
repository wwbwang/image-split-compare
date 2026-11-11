/* Browser-local image bytes, with bounded memory and persistent disk storage. */
class LocalImageCache {
  constructor({ activeKeys, activeURLs, onStatus, diskLimit = 4 * 1024 ** 3, memoryLimit = 128 * 1024 ** 2 }) {
    this.activeKeys = activeKeys;
    this.activeURLs = activeURLs;
    this.onStatus = onStatus;
    this.diskLimit = diskLimit;
    this.memoryLimit = memoryLimit;
    this.memory = new Map();
    this.retiredURLs = new Set();
    this.pending = new Map();
    this.diskEntries = new Map();
    this.memoryBytes = 0;
    this.diskBytes = 0;
    this.epoch = 0;
    this.queue = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    try {
      if (!window.isSecureContext || !window.caches) throw new Error("unavailable");
      this.disk = await caches.open("image-compare-local-images-v1");
      for (const request of await this.disk.keys()) {
        const response = await this.disk.match(request);
        const size = Number(response?.headers.get("X-Local-Cache-Size"));
        if (!size) { await this.disk.delete(request); continue; }
        this.diskEntries.set(request.url, size);
        this.diskBytes += size;
      }
      await this.trimDisk(0);
      navigator.storage?.persist?.().catch(() => {});
    } catch {
      this.disk = null;
    }
    this.status();
  }

  status() {
    this.onStatus({ persistent: !!this.disk, count: this.disk ? this.diskEntries.size : this.memory.size,
      bytes: this.disk ? this.diskBytes : this.memoryBytes });
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

  async trimDisk(extraBytes, target = this.diskLimit) {
    for (const [key, size] of this.diskEntries) {
      if (this.diskBytes + extraBytes <= target) break;
      await this.disk.delete(key);
      this.diskEntries.delete(key);
      this.diskBytes -= size;
    }
  }

  async get(rawURL) {
    const key = new URL(rawURL, location.href).href;
    const existing = this.memory.get(key);
    if (existing) {
      this.memory.delete(key);
      this.memory.set(key, existing);
      this.trimMemory();
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

  cancelUnused() {
    const active = this.activeKeys();
    for (const [key, job] of this.pending) {
      if (active.has(key)) continue;
      this.pending.delete(key);
      job.controller.abort();
    }
  }

  async load(key, epoch, signal) {
    await this.ready;
    signal.throwIfAborted();
    let blob;
    try {
      const saved = await this.disk?.match(key);
      if (saved) {
        blob = await saved.blob();
        const size = this.diskEntries.get(key);
        this.diskEntries.delete(key);
        this.diskEntries.set(key, size || blob.size);
      } else if (this.diskEntries.has(key)) {
        this.diskBytes -= this.diskEntries.get(key);
        this.diskEntries.delete(key);
      }
    } catch { /* Disk failures must not prevent viewing images. */ }
    signal.throwIfAborted();
    if (!blob) {
      const response = await fetch(key, { cache: "no-store", signal });
      if (!response.ok) throw new Error(`图片加载失败 (${response.status})`);
      blob = await response.blob();
      signal.throwIfAborted();
      if (this.disk && blob.size <= this.diskLimit && epoch === this.epoch) {
        this.queue = this.queue.then(async () => {
          if (epoch !== this.epoch) return;
          await this.trimDisk(blob.size);
          const saved = new Response(blob, { headers: {
            "Content-Type": blob.type || "application/octet-stream",
            "X-Local-Cache-Size": String(blob.size)
          } });
          try { await this.disk.put(key, saved.clone()); }
          catch (error) {
            if (error.name !== "QuotaExceededError") throw error;
            await this.trimDisk(blob.size, Math.min(this.diskLimit, this.diskBytes * 0.7));
            await this.disk.put(key, saved);
          }
          this.diskBytes -= this.diskEntries.get(key) || 0;
          this.diskEntries.delete(key);
          this.diskEntries.set(key, blob.size);
          this.diskBytes += blob.size;
        }).catch(() => {}).finally(() => this.status());
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

  async clear() {
    await this.ready;
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
    this.queue = this.queue.then(async () => {
      for (const request of await this.disk?.keys() || []) await this.disk.delete(request);
      this.diskEntries.clear();
      this.diskBytes = 0;
    }).catch(() => {}).finally(() => this.status());
    await this.queue;
  }
}
