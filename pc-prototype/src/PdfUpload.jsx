import React, { useState } from 'react';

export function PdfUpload({ files, setFiles, disabled, maxBytes, keepValid = false }) {
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  async function select(event) {
    const input = event.currentTarget;
    const selected = Array.from(input.files);
    setFiles([]);
    setError('');
    if (selected.length > 30) {
      input.value = '';
      setError('每批最多选择 30 份 PDF。');
      return;
    }
    setChecking(true);
    try {
      const checked = await Promise.all(selected.map(async file => {
        if (!/\.pdf$/i.test(file.name) || await file.slice(0, 5).text() !== '%PDF-') return '文件格式无效';
        if (maxBytes && file.size > maxBytes) return '文件超过 ' + maxBytes / (1024 * 1024) + ' MB';
        return '';
      }));
      const invalid = selected.flatMap((file, index) => checked[index] ? [file.name + '（' + checked[index] + '）'] : []);
      if (invalid.length) {
        setError('无法选用：' + invalid.join('、'));
        if (!keepValid) {
          input.value = '';
          return;
        }
      }
      setFiles(selected.filter((_, index) => !checked[index]).map(file => ({
        file: file.type === 'application/pdf' ? file : new File([file], file.name, {
          type: 'application/pdf', lastModified: file.lastModified
        })
      })));
    } catch {
      input.value = '';
      setError('无法读取所选文件，请重新选择。');
    } finally {
      setChecking(false);
    }
  }

  return <>
    <label>选择 PDF 试卷<input type="file" name="source" accept=".pdf,application/pdf" multiple
      disabled={disabled || checking} onChange={select} /></label>
    {checking && <p role="status">正在检查 PDF…</p>}
    {error && <p role="alert">{error}</p>}
    {files.length > 0 && <>
      <p>已选 {files.length} 份 PDF。{files.length > 1 && '每份独立归档。'}</p>
      <ol aria-label="待上传 PDF">{files.map(({ file }, index) =>
        <li key={index}>{file.name}</li>)}</ol>
    </>}
  </>;
}

export function PdfScanGuide({ open = false }) {
  return <details open={open || undefined}>
    <summary>如何把纸质试卷扫描成 PDF？</summary>
    <ol>
      <li>打开手机上的文档扫描功能，选择「扫描文稿」或「扫描文档」。</li>
      <li>把同一套试卷逐页扫描进同一个文档，检查页码、四边和题目是否清晰完整。</li>
      <li>选择「保存为 PDF」或「导出 PDF」，传到这台电脑，再回到这里选择文件。</li>
    </ol>
    <p>每套试卷存成一份 PDF。上传前移除姓名、学号等个人信息。</p>
  </details>;
}
