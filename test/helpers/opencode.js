export function recordingBackend() {
  return {
    calls: [], closes: 0, required: false,
    setRequired(value) { this.required = value; this.calls.push(value); },
    status() { return { error: null, required: this.required, active: this.required }; },
    close() { this.required = false; this.closes += 1; },
  };
}

// push() resolves when the consumer requests the next event, after processing this one.
export function controlledEvents() {
  const queue = [];
  let pending;
  let previous;
  let done = false;
  let failure;
  const closed = Promise.withResolvers();
  function next() {
    previous?.resolve();
    previous = undefined;
    if (queue.length) {
      const item = queue.shift();
      previous = item.ack;
      return Promise.resolve({ value: item.event, done: false });
    }
    if (done) return failure ? Promise.reject(failure) : Promise.resolve({ done: true });
    pending = Promise.withResolvers();
    return pending.promise;
  }
  function finish(error) {
    if (done) return;
    done = true;
    failure = error;
    previous?.resolve();
    queue.splice(0).forEach(({ ack }) => ack.resolve());
    if (pending) {
      if (error) pending.reject(error);
      else pending.resolve({ done: true });
      pending = undefined;
    }
    closed.resolve();
  }
  return {
    closed: closed.promise,
    subscribe({ signal }) {
      signal.addEventListener("abort", () => finish(), { once: true });
      if (signal.aborted) finish();
      return { [Symbol.asyncIterator]() { return { next, return() { finish(); return Promise.resolve({ done: true }); } }; } };
    },
    push(event) {
      if (done) return Promise.resolve();
      const ack = Promise.withResolvers();
      if (pending) {
        previous = ack;
        pending.resolve({ value: event, done: false });
        pending = undefined;
      } else queue.push({ event, ack });
      return ack.promise;
    },
    end() { finish(); },
    fail(error) { finish(error); },
  };
}

export const v2Event = (type, data, location) => ({ type, data, ...(location ? { location } : {}) });
