export const FILE_MANAGER_DRAG_TYPE = 'application/x-cherry-filemanager-item';

export function readFileManagerDragItem(dataTransfer) {
  const raw = dataTransfer?.getData(FILE_MANAGER_DRAG_TYPE);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
