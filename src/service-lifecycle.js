import { setTimeout as delay } from 'node:timers/promises';

// Stop admission synchronously, then drain accepted work before flushing its final writes.
export function createServiceLifecycle({ stopAccepting, stopBackground, pending, flush,
  timeoutMs = 600000, pollMs = 25, exit = code => process.exit(code), report = message => console.error(message) }) {
  let stopping = false, task;
  return {
    get stopping() { return stopping; },
    stop(reason = 'requested') {
      if (task) return task;
      stopping = true;
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`drain timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      report(`Service stopping (${reason}); draining accepted work`);
      const work = Promise.all([
        Promise.resolve().then(stopAccepting),
        Promise.resolve().then(stopBackground),
        (async () => {
          while (pending() > 0) await delay(pollMs, undefined, { signal: controller.signal });
        })()
      ]).then(flush);
      task = (async () => {
        let code = 0;
        try { await Promise.race([work, deadline]); }
        catch (error) { code = 1; report(`Service shutdown failed: ${error.message}`); }
        finally { clearTimeout(timer); controller.abort(); }
        if (code === 0) report('Service stopped cleanly');
        exit(code);
        return code;
      })();
      return task;
    }
  };
}
