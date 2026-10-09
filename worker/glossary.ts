/** Existing built-in glossary lookup used by the query_glossary tool. */
export function glossaryQuery(term: string) {
  const normalized = (term || "").trim().toLowerCase();
  let translation = null;
  if (normalized.includes("transaction")) translation = "事务";
  else if (normalized.includes("embedding")) translation = "嵌入";
  return { term, translation, context: translation ? "approved" : "unmatched" };
}
