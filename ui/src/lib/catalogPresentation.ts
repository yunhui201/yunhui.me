interface CatalogEntry {
  id?: string;
  key?: string;
  name: string;
  nameZh?: string;
  vendor?: string;
  region?: string;
  tags?: string[];
  models?: Array<{ id: string }>;
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const featured = new Map([['openai', 0], ['anthropic', 1], ['gemini', 2], ['google', 2], ['google-gemini', 2]]);
const regions = new Map([['global', 10], ['cn', 20], ['relay', 30], ['local', 40], ['subscription', 60]]);
const identity = (entry: CatalogEntry) => (entry.key || entry.id || '').toLowerCase();
function featuredRank(entry: CatalogEntry): number | undefined {
  // A relay mentioning ChatGPT/Claude/Gemini is still a relay, not the official vendor.
  return !entry.region || entry.region === 'global' ? featured.get(identity(entry)) : undefined;
}

/** Shared presentation order for remote, cached and bundled catalogs; never mutates source data. */
export function sortCatalogEntries<T extends CatalogEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    const group = (featuredRank(a) ?? regions.get(a.region || 'global') ?? 50) - (featuredRank(b) ?? regions.get(b.region || 'global') ?? 50);
    if (group) return group;
    // Keep the toolbox's own preset first within relays, after all international/domestic vendors.
    const relay = Number(b.region === 'relay' && identity(b) === 'yunhui') - Number(a.region === 'relay' && identity(a) === 'yunhui');
    return relay || collator.compare(a.nameZh || a.name, b.nameZh || b.name) || collator.compare(identity(a), identity(b));
  });
}

export function catalogSearchText(entry: CatalogEntry): string {
  const alias = ['OpenAI ChatGPT', 'Anthropic Claude', 'Google Gemini'][featuredRank(entry) ?? -1] || '';
  return [entry.name, entry.nameZh, entry.vendor, alias, entry.tags?.join(' '), entry.models?.map(model => model.id).join(' ')].filter(Boolean).join(' ').toLowerCase();
}
