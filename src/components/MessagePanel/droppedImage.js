import { ensureImageBlobType, imageMimeFromFileName } from '../FileManage/imagePreviewUtils.js';

export async function loadDroppedImage(item, { getFileBlob, downloadFile }) {
  if (item?.type !== 'file' || !imageMimeFromFileName(item.name)) return null;

  let blob;
  if (item.source === 'local') {
    blob = await getFileBlob(item.name, item.parentDir || null);
  } else if (item.source === 'remote') {
    // Match the file manager: null selects the default /agent endpoint.
    blob = await downloadFile(item.path, item.sandboxUrl ?? null);
  } else {
    return null;
  }
  if (!blob) return null;
  const image = ensureImageBlobType(blob, item.name);
  return new File([image], item.name, { type: image.type });
}
