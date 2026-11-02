import { spawn } from 'node:child_process';

// Only chat replies may return early. Remote jobs still wait for process exit.
// A final message alone is insufficient: the JSON turn must also complete.
export function runCliProcess({ command, args, cwd, env, input, timeout = 300000,
  earlyReply = false, cleanupMs = 5000, onExit = () => {} }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', lineBuffer = '', replyText = '', settled = false, turnFailed = false, closed = false, stderrTail = '';
    let cleanupTimer;
    let reportedUsage = null, usageMissing = false;
    const cliTiming = { replyReadyMs: null, processExitMs: null, exitTailMs: null, retries: 0, httpFallbacks: 0 };
    const result = () => ({ stdout, stderr, replyText, cliTiming, usage: usageMissing ? null : reportedUsage });
    const succeedEarly = () => {
      if (settled || closed || turnFailed || !earlyReply || !replyText.trim()) return;
      settled = true; clearTimeout(timer);
      cliTiming.replyReadyMs = Date.now() - startedAt;
      // The turn has completed, so only CLI shutdown/telemetry remains.
      cleanupTimer = setTimeout(() => child.kill(), cleanupMs);
      cleanupTimer.unref();
      resolve(result());
    };
    const parseLine = line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'turn.failed') turnFailed = true;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message'
        && typeof event.item.text === 'string') replyText = event.item.text.slice(-100000);
      if (event.type === 'turn.completed') {
        // Capture at the event boundary, before early replies or stdout-tail
        // truncation can discard it. Missing reports are unknown, never zero.
        const keys = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
        const counts = event.usage;
        if (!counts || !keys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
          || counts.cached_input_tokens > counts.input_tokens) usageMissing = true;
        else {
          const next = Object.fromEntries(keys.map(key => [key, (reportedUsage?.[key] || 0) + counts[key]]));
          if (keys.every(key => Number.isSafeInteger(next[key]))) reportedUsage = next;
          else usageMissing = true;
        }
        succeedEarly();
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; child.kill();
      const error = new Error('Codex CLI timed out while generating a reply');
      Object.assign(error, result(), { code: 'ETIMEDOUT' }); reject(error);
    }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-8000);
      lineBuffer += chunk;
      let end;
      while ((end = lineBuffer.indexOf('\n')) >= 0) {
        parseLine(lineBuffer.slice(0, end)); lineBuffer = lineBuffer.slice(end + 1);
      }
      // Ignore pathological tool-output lines without retaining unbounded memory.
      if (lineBuffer.length > 2 * 1024 * 1024) lineBuffer = '';
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-8000);
      const combined = stderrTail + chunk;
      for (const [field, pattern] of [['retries', /retrying sampling request/gi], ['httpFallbacks', /falling back to HTTP/gi]]) {
        cliTiming[field] += [...combined.matchAll(pattern)].filter(m => m.index + m[0].length > stderrTail.length).length;
      }
      stderrTail = combined.slice(-100);
    });
    child.on('error', error => {
      clearTimeout(timer); clearTimeout(cleanupTimer);
      if (!settled) { settled = true; reject(error); }
    });
    child.on('close', code => {
      closed = true;
      if (lineBuffer.trim()) parseLine(lineBuffer);
      clearTimeout(timer); clearTimeout(cleanupTimer);
      cliTiming.processExitMs = Date.now() - startedAt;
      cliTiming.exitTailMs = cliTiming.replyReadyMs == null ? null : Math.max(0, cliTiming.processExitMs - cliTiming.replyReadyMs);
      try { onExit({ ...cliTiming, code }); } catch { /* Diagnostics must not break delivery. */ }
      if (settled) return;
      settled = true;
      if (code === 0 && !turnFailed) resolve(result());
      else {
        const error = new Error(`Codex CLI exited ${code}`);
        Object.assign(error, result(), { code }); reject(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
