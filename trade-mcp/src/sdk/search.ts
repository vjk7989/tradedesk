import { API_DOCS, API_HEADER, type ApiDoc } from "./api-docs.js";

const MAX = 20;

function render(entries: ApiDoc[]): string {
  const byNs = new Map<string, ApiDoc[]>();
  for (const e of entries) byNs.set(e.ns, [...(byNs.get(e.ns) ?? []), e]);
  return [...byNs]
    .map(
      ([ns, es]) =>
        `declare namespace ${ns} {\n` + es.map((e) => `  /** ${e.doc} */\n  function ${e.signature};`).join("\n") + "\n}",
    )
    .join("\n\n");
}

export function searchApi(query: string): string {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    const nss = [...new Set(API_DOCS.map((d) => d.ns))];
    const index = nss.map((ns) => `${ns}: ${API_DOCS.filter((d) => d.ns === ns).map((d) => d.name).join(", ")}`).join("\n");
    return `${API_HEADER}\n\nNamespaces:\n${index}`;
  }
  const hits = API_DOCS.filter((d) => {
    const hay = `${d.ns} ${d.name} ${d.doc}`.toLowerCase();
    return tokens.some((t) => hay.includes(t));
  }).slice(0, MAX);
  return hits.length ? render(hits) : `No API entries match "${query}".`;
}
