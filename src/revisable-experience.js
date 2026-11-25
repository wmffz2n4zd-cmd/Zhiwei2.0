import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireFileLock, atomicWriteFile } from './file-lock.js';
import { learningFileName } from './private-learning-store.js';

const MAX_BYTES = 65536;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const refsValid = refs => Array.isArray(refs) && refs.length <= 4 && new Set(refs.map(ref => ref.id)).size === refs.length
  && refs.every(ref => plain(ref) && Object.keys(ref).length === 2 && text(ref.id, 160) && /^[a-f0-9]{64}$/.test(ref.fingerprint));
const evidence = { type: 'object', additionalProperties: false, required: ['sourceId', 'quote'],
  properties: { sourceId: { type: 'string' }, quote: { type: 'string' } } };
export const understandingSchema = { type: 'array', items: { type: 'object', additionalProperties: false,
  required: ['statement', 'context', 'tags', 'evidence', 'counterEvidence', 'supersedes'], properties: {
    statement: { type: 'string' }, context: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: evidence }, counterEvidence: { type: 'array', items: evidence },
    supersedes: { type: 'array', items: { type: 'string' } }
  } } };

/** A tentative view is supported by actual feedback, never by repeated model prose. */
export function parseUnderstandingProposals(input, { sources, existing = [], at } = {}) {
  if (!Array.isArray(input) || input.length > 8) throw Error('invalid-understandings');
  const byId = new Map(sources.map(source => [source.id, source])), prior = new Set(existing.map(item => item.id));
  const proof = values => {
    if (!Array.isArray(values) || values.length > 4) throw Error('invalid-understanding-evidence');
    const result = [];
    for (const item of values) {
      const source = byId.get(item?.sourceId);
      if (!plain(item) || Object.keys(item).some(key => !['sourceId', 'quote'].includes(key))
        || !source || source.kind !== 'exchange' || !text(item.quote, 160) || item.quote.trim().length < 2
        || !source.userText?.includes(item.quote)) throw Error('invalid-understanding-evidence');
      result.push({ id: source.id, fingerprint: source.fingerprint });
    }
    return [...new Map(result.map(item => [item.id, item])).values()];
  };
  return input.map(value => {
    if (!plain(value) || Object.keys(value).some(key => !['statement', 'context', 'tags', 'evidence', 'counterEvidence', 'supersedes'].includes(key))
      || !text(value.statement, 200) || !text(value.context, 120) || !Array.isArray(value.tags) || !value.tags.length || value.tags.length > 6
      || value.tags.some(tag => !text(tag, 24)) || !Array.isArray(value.supersedes) || value.supersedes.length > 8
      || value.supersedes.some(id => !prior.has(id))) throw Error('invalid-understandings');
    const sourceRefs = proof(value.evidence), counterSourceRefs = proof(value.counterEvidence);
    if (!sourceRefs.length || sourceRefs.length + counterSourceRefs.length > 4
      || sourceRefs.some(ref => counterSourceRefs.some(counter => ref.id === counter.id))) throw Error('invalid-understanding-evidence');
    const explicit = sourceRefs.some(ref => byId.get(ref.id).feedback);
    if (sourceRefs.length < 2 && !explicit) return null;
    const id = createHash('sha256').update(JSON.stringify([value.statement.trim(), value.context.trim()])).digest('hex').slice(0, 24);
    return { id, statement: value.statement.trim(), context: value.context.trim(), tags: [...new Set(value.tags.map(tag => tag.trim()))],
      sourceRefs, counterSourceRefs, supersedes: [...new Set(value.supersedes)],
      status: counterSourceRefs.length >= sourceRefs.length ? 'withdrawn' : 'active', createdAt: at, updatedAt: at };
  }).filter(Boolean);
}

function validate(state, scope) {
  if (!plain(state) || state.version !== 1 || state.scope !== scope || !text(state.epoch, 160)
    || !Number.isSafeInteger(state.sourceRevision) || state.sourceRevision < 0 || !text(state.personaRevision, 80)
    || !Array.isArray(state.entries) || state.entries.length > 24 || new Set(state.entries.map(item => item.id)).size !== state.entries.length
    || Object.keys(state).some(key => !['version', 'scope', 'epoch', 'sourceRevision', 'personaRevision', 'entries'].includes(key))) throw Error('Invalid revisable experience state');
  for (const entry of state.entries) {
    if (!plain(entry) || !/^[a-f0-9]{24}$/.test(entry.id) || !text(entry.statement, 200) || !text(entry.context, 120)
      || !Array.isArray(entry.tags) || entry.tags.length > 6 || entry.tags.some(tag => !text(tag, 24))
      || !refsValid(entry.sourceRefs) || !entry.sourceRefs.length || !refsValid(entry.counterSourceRefs)
      || !Array.isArray(entry.supersedes) || entry.supersedes.length > 8 || entry.supersedes.some(id => !/^[a-f0-9]{24}$/.test(id))
      || !['active', 'revised', 'withdrawn'].includes(entry.status)
      || ![entry.createdAt, entry.updatedAt].every(time => Number.isSafeInteger(time) && time >= 0)
      || Object.keys(entry).some(key => !['id', 'statement', 'context', 'tags', 'sourceRefs', 'counterSourceRefs', 'supersedes', 'status', 'createdAt', 'updatedAt'].includes(key))) throw Error('Invalid revisable experience');
  }
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) throw Error('Revisable experience state exceeds bound');
  return state;
}

