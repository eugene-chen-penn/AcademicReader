// Tolerant parser for LLM JSON output: strips markdown code fences, then
// regex-extracts the first [...] array block, then JSON.parses it. Ported
// 1:1 from the old backend's app/llm/client.py::parse_json_array — the scan
// prompt still asks the model for "ONLY a JSON array", but models routinely
// wrap it in ```json fences or add stray commentary anyway.
export function parseJsonArray(text: string | null | undefined): unknown[] {
  if (!text) throw new Error("empty LLM response");
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/, "");
  cleaned = cleaned.replace(/\s*```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error(`no JSON array found in response: ${JSON.stringify(text.slice(0, 200))}`);
  }
  return JSON.parse(match[0]);
}
