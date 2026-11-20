export interface Searchable {
  title: string;
  group: string;
  at: number;
}

/**
 * Ranks items for quick search: every query word must appear in the title or group.
 * Title prefix > word start > anywhere in title > group match; ties go to the most recent.
 */
export function rankMatches<T extends Searchable>(items: T[], query: string, limit: number): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    const group = item.group.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (title.startsWith(w)) score += 6;
      else if (new RegExp(`(^|[\\s:/._-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title)) score += 4;
      else if (title.includes(w)) score += 2;
      else if (group.includes(w)) score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.item.at - a.item.at)
    .slice(0, limit)
    .map((s) => s.item);
}
