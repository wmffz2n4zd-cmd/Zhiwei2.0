import { randomUUID } from 'node:crypto';
import { creativeViewerScriptHash } from './creative-render-viewer.js';
import { isPrivateUserId } from './private-identity.js';

const kinds = new Set(['drawing','website','design','model3d']);
const mimeTypes = { png:'image/png', svg:'image/svg+xml', html:'text/html', glb:'model/gltf-binary', json:'application/json' };
const safeName = name => typeof name === 'string' && /^[A-Za-z0-9_-]{1,80}\.(?:png|svg|html|glb|json)$/.test(name);
const singleLine = (value, max) => typeof value === 'string' && value.trim().length && value.length <= max
  && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
const leaseMs = 15 * 60000;
const day = 86400000;
const validContext = value => value === '' || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));

export const creativeSchema = `
  CREATE TABLE IF NOT EXISTS creative_works (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), task_key TEXT NOT NULL,
    scope TEXT NOT NULL, route_version INTEGER NOT NULL, generation INTEGER NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','failed','ready','delivered')),
    token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL, reason TEXT, preview TEXT, downloads TEXT, viewer_hash TEXT,
    context_key TEXT NOT NULL DEFAULT '', brief TEXT NOT NULL DEFAULT '', touched_at INTEGER NOT NULL DEFAULT 0,
    message_id TEXT UNIQUE REFERENCES messages(id), UNIQUE(user_id,task_key));
  CREATE TABLE IF NOT EXISTS creative_files (
    work_id TEXT NOT NULL REFERENCES creative_works(id) ON DELETE CASCADE, name TEXT NOT NULL,
    mime TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(work_id,name));
  CREATE TRIGGER IF NOT EXISTS creative_binding_changed AFTER UPDATE ON bindings
    WHEN NEW.generation<>OLD.generation OR NEW.route_version<>OLD.route_version OR NEW.memory_scope<>OLD.memory_scope
      OR NEW.status<>OLD.status OR NEW.preferred_channel<>OLD.preferred_channel
    BEGIN
      DELETE FROM creative_works WHERE user_id=NEW.user_id AND state<>'delivered';
    END;
`;

function validatedFiles(output, kind, assert) {
  const { files, preview, downloads } = output || {};
  assert(Array.isArray(files) && files.length >= 1 && files.length <= 8 && safeName(preview)
    && Array.isArray(downloads) && downloads.length >= 1 && downloads.length <= files.length
    && downloads.every(safeName) && new Set(downloads).size === downloads.length, 'invalid-work-output');
  const names = new Set();
  let total = 0;
  const normalized = files.map(file => {
    assert(file && safeName(file.name) && !names.has(file.name), 'invalid-work-file');
    names.add(file.name);
    const mime = mimeTypes[file.name.split('.').at(-1)];
    assert(typeof file.mime === 'string' && (file.mime === mime || ((mime === 'text/html' || mime === 'image/svg+xml' || mime === 'application/json')
      && /^;\s*charset=utf-8$/i.test(file.mime.slice(mime.length)) && file.mime.startsWith(mime))),
      'invalid-work-mime');
    assert(Buffer.isBuffer(file.bytes) && file.bytes.length > 0 && file.bytes.length <= 16 * 1024 * 1024, 'invalid-work-size');
    total += file.bytes.length;
    return { ...file, mime };
  });
  assert(total <= 24 * 1024 * 1024 && names.has(preview) && downloads.every(name => names.has(name))
    && names.size === new Set([preview, ...downloads]).size, 'invalid-work-output');
  assert(preview.endsWith(kind === 'drawing' || kind === 'design' ? '.png' : '.html'), 'invalid-work-preview');
  return normalized;
}

