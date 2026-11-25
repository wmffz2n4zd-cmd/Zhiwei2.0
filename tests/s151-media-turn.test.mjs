import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWriterPrompt } from '../src/private-reply-context.js';
import { describePwaImageTurn, restorePwaBusyInput, selectPwaImageTurn } from '../src/pwa-image-turn.js';

function fixture() {
  let at = 500000;
  const rows = [];
  const identities = new Map(['a','b'].map(userId => [userId, { userId, memoryScope: 'own:' + userId,
    enabled: true, bindingStatus: 'active', routeVersion: 1 }]));
  const store = {
    getIdentity: user => identities.get(user),
    getOwnMessage: (user, id) => rows.find(row => row.user === user && row.id === id),
    getImageInbox: (user, id) => rows.find(row => row.user === user && row.id === id && row.direction === 'inbound'),
    recentImageInbox: (user, before, since) => rows.filter(row => row.user === user &&
      row.direction === 'inbound' && row.seq < before && row.createdAt >= since).reverse()
  };
  function send(mediaIds = [], text = '', options = {}) {
    const user = options.user || 'a', identity = identities.get(user), scope = identity.memoryScope;
    const context = { contactToken: { scope, epoch: options.epoch ?? 0, stop: Boolean(options.stop) },
      memoryEpochToken: { scope, epoch: options.memory ?? 'initial' } };
    const seq = rows.length + 1;
    const row = { seq, id: 'm' + seq, createdAt: at++, mediaIds, text, context, user, direction: 'inbound',
      routeVersion: identity.routeVersion, state: 'complete', ...options };
    rows.push(row); return row;
  }
  function select(inputs, text) {
    const current = inputs.at(-1);
    return selectPwaImageTurn(store, {channel:'pwa', privateIdentity: identities.get(current.user),
      memoryEpochToken: current.context.memoryEpochToken, lifeContactToken: current.context.contactToken,
      images: [], raw: { message_id: current.id, batched_message_ids: inputs.map(row => 'pwa:' + row.id) }}, text ?? current.text);
  }
  return { send, select, advance: n => { at += n; }, store, identities };
}
const images = turn => turn.selected.map(item => item.id);

test('current multi-select and rebuilt busy batch preserve attachment and persisted receipt order', () => {
  const f = fixture(), a = f.send(['A','B','C','D']), b = f.send(['E']);
  assert.deepEqual(images(f.select([a])), ['A','B','C','D']);
  const busy = f.select([b,a], '第1与第5张');
  assert.deepEqual(images(busy), ['A','E']);
  assert.deepEqual(busy.selected.map(item => [item.messageId,item.sourceIndex]), [[a.id,1],[b.id,1]]);
});

test('old quoted media precedes the current upload; repeated IDs have one ordinal', () => {
  const f = fixture(), a = f.send(['A','B'], '', { direction: 'outbound' });
  const b = f.send(['B','C'],'比较引用和新图',{ replyTo: a.id });
  const turn = f.select([b]);
  assert.deepEqual(images(turn), ['A','B','C']);
  assert.deepEqual(turn.selected.map(item => item.kind), ['quoted','quoted','current']);
  assert.match(describePwaImageTurn(turn,[turn.selected[0],turn.selected[2]],[turn.selected[1]]), /附件2=第3张（本轮消息中的第2张）/);
  assert.match(describePwaImageTurn(turn,[],turn.selected), /第1、2、3张原件不可读/);
});

test('two separate completed image messages survive a text-only comparison and an interleaved account', () => {
  const f = fixture(), a = f.send(['A']), other = f.send(['foreign'], '', {user:'b'}), b = f.send(['B']);
  a.context.imageCursor = f.select([a]).cursor;
  b.context.imageCursor = f.select([b]).cursor;
  const question = f.send([], '刚才两张图片有什么不同？');
  assert.deepEqual(images(f.select([question])), ['A','B']);
  assert.deepEqual(images(f.select([other,question])), ['A','B']);
  assert.deepEqual(images(f.select([f.send([], '看图', {user:'b',replyTo:a.id})])), []);
});

test('a deictic pair selects the latest two and does not carry an older photo set into its follow-up', () => {
  const f = fixture(), old = f.send(['old1','old2','old3']), fresh = f.send(['A','B']);
  old.context.imageCursor = f.select([old]).cursor;
  fresh.context.imageCursor = f.select([fresh]).cursor;
  const q = f.send([], '这两张有什么不同？'), turn = f.select([q]);
  assert.equal(turn.total, 2); assert.deepEqual(images(turn), ['A','B']);
  q.context.imageCursor = JSON.parse(JSON.stringify(turn.cursor));
  assert.deepEqual(images(f.select([f.send([], '第一张呢？')])), ['A']);
});

