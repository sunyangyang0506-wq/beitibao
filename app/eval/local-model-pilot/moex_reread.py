"""Reread the zh-Hant MOEX regression using a second, on-device OCR engine."""

import argparse
from difflib import SequenceMatcher
from pathlib import Path
import json
import re
import subprocess
from tempfile import TemporaryDirectory
import unicodedata
from run import MOEX, choice_text, read_json, save_json, sha256
from score import key, plain, QUESTION, OPTION, split_options

NATIVE = Path(__file__).with_name("native-ocr.swift")
RADIX=r'\(([0-9A-Fa-f]+(?:\.\d+)?)\)\s*_\s*(?:\{([0-9]{1,2})\}|([0-9]{1,2}))'
BASE_PLAIN=r'\(([0-9A-Fa-f]+(?:\.\d+)?)\)([0-9]{1,2})'
OPTION_HEAD=re.compile(r'^\s*(?:[（(]\s*A\s*[)）]?|A[)）.．、:：])\s*',re.U)

def swift(work, args, stdin=None):
    run = subprocess.run(
        ["swift", "-module-cache-path", str(work / "swift-cache"), str(NATIVE), *map(str, args)],
        check=True, text=True, input=stdin, stdout=subprocess.PIPE,
    )
    return [json.loads(line) for line in run.stdout.splitlines()]


def capture(work, baseline):
    pdf = MOEX / "trial-question-pages.pdf"
    subprocess.run(["pdftoppm", "-scale-to", "2400", "-png", str(pdf), str(work / "moex")], check=True)
    paths = [work / f"moex-{n}.png" for n in range(1, 5)]
    image_hashes = [sha256(path) for path in paths]
    for n, actual in enumerate(image_hashes, 1):
        recorded = read_json(baseline / f"paddle-moex-page-{n}.json")["imageSha256"]
        if recorded != actual:
            raise ValueError(f"Page {n} differs from the first OCR pass")
    pages = swift(work, paths)
    if [page["image"] for page in pages] != [path.name for path in paths]:
        raise ValueError("Incomplete second OCR pass")
    for page, image_hash in zip(pages, image_hashes, strict=True):
        page["imageSha256"] = image_hash
    return pages


def to_number(base):
    return '_' + ('{' + base + '}' if len(base)>1 else base)

def latex_formulas(text):
    text = re.sub(r'(?<!\$)\(([0-9A-Fa-f]+)\)\s*([₀-₉]{1,2})(?![₀-₉$])',
                  lambda m:'$('+m[1]+')'+to_number(unicodedata.normalize('NFKC',m[2]))+'$',text)
    text = re.sub(r'\$\s*([^\n$]{1,180}?)\s*\$', lambda m: m[1] if re.fullmatch(r'[\w \t+\-]+',m[1]) else m[0],text)
    text = re.sub(r'\\log_\{([0-9])\}',r'\\log_\1',text)
    text = re.sub(r'(?<!\$)'+RADIX+r'(?!\$)',lambda m:'$('+m[1]+')'+to_number(m[2] or m[3])+'$',text)
    if re.search(r'(?:[漢汉]明距[離离]|hamming distance)',text,re.I):
        text=re.sub(r'\(([01]{2,})\)\s*2(?!\d)',r'$(\1)_2$',text)
    return text

def native_stem(observations, question, y_min, y_max):
    # Vision boxes have their origin at the bottom-left; Paddle uses the top-left.
    lines=[(1-v['y']-v['h']/2,v['x'],v['text']) for v in observations if y_min<=1-v['y']-v['h']/2<y_max]
    rows=[]
    for y,x,t in sorted(lines):
        if not rows or y-rows[-1][0]>.008:
            rows.append((y,[]))
        rows[-1][1].append((x,t))
    body=[]
    for _,segments in rows:
        if any(OPTION_HEAD.match(t) for _,t in segments) or (
            body and re.search(r'[?？]$',body[-1].strip()) and any(x>.23 for x,_ in segments)):
            break
        line=' '.join(t for _,t in sorted(segments))
        if not body:
            line=re.sub(rf'^\s*{question}\b\s*','',line)
        if line:
            body.append(line)
    return '\n'.join(body)

def unique_equal(old,new):
    same=SequenceMatcher(None,key(old),key(new),autojunk=False)
    ops=same.get_opcodes()
    diffs=[(i,j,k,l) for tag,i,j,k,l in ops if tag!='equal']
    # A second engine can replace a single implausible glyph or restore an omitted suffix,
    # when the rest of the two readings matches and the new reading ends the question.
    compact_old,compact_new=key(old),key(new)
    if diffs and compact_new.endswith('?') and len(compact_old)>=24:
        if len(diffs)==1:
            i,j,k,l=diffs[0]
            if same.ratio()>=.95 and j-i==l-k==1 and re.fullmatch(r'[\u3400-\u9fff]{2}',compact_old[i:j]+compact_new[k:l]):
                # Preserve the first engine's spaces, punctuation, and line breaks.
                if ''.join(map(key, old)) != compact_old:
                    return old
                seen=0
                for at,char in enumerate(old):
                    if seen==i and key(char):
                        return old[:at]+compact_new[k:l]+old[at+1:]
                    seen+=len(key(char))
            if j==len(compact_old) and i==j and len(compact_old)>=28 and 2<=l-k<=20:
                return new
    return old

