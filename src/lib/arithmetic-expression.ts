/**
 * Safe arithmetic expression evaluator (no eval, no Function constructor).
 *
 * Supports `+ - * / ( )` with plain decimal numbers; returns null on any
 * invalid input (unbalanced parentheses, unknown characters, division by zero,
 * non-finite results). Shared by the client calculator (CalcInput) and the
 * server-side batch-update amount expression parsing.
 */
export function evaluateArithmeticExpression(expression: string): number | null {
  const s = expression.replace(/\s+/g, "");
  if (!s) return null;
  let pos = 0;

  function parseNumber(): number | null {
    const m = /^\d+(?:\.\d+)?/.exec(s.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return parseFloat(m[0]);
  }

  function parseFactor(): number | null {
    let sign = 1;
    if (s[pos] === "-") { sign = -1; pos++; }
    else if (s[pos] === "+") { pos++; }
    if (s[pos] === "(") {
      pos++;
      const inner = parseAddSub();
      if (inner === null || s[pos] !== ")") return null;
      pos++;
      return sign * inner;
    }
    const n = parseNumber();
    return n === null ? null : sign * n;
  }

  function parseMulDiv(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    while (pos < s.length && (s[pos] === "*" || s[pos] === "/")) {
      const op = s[pos];
      pos++;
      const right = parseFactor();
      if (right === null) return null;
      if (op === "*") left *= right;
      else {
        if (right === 0) return null;
        left /= right;
      }
    }
    return left;
  }

  function parseAddSub(): number | null {
    let left = parseMulDiv();
    if (left === null) return null;
    while (pos < s.length && (s[pos] === "+" || s[pos] === "-")) {
      const op = s[pos];
      pos++;
      const right = parseMulDiv();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  const value = parseAddSub();
  if (value === null || pos !== s.length || !Number.isFinite(value)) return null;
  return value;
}