export function createRevisableExperienceStore({ directory, memory, personaPolicy, now = Date.now } = {}) {
  if (!memory?.readLearningSources || !memory?.withLearningSources || !personaPolicy) throw Error('Revisable experiences require source and persona guards');
  const root = join(directory, 'understandings');
  const read = async scope => {
    const path = join(root, learningFileName(scope));
    try {
      const parent = await lstat(root), info = await lstat(path);
      if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw Error('Unsafe understanding file');
      return validate(JSON.parse(await readFile(path, 'utf8')), scope);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const allRefs = entries => [...new Map(entries.flatMap(item => [...item.sourceRefs, ...item.counterSourceRefs]).map(ref => [ref.id, ref])).values()];
  const same = (state, snapshot) => state && state.epoch === snapshot.epoch && state.sourceRevision === snapshot.revision
    && state.personaRevision === personaPolicy.revision;
  return {
    read,
    async listScopes() {
      let files;
      try { const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Unsafe understanding directory'); files = await readdir(root); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const scopes = [];
      for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const info = await lstat(join(root, file));
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw Error('Unsafe understanding file');
        const state = JSON.parse(await readFile(join(root, file), 'utf8'));
        if (learningFileName(state.scope) !== file) throw Error('Understanding scope filename mismatch');
        validate(state, state.scope); scopes.push(state.scope);
      }
      return scopes;
    },
    async invalidate(scope, event) {
      if (!await read(scope)) return;
      const snapshot = await memory.readLearningSnapshot({ scope });
      return memory.withLearningSources({ scope, epoch: snapshot.epoch, revision: snapshot.revision, sourceRefs: [] }, async () => {
        const path = join(root, learningFileName(scope));
        const release = await acquireFileLock(path + '.lock', { label: 'Revisable experience invalidation' });
        try {
          const state = await read(scope);
          if (!state) return;
          const removed = new Set(event.sourceIds || []);
          const entries = event.reason === 'reset' || state.epoch !== snapshot.epoch ? []
            : event.reason === 'source-loss' ? state.entries.filter(item => ![...item.sourceRefs, ...item.counterSourceRefs].some(ref => removed.has(ref.id)))
              : state.entries.map(item => ({ ...item, status: 'withdrawn', updatedAt: now() }));
          const next = validate({ ...state, epoch: snapshot.epoch, sourceRevision: snapshot.revision, entries }, scope);
          release.assertHeld(); await atomicWriteFile(path, JSON.stringify(next));
        } finally { await release(); }
      });
    },
    async active(snapshot) {
      const token = personaPolicy.capture(), state = await read(snapshot.scope);
      if (!same(state, snapshot)) return [];
      const active = state.entries.filter(item => item.status === 'active');
      const checked = await memory.readLearningSources({ scope: snapshot.scope, epoch: snapshot.epoch, revision: snapshot.revision, sourceRefs: allRefs(active) });
      personaPolicy.assertCurrent(token);
      const invalid = new Set(checked.invalidIds || []);
      if (!checked.ok && !invalid.size) return [];
      return active.filter(item => [...item.sourceRefs, ...item.counterSourceRefs].every(ref => !invalid.has(ref.id)));
    },
    async commit(snapshot, proposals, token) {
      personaPolicy.assertCurrent(token);
      const proposedRefs = allRefs(proposals);
      return memory.withLearningSources({ scope: snapshot.scope, epoch: snapshot.epoch, revision: snapshot.revision,
        sequence: snapshot.cursor.sequence, sourceRefs: proposedRefs }, async () => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe understanding directory');
        const path = join(root, learningFileName(snapshot.scope));
        const release = await acquireFileLock(path + '.lock', { label: 'Revisable experience store' });
        try {
          const old = await read(snapshot.scope);
          const entries = same(old, snapshot) ? structuredClone(old.entries) : (old?.entries || []).map(item => ({ ...item, status: 'withdrawn' }));
          for (const proposal of proposals) {
            for (const entry of entries) if (proposal.supersedes.includes(entry.id)) { entry.status = 'revised'; entry.updatedAt = now(); }
            const previous = entries.find(entry => entry.id === proposal.id);
            if (previous) Object.assign(previous, proposal, { createdAt: previous.createdAt });
            else entries.push(proposal);
          }
          const next = validate({ version: 1, scope: snapshot.scope, epoch: snapshot.epoch, sourceRevision: snapshot.revision,
            personaRevision: personaPolicy.revision, entries: entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24) }, snapshot.scope);
          personaPolicy.assertCurrent(token); release.assertHeld();
          await atomicWriteFile(path, JSON.stringify(next));
          return { count: proposals.length };
        } finally { await release(); }
      });
    },
    async formatContext(snapshot, userText) {
      const items = (await this.active(snapshot)).filter(item => item.tags.some(tag => userText.toLocaleLowerCase().includes(tag.toLocaleLowerCase()))).slice(0, 2);
      if (!items.length) return '';
      return '仅当前对象的暂时认识（有实际交流依据，可修订，不是身份或关系许可；反例和当下要求优先）：\n'
        + items.map(item => JSON.stringify({ 认识: item.statement, 情境: item.context, 形成时间: new Date(item.createdAt).toISOString(),
          反例数: item.counterSourceRefs.length, 依据: item.sourceRefs.map(ref => ref.id) })).join('\n');
    }
  };
}
