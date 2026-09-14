import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiInfoFields, parseAiImageMeta } from './aiImageMeta.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function makePng(...chunks) {
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, 512);
  ihdrView.setUint32(4, 512);
  ihdrData[8] = 8;
  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    pngChunk('IHDR', ihdrData),
    ...chunks,
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out.buffer;
}

function textChunk(keyword, value) {
  const encoded = new TextEncoder();
  const keywordBytes = encoded.encode(keyword);
  const valueBytes = encoded.encode(value);
  const data = new Uint8Array(keywordBytes.length + 1 + valueBytes.length);
  data.set(keywordBytes, 0);
  data[keywordBytes.length] = 0;
  data.set(valueBytes, keywordBytes.length + 1);
  return pngChunk('tEXt', data);
}

async function compressedItxtChunk(keyword, value) {
  const encoded = new TextEncoder();
  const keywordBytes = encoded.encode(keyword);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([encoded.encode(value)]).stream().pipeThrough(new CompressionStream('deflate'))
    ).arrayBuffer()
  );
  // keyword \0 compressionFlag compressionMethod language \0 translated \0 data
  const data = new Uint8Array(keywordBytes.length + 5 + compressed.length);
  let cursor = 0;
  data.set(keywordBytes, cursor);
  cursor += keywordBytes.length;
  data[cursor++] = 0;
  data[cursor++] = 1;
  data[cursor++] = 0;
  data[cursor++] = 0;
  data[cursor++] = 0;
  data.set(compressed, cursor);
  return pngChunk('iTXt', data);
}

function makeJpegWithUserComment(text) {
  const textBytes = new TextEncoder().encode(`ASCII\0\0\0${text}`);
  const dataOffset = 8 + 2 + 12 + 4;
  const tiff = new Uint8Array(dataOffset + textBytes.length);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x9286, true);
  view.setUint16(12, 7, true);
  view.setUint32(14, textBytes.length, true);
  view.setUint32(18, dataOffset, true);
  view.setUint32(22, 0, true);
  tiff.set(textBytes, dataOffset);

  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);
  payload.set(tiff, 6);
  const out = new Uint8Array(6 + payload.length + 2);
  const outView = new DataView(out.buffer);
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  out[3] = 0xe1;
  outView.setUint16(4, payload.length + 2);
  out.set(payload, 6);
  out[6 + payload.length] = 0xff;
  out[7 + payload.length] = 0xd9;
  return out.buffer;
}

function makeWebpWithExif(tiffBytes) {
  const payload = new Uint8Array(6 + tiffBytes.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);
  payload.set(tiffBytes, 6);
  const out = new Uint8Array(12 + 8 + payload.length);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, out.length - 8, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set([0x45, 0x58, 0x49, 0x46], 12);
  view.setUint32(16, payload.length, true);
  out.set(payload, 20);
  return out.buffer;
}

const COMFY_GRAPH = JSON.stringify({
  3: {
    class_type: 'KSampler',
    inputs: {
      seed: 156680208700286,
      steps: 20,
      cfg: 8.0,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1.0,
      model: [10, 0],
      positive: [6, 0],
      negative: [7, 0],
      latent_image: [5, 0],
    },
  },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 768, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'beautiful scenery nature mountain lake', clip: [4, 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'ugly, watermark, blurry', clip: [4, 1] } },
  10: { class_type: 'LoraLoader', inputs: { lora_name: 'detail_tweaker_xl.safetensors', strength_model: 0.8, strength_clip: 0.8, model: [4, 0], clip: [4, 1] } },
});

const A1111_PARAMETERS = [
  'masterpiece, best quality, <lora:add_detail:0.6>, 1girl, <lora:film_grain:0.4>',
  'Negative prompt: (worst quality:1.4), lowres, <lora:bad_prompt_v2:0.5>',
  'Steps: 28, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 5, Seed: 3484050600, Size: 832x1216, Model hash: 4fc2b075ab, Model: animaXL_v10, Version: v1.10.0',
].join('\n');

const NAI_COMMENT = JSON.stringify({
  prompt: '1girl, best quality',
  steps: 28,
  sampler: 'k_euler_ancestral',
  seed: 123456,
  scale: 5,
  uc: 'lowres, bad',
  noise_schedule: 'native',
});