test('a new pair has precedence even when concrete earlier images are still recent', () => {
  const f = fixture();
  f.send(['old']);
  assert.deepEqual(images(f.select([f.send(['B','A'],'比较这两张')])), ['B','A']);
});

test('text about libraries, cartography or prices does not attach private photos', () => {
  for (const text of ['图书馆几点开门？','地图学课上讲了什么？','比较一下价格','这两种方案有什么区别？','图片社的营业时间呢？','写个图像分类算法']) {
    const f = fixture(); f.send(['A','B']);
    assert.deepEqual(images(f.select([f.send([],text)])), [], text);
  }
});

test('receipt epochs, old routes, commands, unrelated intervening topics and expired groups stop reuse', () => {
  for (const change of [{epoch:1},{memory:'reset'}]) {
    const f = fixture(); f.send(['A']);
    assert.deepEqual(images(f.select([f.send([],'看图',change)])),[]);
  }
  for (const options of [{stop:true}, {state:'cancelled'}, {routeVersion:0}]) {
    const f = fixture(); const a=f.send(['A'],'',options);
    assert.deepEqual(images(f.select([a])),[]);
    assert.deepEqual(images(f.select([f.send([],'看图')])),[]);
  }
  for (const barrier of ['今晚吃什么？','/command']) {
    const f=fixture(); f.send(['A']); f.send([],barrier);
    assert.deepEqual(images(f.select([f.send([],'看图')])),[]);
  }
  const f=fixture(); f.send(['A']); f.advance(90000);
  const q=f.send([],'看看图'); q.context.imageCursor=f.select([q]).cursor;
  f.advance(40000);
  assert.deepEqual(images(f.select([f.send([],'第一张呢')])),[]);
});

test('explicitly introducing the fifth upload retains its pixels, including when older photos expired', () => {
  const f=fixture(); f.send(['A','B','C','D']);
  const intro=f.select([f.send(['E'],'这是第五张')]);
  assert.deepEqual(images(intro),['E']); assert.equal(intro.selected[0].ordinal,5);
  f.advance(150000);
  const late=f.select([f.send(['F'],'这是第六张')]);
  assert.deepEqual(images(late),['F']);
});

test('merged overflow pages, explicit cross-page selection and the serializable published cursor', () => {
  const f=fixture(), a=f.send(['A','B','C','D']), b=f.send(['E','F']);
  const first=f.select([a,b],'这些图片中有什么？');
  assert.equal(first.total,6); assert.deepEqual(images(first),['A','B','C','D']);
  assert.match(describePwaImageTurn(first,first.selected,[]), /这组共6张.*附件4=第4张/s);
  b.context.imageCursor=JSON.parse(JSON.stringify(first.cursor));
  const q=f.send([],'下一批'), second=f.select([q]); assert.deepEqual(images(second),['E','F']);
  q.context.imageCursor=JSON.parse(JSON.stringify(second.cursor));
  const compare=f.send([],'比较第一张与第五张'); const pair=f.select([compare]);
  assert.deepEqual(images(pair),['A','E']);
  compare.context.imageCursor=pair.cursor;
  const next=f.send([],'下一批'), rest=f.select([next]); assert.deepEqual(images(rest),['B','C','D','F']);
  next.context.imageCursor=rest.cursor;
  const end=f.select([f.send([],'下一批')]); assert.equal(end.total,6); assert.deepEqual(images(end),[]);
});

test('an all-images request starts a fresh page after an explicit fifth upload', () => {
  const f=fixture(); f.send(['A','B','C','D']);
  const intro=f.send(['E'],'这是第五张'); intro.context.imageCursor=f.select([intro]).cursor;
  const compare=f.send([],'把刚才发的所有图片按顺序比较一下'), first=f.select([compare]);
  assert.deepEqual(images(first),['A','B','C','D']); compare.context.imageCursor=first.cursor;
  assert.deepEqual(images(f.select([f.send([],'继续看下一批')])), ['E']);
});

test('a later comparison in a recomputed batch takes precedence over an earlier ordinal caption', () => {
  const f=fixture(), a=f.send(['A','B','C','D']), b=f.send(['E'],'这是第五张'), q=f.send([],'比较所有图片');
  assert.deepEqual(images(f.select([a,b,q],'这是第五张\n比较所有图片')),['A','B','C','D']);
});

test('writer sees user attachment order and frame timestamps when its planner selected no video evidence', () => {
  const f = fixture(), turn = f.select([f.send(['A','B'])]);
  const current = describePwaImageTurn(turn,turn.selected,[],{frames:[{timestamp:1},{timestamp:7}]});
  const prompt = buildWriterPrompt({ current, plan:{utterance:{goal:'比较',points:['比较内容'],requiredLiterals:[],evidenceRefs:[]}}, evidence:[] });
  assert.match(prompt,/附件2=第2张/);
  assert.match(prompt,/前2张是用户图片，其后2张依次为视频1秒、7秒的实际帧/);
});

