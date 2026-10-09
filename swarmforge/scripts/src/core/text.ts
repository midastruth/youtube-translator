// String helpers with Clojure `clojure.string` semantics where the bb code relied on them.

/** `str/split-lines` (Java split semantics): "" -> [""], trailing empty strings dropped. */
export function splitLines(text: string): string[] {
  if (text === "") return [""];
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function isBlank(value: string | undefined | null): boolean {
  return value == null || value.trim() === "";
}

/** `(not-empty s)`: undefined for "" / undefined. */
export function notEmpty(value: string | undefined | null): string | undefined {
  return value ? value : undefined;
}

/** Split once on `sep`, like `(str/split s re 2)`. */
export function splitOnce(text: string, sep: string): [string, string | undefined] {
  const index = text.indexOf(sep);
  return index < 0 ? [text, undefined] : [text.slice(0, index), text.slice(index + sep.length)];
}

/** Single-quote for POSIX shells. */
export function sq(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function trimEnd(text: string): string {
  return text.replace(/\s+$/, "");
}

/** Header block (lines before the first blank line) as a map; a repeated key keeps the last value. */
export function headerMap(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of splitLines(text)) {
    if (isBlank(line)) break;
    const [key, value] = splitOnce(line, ": ");
    if (key && value !== undefined) headers.set(key, value);
  }
  return headers;
}

/** Java `String.split(regex)` without a limit: trailing empty strings are dropped ("" -> [""]). */
export function javaSplit(text: string, sep: string): string[] {
  if (text === "") return [""];
  const parts = text.split(sep);
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
