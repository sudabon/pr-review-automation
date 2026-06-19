export type SafeJsonParseResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

export function safeJsonParse<T = unknown>(input: string): SafeJsonParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(input) as T };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

export function extractJsonObject(input: string): SafeJsonParseResult<unknown> {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = safeJsonParse(fenced[1].trim());
    if (parsed.ok) {
      return parsed;
    }
  }

  const firstBrace = input.indexOf("{");
  const lastBrace = input.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return { ok: false, error: new Error("No JSON object found in output") };
  }

  return safeJsonParse(input.slice(firstBrace, lastBrace + 1));
}
