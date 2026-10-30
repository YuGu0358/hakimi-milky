// Runs work over items in batches, so a long list does not open every connection at once.
export async function mapLimited(items, limit, work, pause = async () => {}) {
  const results = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))));
    if (start + limit < items.length) await pause();
  }
  return results;
}
