export type SafeJsonParseResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

export type JsonObjectExtractionResult =
  | { ok: true; value: unknown; source: "direct" | "fenced" | "scanned"; candidateIndex: number }
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

export function extractJsonObject(
  input: string,
  accepts: (value: unknown) => boolean = () => true
): SafeJsonParseResult<unknown> {
  const extracted = extractJsonObjectWithMetadata(input, accepts);
  return extracted.ok ? { ok: true, value: extracted.value } : extracted;
}

export function extractJsonObjectWithMetadata(
  input: string,
  accepts: (value: unknown) => boolean = () => true
): JsonObjectExtractionResult {
  const direct = safeJsonParse(input.trim());
  if (direct.ok && accepts(direct.value)) {
    return { ok: true, value: direct.value, source: "direct", candidateIndex: 0 };
  }

  const fencedBlocks = input.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  let fencedIndex = 0;
  for (const fenced of fencedBlocks) {
    const parsed = safeJsonParse(fenced[1]?.trim() ?? "");
    if (parsed.ok && accepts(parsed.value)) {
      return { ok: true, value: parsed.value, source: "fenced", candidateIndex: fencedIndex };
    }
    fencedIndex += 1;
  }

  for (const [candidateIndex, candidate] of findJsonObjectCandidates(input).entries()) {
    const parsed = safeJsonParse(candidate);
    if (parsed.ok && accepts(parsed.value)) {
      return { ok: true, value: parsed.value, source: "scanned", candidateIndex };
    }
  }

  return { ok: false, error: new Error("No valid JSON object found in output") };
}

function findJsonObjectCandidates(input: string): string[] {
  const candidates: string[] = [];

  for (let start = input.indexOf("{"); start !== -1; start = input.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < input.length; index += 1) {
      const character = input[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(input.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
}