test('parseAiImageMeta extracts ComfyUI workflow from tEXt prompt chunk', async () => {
  const meta = await parseAiImageMeta(makePng(textChunk('prompt', COMFY_GRAPH)));
  assert.ok(meta);
  assert.equal(meta.source, 'comfyui');
  assert.equal(meta.sourceLabel, 'ComfyUI');
  assert.equal(meta.prompt, 'beautiful scenery nature mountain lake');
  assert.equal(meta.negativePrompt, 'ugly, watermark, blurry');
  assert.equal(meta.model, 'sd_xl_base_1.0.safetensors');
  assert.equal(meta.resolution, '1024x768');
  assert.equal(meta.sampler, 'euler (normal)');
  assert.equal(meta.steps, 20);
  assert.equal(meta.cfg, 8.0);
  assert.equal(meta.seed, 156680208700286);
  assert.deepEqual(meta.loras, [{ name: 'detail_tweaker_xl.safetensors', strength: 0.8 }]);
});

test('parseAiImageMeta reads compressed iTXt chunks', async () => {
  const meta = await parseAiImageMeta(makePng(await compressedItxtChunk('prompt', COMFY_GRAPH)));
  assert.ok(meta);
  assert.equal(meta.source, 'comfyui');
  assert.equal(meta.steps, 20);
  assert.equal(meta.model, 'sd_xl_base_1.0.safetensors');
});

test('parseAiImageMeta extracts Stable Diffusion WebUI parameters', async () => {
  const meta = await parseAiImageMeta(makePng(textChunk('parameters', A1111_PARAMETERS)));
  assert.ok(meta);
  assert.equal(meta.source, 'a1111');
  assert.equal(meta.prompt, 'masterpiece, best quality, <lora:add_detail:0.6>, 1girl, <lora:film_grain:0.4>');
  assert.equal(meta.negativePrompt, '(worst quality:1.4), lowres, <lora:bad_prompt_v2:0.5>');
  assert.equal(meta.model, 'animaXL_v10');
  assert.equal(meta.resolution, '832x1216');
  assert.equal(meta.sampler, 'DPM++ 2M (Karras)');
  assert.equal(meta.steps, 28);
  assert.equal(meta.seed, 3484050600);
  assert.equal(meta.cfg, 5);
  assert.deepEqual(meta.loras, [
    { name: 'add_detail', strength: 0.6 },
    { name: 'film_grain', strength: 0.4 },
    { name: 'bad_prompt_v2', strength: 0.5 },
  ]);
});

test('parseAiImageMeta extracts NovelAI metadata', async () => {
  const meta = await parseAiImageMeta(makePng(
    textChunk('Title', 'AI generated image'),
    textChunk('Description', '1girl, best quality'),
    textChunk('Software', 'NovelAI'),
    textChunk('Source', 'Stable Diffusion XL 75851f5c'),
    textChunk('Comment', NAI_COMMENT),
  ));
  assert.ok(meta);
  assert.equal(meta.source, 'novelai');
  assert.equal(meta.prompt, '1girl, best quality');
  assert.equal(meta.negativePrompt, 'lowres, bad');
  assert.equal(meta.model, 'Stable Diffusion XL 75851f5c');
  assert.equal(meta.sampler, 'k_euler_ancestral');
  assert.equal(meta.steps, 28);
  assert.equal(meta.cfg, 5);
  assert.equal(meta.seed, 123456);
});

test('parseAiImageMeta reads Stable Diffusion WebUI parameters from JPEG EXIF', async () => {
  const meta = await parseAiImageMeta(makeJpegWithUserComment(A1111_PARAMETERS));
  assert.ok(meta);
  assert.equal(meta.source, 'a1111');
  assert.equal(meta.model, 'animaXL_v10');
  assert.equal(meta.resolution, '832x1216');
  assert.equal(meta.steps, 28);
});

