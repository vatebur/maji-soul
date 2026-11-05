// Separate quotas reserve a decision slot; aborting a request is not server preemption.
export class ModelBroker {
  #decision = 0;
  #live = 0;
  readonly capacity: number;
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('INVALID_CAPACITY');
    this.capacity = capacity;
  }
  async run<T>(purpose: 'decision' | 'live', work: () => Promise<T>): Promise<T> {
    if (purpose === 'live' && this.#live >= this.capacity - 1) throw new Error('LIVE_CAPACITY_RESERVED');
    if (purpose === 'decision' && this.#decision >= 1) throw new Error('DECISION_BUSY');
    if (purpose === 'live') this.#live++; else this.#decision++;
    try { return await work(); }
    finally { if (purpose === 'live') this.#live--; else this.#decision--; }
  }
}
