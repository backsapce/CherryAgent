// Research benchmark: compression algorithms for session-message JSON in a browser/OPFS context.
// Run: node scripts/bench-session-compression.mjs
import zlib from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

// ── 1. Synthetic but realistic session corpus ────────────────────────────────
const EN_SENTENCES = [
  'The agent loop streams with tool schemas and serializes tool executions.',
  'Persistence is atomic via temp-swap writes with a generation-fenced save coordinator.',
  'Token estimation is CJK-aware, roughly one token per CJK character.',
  'The summary is anchored to the message id it covers and invalidated on edits.',
  'Managed background jobs keep incremental byte-cursor logs that are UTF-8 boundary safe.',
];
const ZH_SENTENCES = [
  '这是一个运行在浏览器里的智能体框架，所有数据都保存在 OPFS 中。',
  '会话消息按会话 id 分文件存储，索引文件最后发布以保证崩溃安全。',
  '上下文打包时会保护头部消息，并对被裁剪的中间部分生成摘要。',
  '工具结果会被截断后回填给模型，避免超出上下文窗口。',
  '后台任务通过一条多路复用的 WebSocket 与本地服务器通信。',
];
const TOOLS = ['execute_command', 'read_browser_file', 'write_browser_file', 'web_search', 'memory', 'skill'];
const rand = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function textPara() {
  const parts = [];
  const n = 2 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i += 1) parts.push(rand() < 0.5 ? pick(ZH_SENTENCES) : pick(EN_SENTENCES));
  return parts.join('');
}

function codeBlock() {
  return "```js\n" + `export async function step${Math.floor(rand() * 1000)}(ctx) {\n  const result = await ctx.run(${JSON.stringify(textPara().slice(0, 30))});\n  return { ok: true, result, ts: Date.now() };\n}\n`.repeat(1 + Math.floor(rand() * 3)) + "```";
}

function imageDataUrl() {
  // pseudo-random base64 payload ~200KB (typical pasted screenshot)
  const bytes = new Uint8Array(200 * 1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(rand() * 256);
  return 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
}

function makeMessage(index) {
  const id = (Date.parse('2026-01-01') / 1000 + index * 137).toString(36) + Math.floor(rand() * 1e6).toString(36);
  const role = index % 3 === 0 ? 'user' : 'assistant';
  const message = {
    id,
    role,
    createdAtMs: Date.parse('2026-01-01') + index * 60_000,
    content: '',
  };
  if (role === 'user') {
    message.content = textPara();
    if (rand() < 0.05) message.content += `\n\n![pasted](${imageDataUrl().slice(0, 0)})` , message.attachments = [{ type: 'image', url: imageDataUrl() }];
  } else {
    message.content = `${textPara()}\n\n${codeBlock()}\n\n${textPara()}`;
    message.thinking = textPara().slice(0, 200);
    if (rand() < 0.6) {
      message.toolCalls = [{
        id: `call_${index}_${Math.floor(rand() * 1e5)}`,
        name: pick(TOOLS),
        arguments: { command: 'git status --short && npm test', path: `src/vfs/opfs.js`, query: textPara().slice(0, 40) },
      }];
      message.toolResults = [{ text: `$ git status\n M src/vfs/opfs.js\n\n${(pick(EN_SENTENCES) + '\n').repeat(10)}` }];
    }
  }
  return message;
}

const corpus = (count) => JSON.stringify(Array.from({ length: count }, (_, i) => makeMessage(i)));

// ── 2. Native Web streams (what the browser gives us; also global in Node ≥18) ─
async function streamCompress(text, format) {
  const cs = new CompressionStream(format);
  const stream = new Blob([text]).stream().pipeThrough(cs);
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
async function streamDecompress(bytes, format) {
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

// ── 3. Timing helper ─────────────────────────────────────────────────────────
async function timeIt(fn) {
  const start = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { value, ms };
}
const kb = (n) => (n / 1024).toFixed(1) + ' KiB';

(async () => {
  for (const count of [100, 1000, 5000]) {
    const json = corpus(count);
    const raw = new TextEncoder().encode(json);
    console.log(`\n=== corpus: ${count} messages → ${kb(raw.length)} JSON (UTF-8) ===`);
    const variants = [
      {
        name: 'native CompressionStream gzip (browser built-in)',
        available: 'Chrome 80+ / FF 113+ / Safari 16.4+ / Node 18+',
        compress: () => streamCompress(json, 'gzip'),
        decompress: (b) => streamDecompress(b, 'gzip'),
      },
      {
        name: 'native CompressionStream deflate-raw',
        available: 'same as gzip minus 18-byte header',
        compress: () => streamCompress(json, 'deflate-raw'),
        decompress: (b) => streamDecompress(b, 'deflate-raw'),
      },
      {
        name: 'pako gzip -6 (pure JS, JSZip engine)',
        available: 'any browser, +45KB dep',
        compress: async () => zlib.gzipSync(raw, { level: 6 }),
        decompress: async (b) => new TextDecoder().decode(zlib.gunzipSync(b)),
      },
      {
        name: 'pako gzip -1 (speed)',
        available: 'any browser, +45KB dep',
        compress: async () => zlib.gzipSync(raw, { level: 1 }),
        decompress: async (b) => new TextDecoder().decode(zlib.gunzipSync(b)),
      },
      {
        name: 'brotli q11 (node:zlib; NOT in CompressionStream)',
        available: 'reference only — needs wasm dep in browser',
        compress: async () => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
        decompress: async (b) => new TextDecoder().decode(zlib.brotliDecompressSync(b)),
      },
      {
        name: 'brotli q5 (node:zlib)',
        available: 'reference only',
        compress: async () => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
        decompress: async (b) => new TextDecoder().decode(zlib.brotliDecompressSync(b)),
      },
    ];
    if (typeof zlib.zstdSync === 'function') {
      variants.push({
        name: 'zstd (node:zlib; NOT in CompressionStream)',
        available: 'reference only',
        compress: async () => zlib.zstdSync(raw, { level: 6 }),
        decompress: async (b) => new TextDecoder().decode(zlib.unzstdSync(b)),
      });
    }
    console.log('algorithm'.padEnd(52), 'out', '      ratio', '   enc ms', 'dec ms');
    for (const v of variants) {
      // warmup for JIT + stream machinery
      await v.compress();
      const c = await timeIt(() => v.compress());
      const d = await timeIt(() => v.decompress(c.value));
      const ok = d.value === json;
      console.log(
        v.name.padEnd(52),
        kb(c.value.length).padStart(10),
        ((c.value.length / raw.length) * 100).toFixed(1).padStart(5) + '%',
        c.ms.toFixed(1).padStart(8),
        d.ms.toFixed(1).padStart(7),
        ok ? '' : '  ✗ ROUNDTRIP MISMATCH'
      );
    }
    await delay(50);
  }

  // gzip magic-header self-identification check
  const gz = await streamCompress('hello', 'gzip');
  console.log('\ngzip magic bytes:', gz[0].toString(16), gz[1].toString(16), '(1f 8b = self-describing format)');
})();
