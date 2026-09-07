// Isolated batch/test producer over the checked WASM ABI. It never resolves an ambient current
// session: only its own successful candidate commit advances this producer's lease.
let epoch = 0;
export function batchModule(wasm) {
  return { ...wasm, Engine: class {
    constructor(threads) {
      this.wasm = wasm;
      this.threads = threads;
      this.owner = new wasm.SessionEngine(threads, `batch-${++epoch}`);
      this.lease = JSON.parse(this.owner.begin_run(JSON.stringify(JSON.parse(this.owner.stamp()).session)));
      this.operation = 0n;
    }
    context() { return JSON.stringify({ session: this.lease.stamp.session, runId: this.lease.runId, operationId: String(++this.operation) }); }
    snapshot() { return JSON.parse(this.owner.snapshot(this.context())); }
    async replace(build) {
      const ticket = this.owner.begin_replacement(this.context(), this.lease.stamp.stateVersion);
      let candidate;
      let consumed = false;
      try {
        candidate = await this.wasm.PreparedEngine.create(ticket, { threads: this.threads, gpu: false });
        await build(candidate);
        candidate.finish();
        consumed = true;
        const snapshot = JSON.parse(this.owner.commit_candidate(candidate));
        this.lease.stamp = snapshot.stamp;
        return snapshot;
      } finally { if (!consumed) { candidate?.free(); this.owner.abandon_replacement(ticket); } }
    }
    async dispatch(json, progress) {
      const command = JSON.parse(json);
      if (command.cmd === 'model.new') {
        const snapshot = await this.replace(candidate => candidate.commands(JSON.stringify([command])));
        return JSON.stringify({ seq: 0, revision: snapshot.model.revision, hash: snapshot.model.hash, warnings: [], output: { type: 'none' } });
      }
      const reply = JSON.parse(await this.owner.dispatch(JSON.stringify({ context: JSON.parse(this.context()), expectedVersion: this.lease.stamp.stateVersion, command }), progress));
      this.lease.stamp = reply.stamp;
      return JSON.stringify(reply.ack);
    }
    query(json) {
      const reply = JSON.parse(this.owner.query(JSON.stringify({ context: JSON.parse(this.context()), query: JSON.parse(json) })));
      this.lease.stamp = reply.stamp;
      return JSON.stringify(reply.value);
    }
    async replay_hashes(json, skip, verify) {
      const snapshot = await this.replace(candidate => candidate.journal(json, skip, verify));
      return JSON.stringify(snapshot.journal.entries.map(entry => entry.hashAfter));
    }
    async import_file(json) { await this.replace(candidate => candidate.file(json)); }
    export_file() { return JSON.stringify(this.snapshot().file); }
    model_hash() { return this.snapshot().model.hash; }
    revision() { return this.snapshot().model.revision; }
    surface() { return this.owner.surface(this.context()); }
    field(step, field, component) {
      const result = JSON.parse(this.query(JSON.stringify({ query: 'query.field', step, field })));
      return Float32Array.from(component === undefined ? result.values : result.values.filter((_, i) => i % result.components === component));
    }
    gpu_self_test(n) { return this.owner.gpu_self_test(this.context(), n); }
    free() { this.owner.free(); }
  } };
}
