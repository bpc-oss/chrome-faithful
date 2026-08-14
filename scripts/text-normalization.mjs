export function normalizeLf(text) {
  return String(text).replace(/\r\n?/g, "\n");
}
