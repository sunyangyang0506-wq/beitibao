export function samplePaper(withScan = false, secondPageAnswerKey = '') {
  const content = 'BT /F1 20 Tf 52 750 Td (1. Explain the difference between a stack and a queue.) Tj ET\n';
  const scan = 'q 500 0 0 700 40 60 cm BI /W 4 /H 4 /BPC 8 /CS /G /F /AHx ID 00FFFF00FF0000FFFF0000FF00FFFF00> EI Q\n';
  const answerKey = secondPageAnswerKey ? 'BT /F1 20 Tf 52 750 Td (' + secondPageAnswerKey + ') Tj ET\n' : scan;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    withScan ? '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>' : '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    ...(withScan ? ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
      `<< /Length ${answerKey.length} >>\nstream\n${answerKey}endstream`] : [])
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}
