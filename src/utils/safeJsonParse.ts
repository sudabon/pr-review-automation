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
  const direct = safeJsonParse(input.trim());
  if (direct.ok) {
    return direct;
  }

  const fencedBlocks = input.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const fenced of fencedBlocks) {
    const parsed = safeJsonParse(fenced[1]?.trim() ?? "");
    if (parsed.ok) {
      return parsed;
    }
  }

  for (const candidate of findJsonObjectCandidates(input)) {
    const parsed = safeJsonParse(candidate);
    if (parsed.ok) {
      return parsed;
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
