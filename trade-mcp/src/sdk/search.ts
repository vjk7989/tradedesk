import { API_DOCS as ALL_DOCS, API_HEADER, type ApiDoc } from "./api-docs.js";

const MAX = 20;
const MAX_RULES = 8;

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

export function searchApi(query: string, scope: "full" | "readonly" = "full"): string {
  const API_DOCS = ALL_DOCS.filter((d) => scope === "full" || d.ns !== "trade");
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
  const distinct = [...new Set(tokens)];
  const rules = API_HEADER.split("\n")
    .map((line, idx) => {
      const low = line.toLowerCase();
      return { line, idx, score: distinct.filter((t) => low.includes(t)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, MAX_RULES)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.line);
  const rulesBlock = rules.length ? `// Rules:\n${rules.join("\n")}` : "";
  if (!hits.length) return rulesBlock || `No API entries match "${query}".`;
  return rulesBlock ? `${rulesBlock}\n\n${render(hits)}` : render(hits);
}
