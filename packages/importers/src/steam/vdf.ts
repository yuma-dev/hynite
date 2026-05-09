export interface VdfObject {
  [key: string]: string | VdfObject;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"|([{}])/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input))) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    } else if (match[2]) {
      tokens.push(match[2]);
    }
  }
  return tokens;
}

export function parseVdf(input: string): VdfObject {
  const tokens = tokenize(input);
  let index = 0;

  function parseObject(): VdfObject {
    const result: VdfObject = {};
    while (index < tokens.length) {
      const key = tokens[index++];
      if (!key || key === "}") {
        break;
      }

      const next = tokens[index++];
      if (next === "{") {
        result[key] = parseObject();
      } else if (next !== undefined) {
        result[key] = next;
      }
    }
    return result;
  }

  const rootKey = tokens[index++];
  if (!rootKey) {
    return {};
  }

  if (tokens[index] === "{") {
    index += 1;
    return { [rootKey]: parseObject() };
  }

  index = 0;
  return parseObject();
}

export function objectValue(value: string | VdfObject | undefined): VdfObject | undefined {
  return value && typeof value === "object" ? value : undefined;
}

export function stringValue(value: string | VdfObject | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stringifyEntries(obj: VdfObject, depth: number): string {
  const pad = "\t".repeat(depth);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      lines.push(`${pad}"${escapeString(key)}"\t\t"${escapeString(value)}"`);
    } else {
      lines.push(`${pad}"${escapeString(key)}"`);
      lines.push(`${pad}{`);
      lines.push(stringifyEntries(value, depth + 1));
      lines.push(`${pad}}`);
    }
  }
  return lines.join("\n");
}

export function stringifyVdf(obj: VdfObject): string {
  return `${stringifyEntries(obj, 0)}\n`;
}
