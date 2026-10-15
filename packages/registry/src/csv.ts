/** Preserve scientific f64 values, including signed zero, and exact source labels. */
export function csvRow(values: (string | number)[]): string {
  return values.map((value) => {
    const text = typeof value === 'number' && Object.is(value, -0) ? '-0' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',');
}
