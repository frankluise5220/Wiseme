export async function extractSpreadsheetText(content: Buffer) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(content, { type: "buffer", cellDates: true });
  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    const lines = rows
      .map((row) => row.map((cell) => String(cell ?? "").trim()).join("\t").trimEnd())
      .filter((line) => line.trim());
    if (lines.length > 0) sections.push(`【工作表：${sheetName}】\n${lines.join("\n")}`);
  }

  return sections.join("\n\n").trim();
}
