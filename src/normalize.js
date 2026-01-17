const SYNONYM_REPLACEMENTS = [
  [/\bswitch\s+(on|off)\b/g, 'turn $1'],  // "switch on" -> "turn on"
  [/\b(please)\b/g, ''],
  [/\b(the)\b/g, ''],
  [/\b(a)\b/g, ''],
  [/\b(an)\b/g, ''],
  [/\bmy\b/g, ''],
];

export function normalizeUtterance(text) {
  if (!text) return '';
  let normalized = String(text).toLowerCase();
  normalized = normalized.replace(/[^\p{L}\p{N}\s%.-]/gu, ' ');

  for (const [pattern, replacement] of SYNONYM_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }

  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}
