import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { buildWorldModelArgs, createWorldModel, parseWorldUsage, worldModelEnvironment } from '../src/world-model.js';

test('reader CLI explicitly disables capabilities and keeps read-only and isolated context flags', () => {
  const args = buildWorldModelArgs({ cwd: 'D:\\isolated', schemaPath: 'D:\\isolated\\schema.json', model: 'gpt-6.1-sol', reasoningEffort: 'low', platform: 'win32' });
  for (const flag of ['--no-daemon', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral', '--output-schema']) assert.ok(args.includes(flag));
  for (const setting of ['features.shell_tool=false', 'features.apps=false', 'features.plugins=false', 'features.memories=false', 'features.multi_agent=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'memories.use_memories=false', 'memories.generate_memories=false', 'mcp_servers={}', 'model_reasoning_effort="low"', 'windows.sandbox="elevated"']) assert.ok(args.includes(setting), setting);
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('features.unified_exec=false'));
});

test('environment excludes inherited secrets, app bridges, API keys and process injection', () => {
  const env = worldModelEnvironment({ PATH: 'bin', CODEX_HOME: 'login-location', USERPROFILE: 'user', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', NODE_OPTIONS: 'injection', CODEX_MCP_TOKEN: 'secret', HTTP_PROXY: 'old' }, 'http://127.0.0.1:7897');
  assert.deepEqual(env, { PATH: 'bin', CODEX_HOME: 'login-location', USERPROFILE: 'user', HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1,::1' });
});

test('usage preserves measured counts and reports missing or malformed usage as unknown', () => {
  assert.deepEqual(parseWorldUsage({ input_tokens: 23, cached_input_tokens: 12, output_tokens: 5 }), { input_tokens: 23, cached_input_tokens: 12, output_tokens: 5 });
  for (const value of [null, {}, { input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 },
    { input_tokens: 2, cached_input_tokens: 3, output_tokens: 1 }]) assert.equal(parseWorldUsage(value), null);
});

async function fixture(t, source) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'world-model-'));
  t.after(async () => { const path = relative(base, directory); assert.ok(path && !path.startsWith('..') && !isAbsolute(path)); await rm(directory, { recursive: true, force: true }); });
  const script = join(directory, 'fake-codex.mjs');
  await writeFile(script, `const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');\n${source}`);
  const modelDir = join(directory, 'model');
  return { directory: modelDir, think: createWorldModel({ directory: modelDir, codexPath: script, timeoutMs: 2500 }) };
}

test('fragmented JSON events produce a JSON response and usage, then remove isolated cwd', async t => {
  const f = await fixture(t, `
const output = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({action:'rest'})}});
process.stdout.write(output.slice(0, 16));
process.stdout.write(output.slice(16) + '\\n');
emit({type:'turn.completed',usage:{input_tokens:13,cached_input_tokens:2,output_tokens:4}});
`);
  const result = await f.think({ prompt: 'Return JSON.' });
  assert.equal(JSON.parse(result.text).action, 'rest');
  assert.deepEqual(result.usage, { input_tokens: 13, cached_input_tokens: 2, output_tokens: 4 });
  assert.deepEqual(await readdir(f.directory), []);
});

test('unexpected tool events immediately terminate and reject instead of accepting later text', async t => {
  const f = await fixture(t, `emit({type:'item.started',item:{type:'command_execution',command:'not executed by fixture'}}); setInterval(()=>{},1000);`);
  await assert.rejects(f.think({ prompt: 'Return JSON.' }), /不允许的工具/);
});

test('the exact disabled-code-mode notice is allowed while other runtime errors fail closed', async t => {
  const harmless = await fixture(t, `emit({type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable \u0060features.code_mode_host\u0060 and install \u0060codex-code-mode-host\u0060.'}}); emit({type:'item.completed',item:{type:'agent_message',text:'{"action":"rest"}'}}); emit({type:'turn.completed'});`);
  assert.equal(JSON.parse((await harmless.think({ prompt: 'Return JSON.' })).text).action, 'rest');
  const failure = await fixture(t, `emit({type:'item.completed',item:{type:'error',message:'different runtime error'}}); setInterval(()=>{},1000);`);
  await assert.rejects(failure.think({ prompt: 'Return JSON.' }), /运行错误/);
});

test('incomplete turns and non-object output are not accepted', async t => {
  const incomplete = await fixture(t, `emit({type:'item.completed',item:{type:'agent_message',text:'{}'}});`);
  await assert.rejects(incomplete.think({ prompt: 'Return JSON.' }), /未正常完成/);
  const array = await fixture(t, `emit({type:'item.completed',item:{type:'agent_message',text:'[]'}}); emit({type:'turn.completed'});`);
  await assert.rejects(array.think({ prompt: 'Return JSON.' }), /JSON对象/);
});

test('invalid model content and nonzero exits retain reported numeric usage for observation', async t => {
  for (const ending of ["emit({type:'item.completed',item:{type:'agent_message',text:'[]'}});", "emit({type:'item.completed',item:{type:'agent_message',text:'{}'}});process.exitCode=7;"]) {
    const f = await fixture(t, ending + "emit({type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:5,output_tokens:3}});");
    await assert.rejects(f.think({ prompt: 'Return JSON.' }), error => {
      assert.deepEqual(error.usage, { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3 }); return true;
    });
  }
});
