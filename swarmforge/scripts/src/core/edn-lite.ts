// Minimal EDN reader/writer for SwarmForge state files written by the bb helpers.
// Supports: nil, booleans, integers, strings, keywords (as ":name" strings when used as
// values), maps with keyword or string keys (keyword keys become plain names), vectors,
// lists. Anything else is a parse error.

export type Edn = null | boolean | number | string | Edn[] | { [key: string]: Edn };

export class EdnError extends Error {}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
const SYMBOLS: Record<string, Edn> = { nil: null, true: true, false: false };

function parseScalar(token: string): Edn | undefined {
  if (token in SYMBOLS) return SYMBOLS[token];
  if (/^[-+]?[0-9]+N?$/.test(token)) return Number(token.replace(/N$/, ""));
  if (/^[-+]?[0-9]*\.[0-9]+(?:[eE][-+]?[0-9]+)?M?$/.test(token)) return Number(token.replace(/M$/, ""));
  return undefined;
}

class Reader {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  read(): Edn {
    const value = this.value();
    this.skip();
    if (this.pos < this.text.length) throw new EdnError(`Trailing input at ${this.pos}`);
    return value;
  }

  private skip(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === ";") {
        while (this.pos < this.text.length && this.text[this.pos] !== "\n") this.pos++;
      } else if (/[\s,]/.test(ch)) {
        this.pos++;
      } else {
        return;
      }
    }
  }

  private value(): Edn {
    this.skip();
    const ch = this.text[this.pos];
    if (ch === undefined) throw new EdnError("Unexpected end of input");
    const compound = this.compound(ch);
    if (compound !== undefined) return compound;
    if (ch === ":") return `:${this.token(1)}`;
    const token = this.token(0);
    const scalar = parseScalar(token);
    if (scalar === undefined) throw new EdnError(`Unsupported token '${token}' at ${this.pos}`);
    return scalar;
  }

  private compound(ch: string): Edn | undefined {
    if (ch === "{") return this.map();
    if (ch === "[") return this.seq("]");
    if (ch === "(") return this.seq(")");
    if (ch === '"') return this.string();
    return undefined;
  }

  private token(offset: number): string {
    const start = this.pos + offset;
    let end = start;
    while (end < this.text.length && !/[\s,{}[\]()"]/.test(this.text[end]!)) end++;
    if (end === start) throw new EdnError(`Empty token at ${start}`);
    this.pos = end;
    return this.text.slice(start, end);
  }

  private string(): string {
    let out = "";
    this.pos++;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos++]!;
      if (ch === '"') return out;
      out += ch === "\\" ? this.escape() : ch;
    }
    throw new EdnError("Unterminated string");
  }

  private escape(): string {
    const esc = this.text[this.pos++];
    if (esc === undefined) throw new EdnError("Unterminated escape");
    if (esc !== "u") return ESCAPES[esc] ?? esc;
    const code = parseInt(this.text.slice(this.pos, this.pos + 4), 16);
    this.pos += 4;
    return String.fromCharCode(code);
  }

  private seq(close: string): Edn[] {
    this.pos++;
    const items: Edn[] = [];
    for (;;) {
      this.skip();
      if (this.text[this.pos] === close) {
        this.pos++;
        return items;
      }
      items.push(this.value());
    }
  }

  private map(): { [key: string]: Edn } {
    this.pos++;
    const out: { [key: string]: Edn } = {};
    for (;;) {
      this.skip();
      if (this.text[this.pos] === "}") {
        this.pos++;
        return out;
      }
      const key = this.value();
      if (typeof key !== "string") throw new EdnError("Only keyword or string map keys are supported");
      out[key.startsWith(":") ? key.slice(1) : key] = this.value();
    }
  }
}

export function readEdn(text: string): Edn {
  return new Reader(text).read();
}

function writeString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r")}"`;
}

/** Write `value` as EDN; object keys become keywords. */
export function writeEdn(value: Edn | undefined): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return writeString(value);
  if (Array.isArray(value)) return `[${value.map(writeEdn).join(" ")}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => `:${key} ${writeEdn(item)}`)
    .join(", ")}}`;
}

const isNil = (value: Edn | undefined): value is null | undefined => value === undefined || value === null;
type EdnMap = { [key: string]: Edn };
const isMap = (value: Edn): value is EdnMap => typeof value === "object" && value !== null && !Array.isArray(value);

function seqEqual(a: Edn[], b: Edn[]): boolean {
  return a.length === b.length && a.every((item, i) => ednEqual(item, b[i]));
}

function mapEqual(a: EdnMap, b: EdnMap): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && ednEqual(a[key], b[key]));
}

export function ednEqual(a: Edn | undefined, b: Edn | undefined): boolean {
  if (isNil(a) || isNil(b)) return isNil(a) && isNil(b);
  if (Array.isArray(a)) return Array.isArray(b) && seqEqual(a, b);
  if (isMap(a)) return isMap(b) && mapEqual(a, b);
  return a === b;
}
