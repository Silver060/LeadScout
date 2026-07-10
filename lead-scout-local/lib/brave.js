import { env } from "./env.js";
import { withRetry } from "./retry.js";

export async function braveSearch(query, { freshness = "pw", count = 8 } = {}) {
  return withRetry(async () => {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    url.searchParams.set("freshness", freshness); // pw = past week, pm = past month
    const res = await fetch(url, { headers: { "X-Subscription-Token": env.braveKey(), Accept: "application/json" } });
    if (!res.ok) throw new Error(`Brave ${res.status}`);
    const json = await res.json();
    return (json.web?.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      age: r.age || r.page_age || null,
    }));
  }, { label: `brave:"${query.slice(0, 40)}"` });
}
