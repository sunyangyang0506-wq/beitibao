import json,unicodedata,re,sys
from pathlib import Path
d=Path('app/eval/urjc-2025-pilot')
q=json.loads((d/'question-text.json').read_text())
report=sys.argv[1] if len(sys.argv)>1 else 'results-whole-paper.json'
r=json.loads((d/report).read_text())
if question := r.get('input', {}).get('question'):
 q={question:q[question]}
norm=lambda s:re.sub(r'\s+','',unicodedata.normalize('NFKC',s).translate(str.maketrans({'“':'"','”':'"','–':'-','—':'-'})))
total=bad=0
stems={}
for s in (r.get('recognition') or {}).get('stems', []):
 m=re.search(r'\b([12]\.[1-5])\b',s)
 if m: stems[m[1]]=s
for id,blocks in q.items():
 a=norm('\n'.join(s for s in blocks if not s.startswith('@')))
 b=norm(stems.get(id,''))
 prev=list(range(len(b)+1))
 for i,x in enumerate(a,1):
  curr=[i]
  for j,y in enumerate(b,1): curr.append(min(curr[-1]+1,prev[j]+1,prev[j-1]+(x!=y)))
  prev=curr
 total+=len(a);bad+=prev[-1]
 print(id,len(a),prev[-1])
print('text',total,bad,100*(1-bad/total))
for file in ((report,) if len(sys.argv)>1 else ('results-whole-paper-timeout.json','results-whole-paper-batch-timeout.json','results-whole-paper.json')):
 calls=json.loads((d/file).read_text())['calls']
 prices={'qwen3.5-flash-2026-02-23':(.2,2),'qwen3-vl-plus':(1,10)}
 i=o=0;cost=0
 for c in calls:
  if 'usage' not in c:continue
  u=c['usage'];ti=u['prompt_tokens'];to=u['completion_tokens'];i+=ti;o+=to
  pi,po=prices[c['model']];cost+=(ti*pi+to*po)/1e6
 print(file,len(calls),i,o,cost)
