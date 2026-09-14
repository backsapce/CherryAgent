// Extracts AI-generation metadata (workflow info) embedded by image tools such as
// ComfyUI, Stable Diffusion WebUI (A1111/Forge), and NovelAI from raw image bytes.
// All functions are best-effort: malformed input yields null instead of throwing.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CONDITIONING_FOLLOW_DEPTH = 12;

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesStartWith(bytes, prefix) {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

function chunkType(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

// Collects PNG tEXt / zTXt / iTXt chunks into a keyword -> text map.
async function readPngTextChunks(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 8 || !bytesStartWith(new Uint8Array(buffer, 0, 8), PNG_SIGNATURE)) return null;

  const chunks = {};
  let offset = 8;
  while (offset + 12 <= view.byteLength) {
    const length = view.getUint32(offset);
    if (offset + 8 + length > view.byteLength) break;
    const type = chunkType(view, offset + 4);
    const data = new Uint8Array(buffer, offset + 8, length);

    if (type === 'tEXt') {
      const zero = data.indexOf(0);
      if (zero > 0) chunks[decodeUtf8(data.subarray(0, zero))] = decodeUtf8(data.subarray(zero + 1));
    } else if (type === 'zTXt') {
      const zero = data.indexOf(0);
      if (zero > 0 && data[zero + 1] === 0) {
        try {
          chunks[decodeUtf8(data.subarray(0, zero))] = decodeUtf8(await inflate(data.subarray(zero + 2)));
        } catch { /* skip unreadable chunk */ }
      }
    } else if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0);
      if (keywordEnd > 0 && keywordEnd + 3 < data.length) {
        const compressed = data[keywordEnd + 1] === 1;
        let cursor = keywordEnd + 3; // skip compression flag + method
        cursor = data.indexOf(0, cursor) + 1; // language tag
        cursor = data.indexOf(0, cursor) + 1; // translated keyword
        if (cursor > 0 && cursor <= data.length) {
          try {
            const textBytes = data.subarray(cursor);
            chunks[decodeUtf8(data.subarray(0, keywordEnd))] = decodeUtf8(compressed ? await inflate(textBytes) : textBytes);
          } catch { /* skip unreadable chunk */ }
        }
      }
    }

    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

// Returns the EXIF UserComment string of a JPEG (APP1 "Exif\0\0") or WebP (EXIF chunk).
function findExifUserComment(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 12) return null;

  let exifStart = -1;
  if (view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) return null;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xda || marker === 0xd9) break;
      const size = view.getUint16(offset + 2);
      if (marker === 0xe1 && size > 10 && bytesStartWith(new Uint8Array(buffer, offset + 4, 6), [0x45, 0x78, 0x69, 0x66, 0, 0])) {
        exifStart = offset + 10;
        break;
      }
      offset += 2 + size;
    }
  } else if (
    bytesStartWith(new Uint8Array(buffer, 0, 4), [0x52, 0x49, 0x46, 0x46]) &&
    bytesStartWith(new Uint8Array(buffer, 8, 4), [0x57, 0x45, 0x42, 0x50])
  ) {
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const size = view.getUint32(offset + 4, true);
      if (chunkType(view, offset) === 'EXIF') {
        const data = new Uint8Array(buffer, offset + 8, Math.min(size, view.byteLength - offset - 8));
        const withHeader = bytesStartWith(data, [0x45, 0x78, 0x69, 0x66, 0, 0]) ? 6 : 0;
        exifStart = offset + 8 + withHeader;
        break;
      }
      offset += 8 + size + (size % 2);
    }
  }

  if (exifStart < 0) return null;
  return parseExifUserComment(view, exifStart);
}

function parseExifUserComment(view, tiffStart) {
  if (tiffStart + 8 > view.byteLength) return null;
  const byteOrder = view.getUint16(tiffStart);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;
  const little = byteOrder === 0x4949;
  const ifdOffset = view.getUint32(tiffStart + 4, little);
  const ifd = tiffStart + ifdOffset;
  if (ifd + 2 > view.byteLength) return null;

  const entryCount = view.getUint16(ifd, little);
  for (let i = 0; i < entryCount && ifd + 2 + i * 12 + 12 <= view.byteLength; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (view.getUint16(entry, little) !== 0x9286) continue;
    const size = view.getUint32(entry + 4, little);
    const valueOffset = size <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, little);
    if (valueOffset + size > view.byteLength || size < 9) return null;

    const data = new Uint8Array(view.buffer, valueOffset, size);
    const charset = decodeUtf8(data.subarray(0, 8)).replace(/\0/g, '').trim().toUpperCase();
    const text = charset === 'UNICODE'
      ? new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(data.subarray(8))
      : decodeUtf8(data.subarray(8));
    return text.replace(/\0+$/g, '');
  }
  return null;
}

// --- ComfyUI -----------------------------------------------------------------

