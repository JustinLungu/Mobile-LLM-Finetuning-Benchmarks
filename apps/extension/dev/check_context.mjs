// Run: node --experimental-vm-modules apps/extension/dev/check_context.mjs
// Exercise the actual service-worker dispatcher without downloading a model.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const spec = JSON.parse(await readFile(new URL('../../spec/wilo_prompt.json', root), 'utf8'));
const storage = { session: {}, local: {} };
let listener;
let generated;
const context = vm.createContext({
  console, URL, URLSearchParams, Date, crypto: globalThis.crypto, setTimeout: () => {},
  chrome: {
    storage: Object.fromEntries(['session', 'local'].map((area) => [area, {
      setAccessLevel() {},
      async get(key) { return structuredClone({ [key]: storage[area][key] }); },
      async set(value) { Object.assign(storage[area], structuredClone(value)); },
    }])),
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      getManifest: () => ({ version: 'test', content_scripts: [{ matches: [], js: [] }] }),
      getContexts: async () => [{}],
      async sendMessage(msg) {
        if (msg.type === 'generate') {
          generated = msg;
          return { ok: true, raw: JSON.stringify({ relation: 'continuation', assessment: 'Finish the video', decision: 'counter_offer', minutes: 15, message: 'I can offer 15 minutes.' }) };
        }
        return {};
      },
    },
    tabs: { onActivated: { addListener() {} } },
  },
});
const modules = new Map();
async function load(name) {
  if (modules.has(name)) return modules.get(name);
  const code = name === 'generated/config.js'
    ? `export const CONFIG = ${JSON.stringify({ rules: spec.rules, memoryHeader: spec.memory_header, defaultModel: 'test', models: [] })};`
    : await readFile(new URL(name, root), 'utf8');
  const mod = new vm.SourceTextModule(code, { context });
  modules.set(name, mod);
  await mod.link((path) => load(path.replace(/^\.\//, '')));
  return mod;
}
const background = await load('background.js');
await background.evaluate();
const videos = modules.get('video-context.js').namespace;
const conversation = modules.get('conversation.js').namespace;
const wilo = modules.get('wilo.js').namespace;
const site = 'www.youtube.com';
const sample = { url: `https://${site}/watch?v=lean&utm_source=test`, title: 'Lean explained', channel: 'Classroom', durationSeconds: 1560, positionSeconds: 600, playbackRate: 1, paused: true };
const sender = { url: sample.url, tab: { id: 1 } };
const send = (type, fields = {}, source = sender) => new Promise((resolve) => {
  assert.equal(listener({ type, site, video: sample, ...fields }, source, resolve), true);
});
await send('start', { intent: 'learn lean', minutes: 10 });
assert.equal(storage.session.sessions[site].videos.length, 1);
await send('video-context');
assert.equal(storage.session.sessions[site].videos.length, 1, 'polling does not inflate count');
await send('video-context', { video: null });
await send('video-context');
assert.equal(storage.session.sessions[site].videos.length, 1, 'temporary missing player/ad does not inflate count');
await send('video-context', { video: { ...sample, url: `https://${site}/watch?v=second`, title: 'Second video' } });
await send('video-context');
assert.equal(storage.session.sessions[site].videos.length, 3, 'revisiting counts a new opening');
await send('video-context', {}, { ...sender, tab: { id: 2 } });
assert.equal(storage.session.sessions[site].videos.length, 4, 'same video in another tab is another opening');
await send('video-context', { video: { url: `https://${site}/`, unavailable: true } });
await send('video-context');
assert.equal(storage.session.sessions[site].videos.length, 5, 'returning from home counts again');
storage.session.model = { state: 'ready' };
const answer = await send('ask', { text: 'I need 15 minutes to finish this video' });
assert.equal(answer.reply.minutes, 10, 'existing policy cap applies');
assert.match(generated.messages.at(-1).content, /Lean explained/);
assert.match(generated.messages.at(-1).content, /remaining: 16.0 minutes/);
assert.match(generated.messages.at(-1).content, /Maximum extension available this turn: 10 minutes/);
assert.match(generated.messages.at(-1).content, /Videos opened this session: 5/);
await send('ask', { text: 'What did you offer?' });
const replay = generated.messages.find((m) => m.role === 'assistant');
assert.equal(JSON.parse(replay.content).minutes, 10, 'replay applied minutes, not raw 15');
assert.match(replay.content, /10 minutes/);
await send('ask', { text: 'Can you read its title?', video: null });
assert.match(generated.messages.at(-1).content, /Current video metadata unavailable/);
assert.equal(videos.cleanVideo({ ...sample, url: 'https://evil.example/watch?v=x' }, site), null);
const live = videos.cleanVideo({ ...sample, durationSeconds: null, live: true }, site);
assert.equal(live.remainingSeconds, null);
assert.equal(live.live, true);
assert.equal(videos.cleanVideo(sample, site).url, `https://${site}/watch?v=lean`);
assert.match(videos.videoText({}, videos.cleanVideo({ ...sample, playbackRate: 2 }, site)), /watching time at current speed: 8.0/);
const turns = Array.from({ length: 15 }, (_, i) => ({ says: i === 0 ? 'The title is Lean explained' : `message ${i}`, raw: null, reply: { decision: 'decline', minutes: 0, message: 'No extra time' } }));
const history = conversation.conversationHistory(turns);
assert.match(history[0].content, /The title is Lean explained/, 'retain details beyond the old 12-turn cutoff, even on fallbacks');
assert.ok(history.some((m) => m.content.includes('message 14')));
const fitted = await conversation.fitConversation([
  { role: 'system', content: 'rules' }, { role: 'user', content: 'old'.repeat(200) },
  { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'latest' },
], async (s) => s.length, 200);
assert.equal(fitted.length, 2);
assert.equal(fitted.at(-1).content, 'latest');
assert.equal(wilo.maxExtension({ agreedMin: 10, extensions: 1 }), 5);
console.log('PASS: video openings, navigation, tabs, metadata, prompt grounding, applied history, older user details, and context budget');

// Exercise the actual page reader with fixture DOM nodes.
const content = await readFile(new URL('content.js', root), 'utf8');
const reader = content.slice(content.indexOf('  let videoNavigating'), content.indexOf('  const send ='));
let ad = false;
const heading = { textContent: 'Lean explained' };
const player = { paused: true, duration: 1560, currentTime: 600, playbackRate: 1,
  getBoundingClientRect: () => ({ width: 640, height: 360, top: 20, bottom: 380 }) };
const page = vm.createContext({
  site, location: { href: sample.url, pathname: '/watch' }, innerHeight: 900,
  document: { addEventListener() {}, querySelectorAll: () => [player],
    querySelector(selector) {
      if (selector.includes('ad-showing')) return ad;
      return selector.includes('h1') ? heading : { textContent: 'Classroom' };
    } },
});
vm.runInContext(reader, page);
const observed = vm.runInContext('readVideo()', page);
assert.equal(observed.title, 'Lean explained');
assert.equal(observed.durationSeconds - observed.positionSeconds, 960);
ad = true;
assert.equal(vm.runInContext('readVideo()', page), null, 'ads cannot supply the main video duration');
ad = false;
vm.runInContext('videoNavigating = true', page);
assert.equal(vm.runInContext('readVideo()', page), null, 'navigation cannot report stale metadata');
console.log('PASS: page reader uses real heading/player fields, including paused media, and excludes ads/navigation');
