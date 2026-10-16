export function csvCell(value: string): string {
  let cell = value.replace(/[\r\n]/g, ' ')
  if (/^[=+\-@\t]/.test(cell)) cell = `'${cell}`
  if (/[",]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`
  return cell
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => csvCell(cell)).join(',')).join('\r\n')
}