def confirm_hant(old, new, native):
    old_key, new_key, native_key = key(old), key(new), key(native)
    if len(old_key)!=len(new_key):
        return old
    if ''.join(map(key, old)) != old_key:
        return old
    result=[]
    idx=0
    for char in old:
        chunk=key(char)
        if len(chunk)==1 and chunk!=new_key[idx] and re.fullmatch(r'[\u3400-\u9fff]',new_key[idx]):
            if any(new_key[max(0,idx-left):idx+1+right] in native_key
                   and len(new_key[max(0,idx-left):idx+1+right])>=min(3,len(new_key))
                   for left,right in ((4,4),(0,4),(4,0),(2,2))):
                char=new_key[idx]
        result.append(char)
        idx+=len(chunk)
    return ''.join(result)

def identifier_order(text, stem):
    # Printed names used in the question remain literal identifiers, even when
    # the OCR formatted the ordering as a LaTeX comparison.
    atom=r'[A-Z]_\{\d{1,2}\}'
    pattern=rf'\$\s*({atom}(?:\s*[><]\s*{atom})*)\s*\$'
    def compare(match):
        ids=re.findall(r'([A-Z])_\{(\d{1,2})\}',match[1])
        if ids and all(re.search(rf'(?<![A-Za-z0-9]){a}{n}(?![A-Za-z0-9])',stem) for a,n in ids):
            return re.sub(r'([A-Z])_\{(\d{1,2})\}',r'\1\2',match[1])
        return match[0]
    return re.sub(pattern,compare,text)

def recover_options(q):
    stem=q['stem']; opts=q['options']
    # Accept an explicit A with one lost delimiter only when B,C,D are present,
    # A is after the complete stem, and there are no competing labels.
    if not opts:
        marker=re.search(r'([？?])\s*[(（]\s*A\s*(?=[^）)\s])',stem)
        if marker:
            proposed=stem[:marker.end()]+')'+stem[marker.end():]
            markers=[unicodedata.normalize('NFKC',m[1] or m[2]) for m in OPTION.finditer(proposed)]
            if markers==list('ABCD'):
                stem,opts=split_options(proposed)
    a=opts.get('A','')
    duplicate=re.fullmatch(r'(.+?)\s*\([Aa]\)\s*(.+)',a,re.S)
    if duplicate and key(duplicate[1])==key(duplicate[2]):
        opts={**opts,'A':duplicate[1].strip()}
    return stem,opts

def notation_from_native(old,native):
    pattern=rf'^\s*{BASE_PLAIN}\s*[×x]\s*{BASE_PLAIN}\s*=\s*[？?]\s*$'
    match=re.fullmatch(pattern,unicodedata.normalize('NFKC',native))
    if match and re.search(r'\\times|×',old) and re.findall(r'\(([0-9A-Fa-f]+)\)',old)==[match[1],match[3]]:
        digits=[(match[1],match[2]),(match[3],match[4])]
        try:
            for number,base in digits:
                int(number,int(base))
        except ValueError:
            return old
        return '$'+'\\times'.join('('+n+')'+to_number(b) for n,b in digits)+'=?$'
    return old

def reread(work, source, output):
    baseline = read_json(source / "moex-ocr-parsed.json")
    native = capture(work, source)
    save_json(output / "moex-vision-reread.json", native)
    cases=[]
    for p,n in zip(baseline,native,strict=True):
        data=read_json(source/f"paddle-moex-page-{p['page']}.json")['result']
        blocks=data['parsing_res_list']
        bounds=[]
        for block in blocks:
            m=QUESTION.match(plain(block['block_content']))
            if m:
                bounds.append((int(m[1]),block['block_bbox'][1]/data['height']))
        y_by_number=dict(bounds)
        for q in p['candidates']:
            stem,opts=recover_options(q)
            start=y_by_number.get(q['number'])
            if start is not None:
                stop=min([y for _,y in bounds if y>start]+[1])
                vision=native_stem(n['lines'],q['number'],start-.004,stop-.004)
                all_native=' '.join(t['text'] for t in n['lines']
                    if start-.004<=1-t['y']-t['h']/2<stop-.004)
            else:
                vision=all_native=''
            q['stem'],q['options'],q['vision'],q['all_native']=stem,opts,vision,all_native
    targets=[(q,'stem',q) for p in baseline for q in p['candidates']]+[(q['options'],o,q) for p in baseline for q in p['candidates'] for o in q['options']]
    texts = [json.dumps(item[k], ensure_ascii=False) for item, k, _ in targets]
    transformed = swift(work, ["traditional"], "\n".join(texts) + "\n")
    for (item,k,q),v in zip(targets,transformed,strict=True):
        item[k]=latex_formulas(confirm_hant(item[k],v,q['all_native']))
        if k!='stem':
            item[k]=identifier_order(item[k],q['stem'])
    for p in baseline:
        for q in p['candidates']:
            vision=q.pop('vision')
            q.pop('all_native')
            old=q['stem']
            q['stem']=notation_from_native(unique_equal(old,vision),vision)
            if len(q['options'])==4 and all(q['options'].values()):
                cases.append({"id":f"moex-e2e-p{p['page']}-{q['number']:02}","kind":"choice","text":choice_text(q['stem'],q['options'])})
    save_json(output/'moex-ocr-parsed.json',baseline)
    save_json(output/'moex-e2e-inputs.json',cases)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Original Paddle OCR run")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error("Write the reread to a new result directory")
    with TemporaryDirectory(prefix="beitibao-moex-ocr-") as directory:
        reread(Path(directory), args.source, args.output)


if __name__ == "__main__":
    main()
