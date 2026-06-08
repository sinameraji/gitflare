// A tiny YAML-subset parser — just enough for `.gitflare/deploy.yml`. We avoid
// a full YAML library (~200KB) to keep the worker bundle lean. Supports:
//   - nested maps (`key:` then indented children)
//   - block lists (`- item`), including lists of maps
//   - scalars: strings, numbers, booleans, null
//   - inline lists: `[a, b, c]`
//   - quoted strings, `#` comments, blank lines
// NOT supported (and not needed here): anchors, multi-line scalars, flow maps,
// multiple documents. Anything outside the subset parses on a best-effort basis.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

export function parseYaml(src: string): YamlValue {
  const lines: Line[] = [];
  for (const raw of src.split(/\r?\n/)) {
    if (raw.trim().startsWith("#")) continue;
    const noComment = stripComment(raw);
    if (!noComment.trim()) continue;
    lines.push({
      indent: noComment.length - noComment.trimStart().length,
      text: noComment.trimEnd(),
    });
  }
  if (lines.length === 0) return null;
  const [value] = parseBlock(lines, 0, lines[0]!.indent);
  return value;
}

// Returns [parsed value, next line index].
function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  if (start >= lines.length) return [null, start];
  const first = lines[start]!;
  if (first.indent < indent) return [null, start];
  return first.text.trimStart().startsWith("- ")
    ? parseList(lines, start, indent)
    : parseMap(lines, start, indent);
}

function parseList(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.trimStart().startsWith("- ")) {
    const rest = lines[i]!.text.trimStart().slice(2).trim();
    // The content after "- " sits at a virtual indent past the dash.
    const itemIndent = lines[i]!.indent + 2;
    if (rest === "") {
      // Nested block on following lines.
      const [val, next] = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? itemIndent);
      out.push(val);
      i = next;
    } else if (isMapEntry(rest)) {
      // List item is a map whose first key is inline with the dash.
      const synthetic: Line[] = [{ indent: itemIndent, text: rest }];
      // Pull in subsequent lines indented under the item.
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= itemIndent) {
        synthetic.push(lines[j]!);
        j++;
      }
      const [val] = parseMap(synthetic, 0, itemIndent);
      out.push(val);
      i = j;
    } else {
      out.push(scalar(rest));
      i++;
    }
  }
  return [out, i];
}

function parseMap(lines: Line[], start: number, indent: number): [{ [k: string]: YamlValue }, number] {
  const out: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!.text.trim();
    const colon = splitKey(line);
    if (!colon) break;
    const { key, value } = colon;
    if (value === "") {
      // Value is a nested block on the following more-indented lines.
      const childIndent = lines[i + 1]?.indent ?? indent + 1;
      if (i + 1 < lines.length && childIndent > indent) {
        const [val, next] = parseBlock(lines, i + 1, childIndent);
        out[key] = val;
        i = next;
      } else {
        out[key] = null;
        i++;
      }
    } else {
      out[key] = scalar(value);
      i++;
    }
  }
  return [out, i];
}

function isMapEntry(s: string): boolean {
  return splitKey(s) !== null;
}

// Split "key: value" on the first ": " (or trailing ":"). Returns null if the
// line isn't a map entry (e.g. an inline list or bare scalar).
function splitKey(s: string): { key: string; value: string } | null {
  const m = s.match(/^([A-Za-z0-9_./-]+):(?:\s+(.*))?$/);
  if (!m) return null;
  return { key: m[1]!, value: (m[2] ?? "").trim() };
}

function scalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((x) => scalar(x));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    // Inline flow map: { key: value, key2: value2 } (flat — no nested commas).
    const inner = s.slice(1, -1).trim();
    const obj: { [k: string]: YamlValue } = {};
    if (!inner) return obj;
    for (const pair of inner.split(",")) {
      const idx = pair.indexOf(":");
      if (idx === -1) continue;
      const key = pair.slice(0, idx).trim().replace(/^["']|["']$/g, "");
      obj[key] = scalar(pair.slice(idx + 1));
    }
    return obj;
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function stripComment(line: string): string {
  // Drop a trailing comment that isn't inside quotes. Simple scan.
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}
