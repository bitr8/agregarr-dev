export const formatTime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
};

export const formatDurationMs = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return '<1s';
  return formatTime(seconds);
};
