import { spawn } from 'node:child_process';

// Only chat replies may return early. Remote jobs still wait for process exit.
// A final message alone is insufficient: the JSON turn must also complete.
export function runCliProcess({ command, args, cwd, env, input, timeout = 300000,
  earlyReply = false, cleanupMs = 5000, onExit = () => {}, onSpawn = () => {}, signal, abortGraceMs = 1000 }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = '', stderr = '', lineBuffer = '', replyText = '', settled = false, turnFailed = false, closed = false, stderrTail = '';
    let cleanupTimer, abortTimer, aborting = false;
    let reportedUsage = null, usageMissing = false;
    const cliTiming = { replyReadyMs: null, processExitMs: null, exitTailMs: null, retries: 0, httpFallbacks: 0 };
    const result = () => ({ stdout, stderr, replyText, cliTiming, usage: usageMissing ? null : reportedUsage });
    const superseded = () => Object.assign(new Error('Reply generation superseded by newer input'), result(),
      { name: 'AbortError', code: 'REPLY_SUPERSEDED' });
    // Do not launch an already obsolete attempt. No process exists to report
    // through onExit; the caller's rejected-start path releases its reservation.
    if (signal?.aborted) { reject(superseded()); return; }
    // Launchers can have descendants even without an AbortSignal. Give every
    // POSIX attempt its own group for bounded timeout and tail cleanup.
    const ownProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, windowsHide: true,
      detached: ownProcessGroup, stdio: ['pipe', 'pipe', 'pipe'] });
    const killAttempt = kind => {
      if (ownProcessGroup && Number.isInteger(child.pid) && child.pid > 0) {
        try { process.kill(-child.pid, kind); }
        catch (error) {
          if (error.code !== 'ESRCH') {
            stderr = (stderr + `\nProcess-group termination failed (${error.code || 'unknown'}); trying the child.`).slice(-8000);
            try { child.kill(kind); } catch { /* Keep ownership until the actual close event. */ }
          }
        }
      } else { try { child.kill(kind); } catch { /* A failed signal must not escape a timer callback. */ } }
    };
    const terminateAttempt = () => {
      killAttempt('SIGTERM');
      const grace = Number.isFinite(abortGraceMs) ? Math.max(0, Math.min(5000, abortGraceMs)) : 1000;
      abortTimer = setTimeout(() => { if (!closed) killAttempt('SIGKILL'); }, grace);
    };
    const removeAbortListener = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      if (settled || closed || aborting) return;
      aborting = true; clearTimeout(timer); removeAbortListener();
      // Keep the promise pending until the old process actually closes, so a
      // replacement does not overlap it. Escalate only this attempt if needed.
      terminateAttempt();
    };
    const succeedEarly = () => {
      if (settled || closed || aborting || turnFailed || !earlyReply || !replyText.trim()) return;
      settled = true; clearTimeout(timer); removeAbortListener();
      cliTiming.replyReadyMs = Date.now() - startedAt;
      // The turn has completed, so only CLI shutdown/telemetry remains.
      cleanupTimer = setTimeout(terminateAttempt, cleanupMs);
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
      settled = true; removeAbortListener();
      terminateAttempt();
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
      clearTimeout(timer); clearTimeout(cleanupTimer); removeAbortListener();
      // An abort is settled at close, including a kill error, instead of being
      // mislabeled as a model failure or releasing a still-running process.
      if (aborting) return;
      clearTimeout(abortTimer);
      if (!settled) { settled = true; reject(error); }
    });
    child.on('close', code => {
      closed = true;
      // A launcher can exit after closing its own pipes while descendants still
      // exist, even after a successful exit. Reap only this dedicated group
      // before onExit releases temporary output ownership.
      if (ownProcessGroup) killAttempt('SIGKILL');
      if (lineBuffer.trim()) parseLine(lineBuffer);
      clearTimeout(timer); clearTimeout(cleanupTimer); clearTimeout(abortTimer); removeAbortListener();
      cliTiming.processExitMs = Date.now() - startedAt;
      cliTiming.exitTailMs = cliTiming.replyReadyMs == null ? null : Math.max(0, cliTiming.processExitMs - cliTiming.replyReadyMs);
      try { onExit({ ...cliTiming, code }); } catch { /* Diagnostics must not break delivery. */ }
      if (settled) return;
      settled = true;
      if (aborting) reject(superseded());
      else if (code === 0 && !turnFailed) resolve(result());
      else {
        const error = new Error(`Codex CLI exited ${code}`);
        Object.assign(error, result(), { code }); reject(error);
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    // Close the race between the first check and installing the listener.
    if (signal?.aborted) abort();
    child.stdin.on('error', () => {});
    if (Number.isInteger(child.pid) && child.pid > 0) {
      try { onSpawn(); } catch { /* Observer callbacks cannot orphan a child. */ }
    }
    child.stdin.end(aborting ? '' : input);
  });
}
