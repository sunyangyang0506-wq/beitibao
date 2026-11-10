import json,re,unicodedata,collections,difflib,sys
from pathlib import Path
d=Path('app/eval/urjc-2025-pilot')
q=json.loads((d/'question-text.json').read_text())
r=json.loads((d/(sys.argv[1] if len(sys.argv)>1 else 'results.json')).read_text())
def norm(s):
 return re.sub(r'\s+','',unicodedata.normalize('NFKC',s).translate(str.maketrans({'“':'"','”':'"','–':'-','—':'-'})))
u=collections.defaultdict(lambda:[0,0,0])
total=bad=0
for row in r:
 id=row['id']
 ref=norm('\n'.join(x for x in q[id] if not x.startswith('@')))
 rec=norm('\n'.join(row.get('recognition',{}).get('stems',[])))
 def dist(a,b):
  prev=list(range(len(b)+1))
  for i,x in enumerate(a,1):
   curr=[i]
   for j,y in enumerate(b,1):curr.append(min(curr[-1]+1,prev[j]+1,prev[j-1]+(x!=y)))
   prev=curr
  return prev[-1]
 e=dist(ref,rec);total+=len(ref);bad+=e
 print(id,len(ref),e,[(op,ref[a:b],rec[c:f]) for op,a,b,c,f in difflib.SequenceMatcher(None,ref,rec,autojunk=False).get_opcodes() if op!='equal'][:10])
 for m,v in [('qwen3.5-flash-2026-02-23',row.get('recognitionUsage')),(row.get('solution',{}).get('model'),row.get('solution',{}).get('usage'))]:
  if v:
   t=u[m];t[0]+=1;t[1]+=v['prompt_tokens'];t[2]+=v['completion_tokens']
print('char',total,bad,1-bad/total)
prices={'qwen3.5-flash-2026-02-23':(.2,2),'qwen-plus-2025-12-01':(.8,2),'qwen3-vl-plus':(1,10)}
print([(m,t,(t[1]*prices[m][0]+t[2]*prices[m][1])/1e6) for m,t in u.items()])
