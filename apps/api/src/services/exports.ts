import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * Report serialisers. CSV and XLSX are generated from the same row matrix so
 * the formats cannot drift apart; PDF is a simple portrait table with the
 * institution header and a generated-at stamp.
 */

export interface TableData {
  title: string;
  subtitle: string;
  columns: { key: string; label: string; width?: number }[];
  rows: Record<string, string | number | null>[];
  footer?: string;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(data: TableData): string {
  const header = data.columns.map((column) => csvCell(column.label)).join(',');
  const body = data.rows.map((row) =>
    data.columns.map((column) => csvCell(row[column.key] ?? null)).join(','),
  );
  // BOM keeps Excel from mangling non-ASCII names.
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

export async function toXlsx(data: TableData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Attend';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(data.title.slice(0, 31));
  sheet.columns = data.columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: column.width ?? 18,
  }));

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };

  for (const row of data.rows) sheet.addRow(row);

  sheet.insertRow(1, []);
  sheet.getRow(1).values = [];
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function toPdf(data: TableData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'portrait' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      doc.fontSize(16).text(data.title, { align: 'left' });
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#555555').text(data.subtitle);
      doc.moveDown(0.6);
      doc.fillColor('#000000');

      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const totalWeight = data.columns.reduce((sum, column) => sum + (column.width ?? 18), 0);
      const widths = data.columns.map((column) => ((column.width ?? 18) / totalWeight) * usableWidth);

      const drawRow = (cells: string[], bold = false): void => {
        const y = doc.y;
        let x = doc.page.margins.left;
        doc.fontSize(8).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        cells.forEach((cell, index) => {
          doc.text(cell, x, y, { width: widths[index], ellipsis: true, lineBreak: false });
          x += widths[index]!;
        });
        doc.y = y + 12;
      };

      drawRow(data.columns.map((column) => column.label), true);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke('#cccccc');
      doc.moveDown(0.2);

      for (const row of data.rows) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
          doc.addPage();
          drawRow(data.columns.map((column) => column.label), true);
        }
        drawRow(data.columns.map((column) => String(row[column.key] ?? '')));
      }

      if (data.footer) {
        doc.moveDown(0.8);
        doc.fontSize(8).fillColor('#555555').text(data.footer);
      }
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export const CONTENT_TYPES: Record<'csv' | 'xlsx' | 'pdf', string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};
