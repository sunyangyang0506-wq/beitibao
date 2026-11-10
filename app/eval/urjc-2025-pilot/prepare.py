from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import zipfile,xml.etree.ElementTree as E,io,json,re,hashlib
root=Path('app/eval')
doc=root/'source-materials/ocw-candidates/urjc-data-structures/2025-05-12-with-solutions.docx'
assert hashlib.sha256(doc.read_bytes()).hexdigest()=='542ae7903d712e5af940e7b046cc84d21926869180742369ded28c6965996375'
z=zipfile.ZipFile(doc)
n={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
blocks=list(E.fromstring(z.read('word/document.xml')).find('w:body',n))
def text(e): return ''.join(x.text or '' for x in e.findall('.//w:t',n))
def p(i): return text(blocks[i]).strip()
def col(i): return [text(row.findall('w:tc',n)[0]).strip() for row in blocks[i].findall('w:tr',n)]
questions={
'1.1':[p(3),'@image1.png',p(6),*col(8)],
'1.2':[p(10)],
'1.3':[p(13),'Matriz de adyacencia | Lista de adyacencia','Ventajas | Desventajas'],
'1.4':[p(19),'@image2.png',p(23),p(32),p(39)],
'1.5':[p(43),'Árbol inicial:','@image3.png'],
'2.1':[p(i) for i in [53,55,56,57,58,59,61,62,63,66,67]]+['@image5.png'],
'2.2':[p(i) for i in [72,74,75,76,77,78,79,81,83,85,91,93,95]]+['@image6.jpeg'],
'2.3':[p(102),p(104),'@image7.jpg',*[p(i) for i in [106,109,110,112,113,115,116,117,118,119,122,127]]],
}
out=root/'urjc-2025-pilot'
(out/'inputs').mkdir(exist_ok=True)
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',25)
small=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',17)
diagram_boxes = {}
for q,blocks in questions.items():
 canvas=Image.new('RGB',(1080,3500),'white'); d=ImageDraw.Draw(canvas); y=36
 for b in blocks:
  if b.startswith('@'):
   im=Image.open(io.BytesIO(z.read('word/media/'+b[1:]))).convert('RGBA')
   im.thumbnail((750,450))
   diagram_boxes[q] = (48, y, 48 + im.width, y + im.height)
   canvas.paste(im,(48,y),im); y+=im.height+18; continue
  assert not re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{8}[A-Z]\b',b)
  line=''
  for word in b.split():
   candidate=(line+' '+word).strip()
   if d.textlength(candidate,font=font)>984 and line:
    d.text((48,y),line,fill='black',font=font);y+=33;line=word
   else: line=candidate
  if line: d.text((48,y),line,fill='black',font=font);y+=43
 d.text((48,y+6),'URJC · Estructuras de Datos · 12-05-2025 · CC BY-SA 4.0 · Adaptación sin soluciones',fill='black',font=small)
 d.text((48,y+30),'Sergio Cavero Díaz y Salvador Sánchez Alonso · burjcdigital.urjc.es · Material docente',fill='black',font=small)
 canvas.crop((0,0,1080,y+65)).save(out/'inputs'/f'{q}.png')
 for b in blocks:
  if b.startswith('@'):
   im=Image.open(io.BytesIO(z.read('word/media/'+b[1:]))).convert('RGB')
   im.save(out/'inputs'/f'{q}-diagram.png')
(out/'question-text.json').write_text(json.dumps(questions,ensure_ascii=False,indent=2)+'\n')

# The image upload endpoint accepts one image. Lay out the same eight inputs
# in two reading columns to keep the full paper within its pixel limit.
panels = [Image.open(out/'inputs'/f'{qid}.png') for qid in questions]
columns = (panels[:4], panels[4:])
whole = Image.new('RGB', (2 * panels[0].width, max(sum(im.height for im in col) for col in columns)), 'white')
for index, column in enumerate(columns):
    y = 0
    for qid, panel in zip(list(questions)[4*index:4*(index+1)], column):
        if qid in diagram_boxes:
            x1,y1,x2,y2 = diagram_boxes[qid]
            diagram_boxes[qid] = [round(n * 1000 / dim) for n,dim in zip(
                (x1 + index * panel.width, y1 + y, x2 + index * panel.width, y2 + y),
                (whole.width, whole.height, whole.width, whole.height))]
        whole.paste(panel, (index * panels[0].width, y))
        y += panel.height
whole.save(out/'whole-paper.png')
(out/'figure-boxes.json').write_text(json.dumps(diagram_boxes, indent=2)+'\n')