function parseComfyGraph(graph) {
  const nodes = Object.values(graph);
  const node = (ref) => (Array.isArray(ref) ? graph[String(ref[0])] : null);
  const literal = (value) => (Array.isArray(value) ? undefined : value);

  const samplers = nodes.filter((entry) => /^(KSampler|KSamplerAdvanced|SamplerCustom)$/i.test(entry?.class_type || ''));
  const sampler = samplers[0];
  const inputs = sampler?.inputs || {};

  // SamplerCustom routes sampler/scheduler through selector nodes (KSamplerSelect / BasicScheduler).
  const followLiteral = (value, field, depth = 0) => {
    const direct = literal(value);
    if (direct !== undefined) return direct;
    const linked = node(value);
    if (!linked || depth >= 4) return undefined;
    const nested = linked.inputs?.[field];
    return nested === undefined ? undefined : literal(nested);
  };

  const promptTexts = (ref, depth = 0, acc = [], seen = new Set()) => {
    const linked = node(ref);
    if (!linked || depth > CONDITIONING_FOLLOW_DEPTH) return acc;
    const classType = linked.class_type || '';
    if (/CLIPTextEncode/i.test(classType)) {
      if (linked.inputs?.text && !seen.has(linked.inputs.text)) {
        seen.add(linked.inputs.text);
        acc.push(String(linked.inputs.text));
      }
      return acc;
    }
    if (/Conditioning/i.test(classType)) {
      Object.values(linked.inputs || {}).forEach((value) => promptTexts(value, depth + 1, acc, seen));
    }
    return acc;
  };

  const loras = nodes
    .filter((entry) => /LoraLoader/i.test(entry?.class_type || ''))
    .map((entry) => ({
      name: entry.inputs?.lora_name ? String(entry.inputs.lora_name) : null,
      strength: literal(entry.inputs?.strength_model ?? entry.inputs?.strength),
    }))
    .filter((entry) => entry.name);

  const latent = nodes.find((entry) => /Empty\w*Latent/i.test(entry?.class_type || ''));

  const seedNode = node(inputs.noise ?? inputs.seed);
  const seed = literal(inputs.seed) ?? literal(inputs.noise_seed)
    ?? (seedNode ? literal(seedNode.inputs?.seed ?? seedNode.inputs?.noise_seed) : undefined);

  const model = nodes.find((entry) => /CheckpointLoader/i.test(entry?.class_type || ''))?.inputs?.ckpt_name
    ?? nodes.find((entry) => /UNETLoader|UnetLoader/i.test(entry?.class_type || ''))?.inputs?.unet_name;

  const samplerName = followLiteral(inputs.sampler_name, 'sampler_name');
  const scheduler = followLiteral(inputs.scheduler, 'scheduler');

  return {
    source: 'comfyui',
    sourceLabel: 'ComfyUI',
    prompt: promptTexts(inputs.positive).join('\n') || null,
    negativePrompt: promptTexts(inputs.negative).join('\n') || null,
    resolution: latent ? `${latent.inputs?.width}x${latent.inputs?.height}` : null,
    model: model === undefined ? null : String(model),
    loras,
    sampler: samplerName === undefined ? null : String(samplerName) + (scheduler ? ` (${scheduler})` : ''),
    steps: literal(inputs.steps),
    seed,
    cfg: literal(inputs.cfg),
    duration: null,
  };
}

// --- Stable Diffusion WebUI (A1111 / Forge) -----------------------------------

