const DEFAULT_SWIPE_THRESHOLD = 48;
const HORIZONTAL_DOMINANCE_RATIO = 1.2;

export const resolveImageSwipe = ({
  deltaX,
  deltaY,
  hasPrevious,
  hasNext,
  threshold = DEFAULT_SWIPE_THRESHOLD,
}) => {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);

  if (horizontalDistance < threshold) return 0;
  if (horizontalDistance < verticalDistance * HORIZONTAL_DOMINANCE_RATIO) return 0;
  if (deltaX > 0) return hasPrevious ? -1 : 0;
  return hasNext ? 1 : 0;
};

