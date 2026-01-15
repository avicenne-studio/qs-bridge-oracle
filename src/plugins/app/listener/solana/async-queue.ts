export class AsyncQueue {
  private pending = Promise.resolve();

  push(task: () => Promise<void>) {
    this.pending = this.pending.then(task).catch(() => {});
    return this.pending;
  }
}