function parseA1111Parameters(text) {
  const lines = text.split(/\r?\n/);
  const negativeIndex = lines.findIndex((line) => /^Negative prompt:/i.test(line));
  const paramsIndex = lines.findIndex((line) => /^Steps:\s*\d/.test(line));
  const paramsEnd = paramsIndex >= 0 ? paramsIndex : lines.length;
  const positiveEnd = negativeIndex >= 0 ? negativeIndex : paramsEnd;

  const params = {};
  if (paramsIndex >= 0) {
    const paramsLine = lines.slice(paramsIndex).join(' ');
    const entryPattern = /([A-Za-z][A-Za-z0-9 _/'-]*):\s*("[^"]*"|[^,]*)(?:,|$)/g;
    let match = entryPattern.exec(paramsLine);
    while (match) {
      params[match[1].trim().toLowerCase()] = match[2].trim().replace(/^"|"$/g, '');
      match = entryPattern.exec(paramsLine);
    }
  }

  const prompt = lines.slice(0, positiveEnd).join('\n').trim();
  const negativePrompt = negativeIndex >= 0
    ? lines.slice(negativeIndex, paramsEnd).join('\n').replace(/^Negative prompt:\s*/i, '').trim()
    : null;

  const loras = [];
  const loraPattern = /<lora:([^:>]+)(?::([\d.eE+-]+))?>/g;
  let loraMatch = loraPattern.exec(prompt);
  while (loraMatch) {
    const name = loraMatch[1].trim();
    if (!loras.some((entry) => entry.name === name)) loras.push({ name, strength: loraMatch[2] === undefined ? null : Number(loraMatch[2]) });
    loraMatch = loraPattern.exec(prompt);
  }
  if (negativePrompt) {
    let negativeMatch = loraPattern.exec(negativePrompt);
    while (negativeMatch) {
      const name = negativeMatch[1].trim();
      if (!loras.some((entry) => entry.name === name)) loras.push({ name, strength: negativeMatch[2] === undefined ? null : Number(negativeMatch[2]) });
      negativeMatch = loraPattern.exec(negativePrompt);
    }
  }

  const schedule = params['schedule type'];
  const durationKey = Object.keys(params).find((key) => /time taken|^duration$|elapsed/i.test(key));

  return {
    source: 'a1111',
    sourceLabel: 'Stable Diffusion WebUI',
    prompt: prompt || null,
    negativePrompt: negativePrompt || null,
    resolution: params.size || null,
    model: params.model || null,
    loras,
    sampler: params.sampler ? params.sampler + (schedule && !/^automatic$/i.test(schedule) ? ` (${schedule})` : '') : null,
    steps: params.steps !== undefined ? Number(params.steps) : null,
    seed: params.seed !== undefined ? Number(params.seed) : null,
    cfg: params['cfg scale'] !== undefined ? Number(params['cfg scale']) : null,
    duration: durationKey ? `${params[durationKey]}`.replace(/^Time taken:\s*/i, '') : null,
  };
}

// --- NovelAI ------------------------------------------------------------------

function parseNovelai(chunks) {
  let comment = null;
  try {
    comment = chunks.Comment ? JSON.parse(chunks.Comment) : null;
  } catch { comment = null; }
  if (!comment || typeof comment !== 'object') return null;

  const resolution = comment.width && comment.height ? `${comment.width}x${comment.height}` : null;
  return {
    source: 'novelai',
    sourceLabel: 'NovelAI',
    prompt: chunks.Description || comment.prompt || null,
    negativePrompt: comment.uc || null,
    resolution,
    model: chunks.Source || null,
    loras: [],
    sampler: comment.sampler || null,
    steps: comment.steps !== undefined ? Number(comment.steps) : null,
    seed: comment.seed !== undefined ? Number(comment.seed) : null,
    cfg: comment.scale !== undefined ? Number(comment.scale) : null,
    duration: null,
  };
}

function isComfyGraph(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.values(parsed).some((entry) => entry && typeof entry === 'object' && typeof entry.class_type === 'string');
  } catch {
    return false;
  }
}

/**
 * Parses AI-generation metadata from raw image bytes.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{source: string, sourceLabel: string, prompt: ?string, negativePrompt: ?string,
 *   resolution: ?string, model: ?string, loras: Array<{name: string, strength: ?number}>,
 *   sampler: ?string, steps: ?number, seed: ?number, cfg: ?number, duration: ?string} | null>}
 */
export async function parseAiImageMeta(buffer) {
  if (!(buffer instanceof ArrayBuffer)) return null;
  try {
    let chunks = null;
    if (buffer.byteLength >= 8) chunks = await readPngTextChunks(buffer);
    if (!chunks) {
      const userComment = findExifUserComment(buffer);
      if (userComment) chunks = { parameters: userComment };
    }
    if (!chunks) return null;

    if (chunks.prompt && isComfyGraph(chunks.prompt)) return parseComfyGraph(JSON.parse(chunks.prompt));
    if (chunks.parameters) return parseA1111Parameters(chunks.parameters);
    if (/novelai/i.test(chunks.Software || '')) return parseNovelai(chunks);
    return null;
  } catch {
    return null;
  }
}

// [i18n key, meta property, multiline] in display order; falsy values are skipped.
const AI_INFO_FIELDS = [
  ['aiPrompt', 'prompt', true],
  ['aiResolution', 'resolution', false],
  ['aiModel', 'model', false],
  ['aiLoras', 'lorasText', true],
  ['aiSampler', 'sampler', false],
  ['aiSteps', 'steps', false],
  ['aiSeed', 'seed', false],
  ['aiCfg', 'cfg', false],
  ['aiDuration', 'duration', false],
];

/**
 * Flattens parsed metadata into ordered display fields. `translate` maps an
 * i18n key (e.g. "filemanage.aiPrompt") to a label. The resolution prefers the
 * decoded image dimensions (`naturalSize`) — the workflow's latent size can
 * differ from the shipped file after upscaling — and falls back to metadata
 * while the image is still loading.
 */
export function buildAiInfoFields(meta, naturalSize, translate) {
  if (!meta) return [];
  const values = {
    ...meta,
    lorasText: meta.loras?.length
      ? meta.loras.map((lora) => (lora.strength === null || lora.strength === undefined ? lora.name : `${lora.name} (${lora.strength})`)).join('\n')
      : null,
    resolution: naturalSize ? `${naturalSize.width}x${naturalSize.height}` : meta.resolution,
  };
  return AI_INFO_FIELDS
    .filter(([, property]) => values[property] !== null && values[property] !== undefined && values[property] !== '')
    .map(([key, property, multiline]) => ({
      key,
      label: translate(`filemanage.${key}`),
      value: String(values[property]),
      multiline,
    }));
}
