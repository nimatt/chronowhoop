// Timestamped export filenames (`clip-2026-07-13T09-41-27.cwclip`): local
// time, second precision, colon-free so every OS accepts the name.

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function timestampedFilename(prefix: string, extension: string, date = new Date()): string {
  const stamp =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`
  return `${prefix}-${stamp}.${extension}`
}
