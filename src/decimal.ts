interface Decimal { coefficient: bigint; scale: number }
const MAX_DIGITS = 1000;
export function parseDecimal(value: unknown): Decimal {
  if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value) || value.length > MAX_DIGITS) {
    throw new TypeError('Expected a decimal string (no exponent, separators or numeric floats)');
  }
  const [whole = '', fraction = ''] = value.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}
function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.coefficient * 10n ** BigInt(scale - a.scale), b.coefficient * 10n ** BigInt(scale - b.scale), scale];
}
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return { coefficient: x + y, scale };
}
export function formatDecimal(value: Decimal): string {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, '0');
  const text = value.scale ? `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, '') : digits;
  return `${negative ? '-' : ''}${text}`;
}
export function compareDecimal(left: unknown, right: unknown, tolerance: string): { equal: boolean; difference: string } {
  const a = parseDecimal(left), b = parseDecimal(right), t = parseDecimal(tolerance);
  if (t.coefficient < 0n) throw new TypeError('Tolerance must be nonnegative');
  const [x, y, scale] = align(a, b);
  const difference = { coefficient: x - y, scale };
  const absolute = { coefficient: difference.coefficient < 0n ? -difference.coefficient : difference.coefficient, scale };
  const [d, limit] = align(absolute, t);
  return { equal: d <= limit, difference: formatDecimal(difference) };
}
