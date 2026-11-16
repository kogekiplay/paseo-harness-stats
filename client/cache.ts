import type { Stats } from "../shared/stats";

/** Shared across composer mounts; visible reads take priority over background prefetch. */
export class StatsCache {
  private values = new Map<string, Stats>();
  private inFlight = new Map<string, Promise<Stats>>();
  private queue = new Set<string>();
  private workers = 0;
  private stopped = false;
  constructor(private fetch: (id: string) => Promise<Stats>) {}
  peek(id: string) {
    return this.values.get(id);
  }
  read(id: string): Promise<Stats> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    this.queue.delete(id);
    const result = this.fetch(id)
      .then((stats) => {
        if (!this.stopped) {
          this.values.delete(id);
          this.values.set(id, stats);
          if (this.values.size > 200) this.values.delete(this.values.keys().next().value!);
        }
        return stats;
      })
      .finally(() => {
        this.inFlight.delete(id);
      });
    this.inFlight.set(id, result);
    return result;
  }
  prefetch(id: string) {
    if (this.stopped || this.values.has(id) || this.inFlight.has(id)) return;
    this.queue.add(id);
    this.pump();
  }
  private pump() {
    while (!this.stopped && this.workers < 2 && this.queue.size) {
      const id = this.queue.values().next().value!;
      this.queue.delete(id);
      this.workers++;
      void this.read(id)
        .catch(() => {
          // A foreground read reports failures; prefetch never replaces cached data with an error.
        })
        .finally(() => {
          this.workers--;
          this.pump();
        });
    }
  }
  clear() {
    this.stopped = true;
    this.queue.clear();
    this.values.clear();
  }
}
