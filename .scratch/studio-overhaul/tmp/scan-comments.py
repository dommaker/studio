import os, re
roots = ['apps/api/src','apps/web/src','packages','scripts','tests']
skip = ('node_modules','/dist/','.git','__tests__')
codey = re.compile(r'(=>|\bconst\b|\blet\b|\bvar\b|\bfunction\b|\bimport\b|\breturn\b|\bif\s*\(|\bfor\s*\(|\}\)|;\s*$|\{\s*$|\)\s*\{)')
out=[]
for root in roots:
    for dp,dn,fn in os.walk(root):
        if any(s in dp for s in skip): continue
        for f in fn:
            if not f.endswith(('.ts','.tsx','.js','.mjs')): continue
            p=os.path.join(dp,f)
            try: lines=open(p,encoding='utf-8',errors='ignore').read().splitlines()
            except: continue
            i=0
            while i < len(lines):
                if re.match(r'^\s*//', lines[i]):
                    j=i
                    while j < len(lines) and re.match(r'^\s*//', lines[j]): j+=1
                    block=lines[i:j]
                    if len(block)>=10:
                        codeish=[l for l in block if codey.search(l)]
                        if len(codeish) >= 0.4*len(block):
                            out.append(f"{p}:{i+1}-{j} ({len(block)} 行注释块, {len(codeish)} 行疑似代码)")
                    i=j
                else: i+=1
print('\n'.join(out))
print(f"---\n共 {len(out)} 处疑似注释代码块")
