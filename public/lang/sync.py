import json
import re
from pathlib import Path

KV_RE = re.compile(
    r'^(\s*)'
    r'("(?:[^"\\]|\\.)*")'
    r'(\s*:\s*)'
    r'("(?:[^"\\]|\\.)*")'
    r'(.*)$'
)

ZH_NAME = 'zh-CN.jsonc'
PATTERN = '*.jsonc'

def parse_pairs(text):
    pairs = {}
    for line in text.splitlines():
        m = KV_RE.match(line)
        if not m:
            continue
        pairs[json.loads(m.group(2))] = json.loads(m.group(4))
    return pairs


def rebuild(zh_text, other_pairs):
    out = []
    for line in zh_text.split('\n'):
        m = KV_RE.match(line)
        if m:
            indent, key_q, colon, _old_val_q, rest = m.groups()
            key = json.loads(key_q)
            new_val_q = json.dumps(other_pairs.get(key, ''), ensure_ascii=False)
            out.append(f'{indent}{key_q}{colon}{new_val_q}{rest}')
        else:
            out.append(line)
    return '\n'.join(out)


def main():
    here = Path(__file__).resolve().parent
    zh_path = here / ZH_NAME
    zh_text = zh_path.read_text(encoding='utf-8')
    zh_resolved = zh_path.resolve()

    for tgt_path in sorted(here.glob(PATTERN)):
        if tgt_path.resolve() == zh_resolved:
            continue
        if tgt_path.exists():
            other_pairs = parse_pairs(tgt_path.read_text(encoding='utf-8'))
        else:
            other_pairs = {}
        tgt_path.write_text(rebuild(zh_text, other_pairs), encoding='utf-8')
        print(f'[ok] {tgt_path.name}')
        
if __name__ == '__main__':
    main()