// Work bytes, the final receipt, and the chat message share the existing WAL-backed PWA database.
export function createCreativeStorage({ q, transaction, active, stamp, assert, available }) {
  const selected = (userId, taskKey) => q('SELECT * FROM creative_works WHERE user_id=? AND task_key=?').get(userId,taskKey);
  const checkBinding = (userId, scope, routeVersion, generation) => {
    const binding = active(userId);
    assert(binding.preferredChannel === 'pwa' && binding.memoryScope === scope && binding.routeVersion === routeVersion
      && binding.generation === generation, 'creative-task-stale', 409);
  };
  const meta = row => ({ id:row.id, kind:row.kind, title:row.title, preview:row.preview, downloads:JSON.parse(row.downloads) });
  const api = {
    getCreativeTask({ userId, scope, routeVersion, generation, taskKey, contextKey = '' } = {}) {
      if (!available || !singleLine(taskKey,160) || !validContext(contextKey)) return null;
      checkBinding(userId,scope,routeVersion,generation);
      const row = selected(userId,taskKey);
      if (!row || row.scope !== scope || row.route_version !== routeVersion || row.generation !== generation || row.context_key !== contextKey) return null;
      const completed = row.state === 'ready' || row.state === 'delivered';
      return { proposal:{kind:row.kind,title:row.title,brief:row.brief}, status:row.state, leaseUntil:row.lease_until,
        workId:completed ? row.id : null };
    },
    discardCreativeTask({ userId, scope, routeVersion, generation, taskKey, contextKey = '' } = {}) {
      return Boolean(q(`DELETE FROM creative_works WHERE user_id=? AND task_key=? AND scope=? AND route_version=?
        AND generation=? AND context_key=? AND state<>'delivered'`).run(userId,taskKey,scope,routeVersion,generation,contextKey).changes);
    },
    pruneCreativeDrafts() {
      // A projected/processing inbox can still resume after an arbitrarily long offline period.
      // An orphan with no remaining inbox keeps a day for a transient retry, including proactive work.
      return q(`DELETE FROM creative_works WHERE state<>'delivered' AND touched_at<?
        AND NOT EXISTS (SELECT 1 FROM inbox WHERE inbox.user_id=creative_works.user_id
          AND inbox.generation=creative_works.generation AND inbox.route_version=creative_works.route_version
          AND inbox.state IN ('accepted','projected','processing'))`).run(stamp()-day).changes;
    },
    claimCreativeWork({ userId, scope, routeVersion, generation, taskKey, kind, title, brief = '', contextKey = '' } = {}) {
      assert(singleLine(taskKey,160) && kinds.has(kind) && singleLine(title,160) && validContext(contextKey)
        && (brief === '' || singleLine(brief,1600)), 'invalid-creative-task');
      return transaction(() => {
        checkBinding(userId,scope,routeVersion,generation);
        let row = selected(userId,taskKey);
        const now = stamp();
        if (row && (row.context_key !== contextKey || row.scope !== scope || row.route_version !== routeVersion || row.generation !== generation)) {
          assert(row.state !== 'delivered','creative-task-conflict',409);
          q('DELETE FROM creative_works WHERE id=?').run(row.id);
          row = null;
        }
        if (row) {
          assert(row.kind === kind, 'creative-task-conflict', 409);
          if (row.state === 'delivered' || row.state === 'ready') return { status:row.state, workId:row.id };
          if (row.state === 'running' && row.lease_until > now) return { status:'running', leaseUntil:row.lease_until };
        }
        const token = randomUUID();
        if (row) {
          q("UPDATE creative_works SET state='running',token=?,lease_until=?,reason=NULL,attempts=attempts+1,touched_at=? WHERE id=?")
            .run(token,now+leaseMs,now,row.id);
        } else {
          q(`INSERT INTO creative_works(id,user_id,task_key,scope,route_version,generation,kind,title,state,token,lease_until,attempts,brief,context_key,touched_at)
            VALUES(?,?,?,?,?,?,?,?,'running',?,?,1,?,?,?)`).run(randomUUID(),userId,taskKey,scope,routeVersion,generation,kind,title,token,now+leaseMs,brief,contextKey,now);
        }
        return { status:'claimed', token };
      });
    },
    finishCreativeWork({ userId, taskKey, token, output } = {}) {
      return transaction(() => {
        const row = selected(userId,taskKey);
        assert(row?.state === 'running' && row.token === token, 'creative-claim-lost', 409);
        checkBinding(userId,row.scope,row.route_version,row.generation);
        const files = validatedFiles(output,row.kind,assert);
        const insert = q('INSERT INTO creative_files(work_id,name,mime,bytes) VALUES(?,?,?,?)');
        for (const file of files) insert.run(row.id,file.name,file.mime,file.bytes);
        q("UPDATE creative_works SET state='ready',token=NULL,lease_until=NULL,preview=?,downloads=?,viewer_hash=?,touched_at=? WHERE id=?")
          .run(output.preview,JSON.stringify(output.downloads),row.kind === 'model3d' ? creativeViewerScriptHash : null,stamp(),row.id);
        return { workId:row.id };
      });
    },
    failCreativeWork({ userId, taskKey, token, reason } = {}) {
      if (!isPrivateUserId(token)) return false;
      return Boolean(q(`UPDATE creative_works SET state='failed',token=NULL,lease_until=NULL,reason=?,touched_at=?
        WHERE user_id=? AND task_key=? AND state='running' AND token=?`).run(String(reason || 'generation-failed').slice(0,240),stamp(),userId,taskKey,token).changes);
    },
    readCreativeFile(userId, workId, name = null) {
      const binding = active(userId);
      if (!available || !isPrivateUserId(workId) || (name !== null && !safeName(name))) return null;
      const row = q("SELECT * FROM creative_works WHERE id=? AND user_id=? AND scope=? AND state='delivered'")
        .get(workId,userId,binding.memoryScope);
      if (!row || (name !== null && !JSON.parse(row.downloads).includes(name))) return null;
      const file = q('SELECT name,mime,bytes FROM creative_files WHERE work_id=? AND name=?').get(workId,name || row.preview);
      // The executable hash was selected by the server that created the file. Historical
      // viewers keep their own policy across upgrades to the bundled rotation controls.
      const viewerHash = row.kind === 'model3d' && /^'sha256-[a-zA-Z0-9+/]{43}='$/.test(row.viewer_hash) ? row.viewer_hash : null;
      return file ? { ...file, kind:row.kind, viewerHash } : null;
    }
  };
  return {
    api,
    forMessage(userId,messageId) {
      const row = available && q("SELECT w.* FROM creative_works w JOIN bindings b ON w.user_id=b.user_id AND w.scope=b.memory_scope WHERE w.user_id=? AND w.message_id=? AND w.state='delivered'").get(userId,messageId);
      return row ? meta(row) : null;
    },
    forDelivery({ userId, scope, routeVersion, generation, logicalReplyId, workId, contextKey }) {
      const row = isPrivateUserId(workId) && q(`SELECT * FROM creative_works WHERE id=? AND user_id=? AND task_key=?
        AND scope=? AND route_version=? AND generation=? AND context_key=? AND state IN ('ready','delivered')`)
        .get(workId,userId,logicalReplyId,scope,routeVersion,generation,contextKey);
      assert(row,'work-unavailable',404);
      return meta(row);
    },
    attach(workId,messageId) {
      assert(q("UPDATE creative_works SET state='delivered',message_id=? WHERE id=? AND state='ready'").run(messageId,workId).changes === 1,
        'work-already-delivered',409);
    }
  };
}