test('busy recovery restores long original questions, attachment order and a text-only legacy fallback', () => {
  const f=fixture(), a=f.send(['A','B','C','D'],'这些图稍后一起看'), b=f.send(['E'],'嗯'.repeat(900)+'请比较第一张与第五张');
  const snapshot={channel:'pwa',privateIdentity:f.identities.get('a'),lifeContactToken:b.context.contactToken,
    memoryEpochToken:b.context.memoryEpochToken,text:'[图片未查看]\n嗯',images:[],raw:{batched_message_ids:[a.id,b.id]}};
  const restored=restorePwaBusyInput([a,b],snapshot);
  assert.equal(restored.text,a.text+'\n'+b.text);
  assert.equal(restored.raw.raw_message,restored.text);
  assert.deepEqual(restored.images.map(i=>i.file),['A','B','C','D','E']);
  assert.deepEqual(images(selectPwaImageTurn(f.store,restored,restored.text)),['A','E']);
  const ordinary=f.send([],'今天吃饭了吗？'.repeat(160));
  assert.equal(restorePwaBusyInput([ordinary],snapshot),snapshot);
  const legacy=restorePwaBusyInput([],{...snapshot,raw:{batched_message_ids:['unavailable']}});
  assert.equal(legacy.text,snapshot.text); assert.deepEqual(legacy.images,[]);
});
test('writer retains missing legacy quote provenance while the current attachment remains readable', () => {
  const f=fixture(), turn=f.select([f.send(['B'])]);
  const text=describePwaImageTurn(turn,turn.selected,[],{quotes:[{source:'qq',mediaMissing:true}],referenceUnavailable:true});
  assert.match(text,/旧 QQ.*原图未留存/); assert.match(text,/被引原消息无法核实/);
  assert.match(text,/本次能定位的图片共1张/); assert.match(text,/本轮消息中的第1张/);
});

test('first and last photo both retain their group numbers in an ordinary or overflowing comparison', () => {
  for (const order of [['A','B'],['B','A'],['A','B','C','D','E']]) {
    const f=fixture();
    f.send(order.slice(0,4)); if(order.length>4) f.send(order.slice(4));
    const result=f.select([f.send([],'第一张和最后一张有什么不同？')]);
    assert.deepEqual(result.selected.map(item=>[item.id,item.ordinal]),[[order[0],1],[order.at(-1),order.length]]);
  }
});

test('ordinal plus new or quoted image preserves both comparison operands, while single-image requests stay exact', () => {
  const f=fixture(), old=f.send(['A','B','C','D']);
  const q=f.send(['E'],'第一张和这张新图比有什么不同？',{replyTo:old.id});
  const result=f.select([q]);
  assert.deepEqual(result.selected.map(item=>[item.id,item.ordinal,item.kind]),[['A',1,'quoted'],['E',5,'current']]);
  assert.deepEqual(images(f.select([q],'比较引用的那张图与第5张')),['A','E']);
  assert.deepEqual(images(f.select([q],'只看第1张')),['A']);
  assert.deepEqual(images(f.select([q],'对比首张和末张')),['A','E']);
});

test('full PWA comparison asks for both the quote and the upload in either order', () => {
  const question='被引用的图片排在前面，新附的图片排在后面。请比较刚才的图片。按图片原本的先后顺序读出每张卡片上的两位数，再算第一个数减最后一个数。用阿拉伯数字，依次只写卡片上的数和有正负号的计算结果，用逗号隔开。';
  for(const order of [['A','B'],['B','A']]) {
    const f=fixture(), old=f.send([order[0]]), q=f.send([order[1]],question,{replyTo:old.id});
    assert.deepEqual(images(f.select([q])),order);
    assert.deepEqual(images(f.select([q],'只看第1张')),order.slice(0,1));
  }
});
test('full PWA request to group five images starts from the first four, then only the fifth', () => {
  const question='请把之前的图片和这张放在同一组比较。请分别回答本次实看的起止序号，以及我前后发给你的整组一共有多少张（含本批没有显示的图）。用一句话填写「本次实看第N到M张，整组含未显示的一共有T张，本批卡片上的数是A、B……，本批首数减尾数=R」。填阿拉伯数字。只有一张也写起止序号。';
  const f=fixture(); f.send(['A','B','C','D']);
  const fifth=f.send(['E'],question), first=f.select([fifth]);
  assert.deepEqual(images(first),['A','B','C','D']); assert.equal(first.total,5);
  fifth.context.imageCursor=first.cursor;
  const next=f.send([],'继续下一批。请用刚才的同一句话格式，说出本次实看的起止序号、含前面批次在内的整组张数、此批卡片上的数和此批的首数减尾数。');
  const last=f.select([next]); assert.deepEqual(images(last),['E']); assert.equal(last.total,5);
});