test('parseAiImageMeta reads EXIF UserComment from WebP', async () => {
  const jpeg = new Uint8Array(makeJpegWithUserComment(A1111_PARAMETERS));
  const app1Size = (jpeg[4] << 8) | jpeg[5];
  const tiff = jpeg.subarray(12, 4 + app1Size);
  const meta = await parseAiImageMeta(makeWebpWithExif(tiff));
  assert.ok(meta);
  assert.equal(meta.source, 'a1111');
  assert.equal(meta.model, 'animaXL_v10');
  assert.equal(meta.sampler, 'DPM++ 2M (Karras)');
});

test('parseAiImageMeta joins conditioned text nodes through the positive chain', async () => {
  const graph = JSON.stringify({
    1: {
      class_type: 'KSampler',
      inputs: {
        seed: 42, steps: 30, cfg: 3.5, sampler_name: 'dpmpp_2m', scheduler: 'sgm_uniform',
        model: [4, 0], positive: [2, 0], negative: [3, 0], latent_image: [5, 0],
      },
    },
    2: { class_type: 'ConditioningConcat', inputs: { conditioning_to: [6, 0], conditioning_from: [7, 0] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'negative text' } },
    4: { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' } },
    5: { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'first part' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'second part' } },
  });
  const meta = await parseAiImageMeta(makePng(textChunk('prompt', graph)));
  assert.ok(meta);
  assert.equal(meta.prompt, 'first part\nsecond part');
  assert.equal(meta.negativePrompt, 'negative text');
  assert.equal(meta.model, 'flux1-dev.safetensors');
  assert.equal(meta.resolution, '1024x1024');
  assert.equal(meta.sampler, 'dpmpp_2m (sgm_uniform)');
  assert.deepEqual(meta.loras, []);
});

test('parseAiImageMeta returns null for images without AI metadata', async () => {
  assert.equal(await parseAiImageMeta(makePng()), null);
  assert.equal(await parseAiImageMeta(new ArrayBuffer(0)), null);
  assert.equal(await parseAiImageMeta(makePng(textChunk('Comment', 'plain screenshot'))), null);
});

test('parseAiImageMeta returns null for non-image buffers', async () => {
  assert.equal(await parseAiImageMeta(new TextEncoder().encode('hello world').buffer), null);
});

test('buildAiInfoFields orders fields, skips missing ones, and formats loras', async () => {
  const meta = await parseAiImageMeta(makePng(textChunk('prompt', COMFY_GRAPH)));
  const fields = buildAiInfoFields(meta, null, (key) => key.split('.').pop());
  assert.deepEqual(fields.map((field) => field.key), [
    'aiPrompt', 'aiResolution', 'aiModel', 'aiLoras', 'aiSampler', 'aiSteps', 'aiSeed', 'aiCfg',
  ]);
  assert.equal(fields[0].multiline, true);
  assert.equal(fields[0].value, 'beautiful scenery nature mountain lake');
  assert.equal(fields[1].value, '1024x768');
  assert.equal(fields[3].value, 'detail_tweaker_xl.safetensors (0.8)');
  assert.ok(!fields.some((field) => field.key === 'aiDuration'));
  assert.ok(!fields.some((field) => field.key === 'aiNegativePrompt'));
});

test('buildAiInfoFields prefers the decoded image size over workflow resolution', () => {
  const fields = buildAiInfoFields(
    { source: 'x', sourceLabel: 'X', prompt: 'p', loras: [], resolution: '512x512' },
    { width: 2048, height: 3072 },
    (key) => key
  );
  assert.equal(fields.find((field) => field.key === 'aiResolution').value, '2048x3072');
});

test('buildAiInfoFields falls back to workflow resolution while the image is loading', () => {
  const fields = buildAiInfoFields(
    { source: 'x', sourceLabel: 'X', prompt: 'p', loras: [], resolution: '832x1216' },
    null,
    (key) => key
  );
  assert.equal(fields.find((field) => field.key === 'aiResolution').value, '832x1216');
});

test('buildAiInfoFields keeps a zero seed', () => {
  const fields = buildAiInfoFields(
    { source: 'x', sourceLabel: 'X', prompt: 'p', loras: [], seed: 0 },
    null,
    (key) => key
  );
  assert.equal(fields.find((field) => field.key === 'aiSeed').value, '0');
});
