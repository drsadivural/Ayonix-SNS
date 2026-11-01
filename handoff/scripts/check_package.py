from pathlib import Path
import json
import re

ROOT=Path(__file__).resolve().parents[1]
required=['README.md','START_HERE.md','CLAUDE.md','contracts/pricing.json','contracts/mcp-tools.json','reference/domain.mjs','reference/schema.sql','design/index.html','design/design-overview.pdf','evidence/STATUS.md']
for item in required:
    p=ROOT/item
    assert p.is_file() and p.stat().st_size>0, f'Missing/empty {item}'
docs=list((ROOT/'docs').glob('*.md'));assert len(docs)==12,f'Expected 12 docs, got {len(docs)}'
for doc in docs:
    for ref in re.findall(r'(?:docs|contracts|reference|evidence|design)/[\w.-]+\.(?:md|json|mjs|sql|html|pdf)',doc.read_text()):
        assert (ROOT/ref).is_file(),f'Broken reference {ref} in {doc.name}'
tools=json.loads((ROOT/'contracts/mcp-tools.json').read_text())['tools'];assert len(tools)==17
assert len({x['name'] for x in tools})==17
assert not any('checkout' in x['name'] or 'payment' in x['name'] for x in tools)
for tool in tools:
    assert tool['inputSchema']['additionalProperties'] is False
    assert set(tool['inputSchema']['required'])<=set(tool['inputSchema']['properties'])
screens=json.loads((ROOT/'design/screens.json').read_text());assert len(screens)==13
for screen in screens:assert (ROOT/'design'/screen['file']).read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
html=(ROOT/'design/index.html').read_text();assert '__CATALOG__' not in html and '__BUTTONS__' not in html
assert 'Example data' in html and 'No social accounts connected' in html
print(f'PASS package integrity: {len(docs)} docs, {len(tools)} tool schemas, {len(screens)} PNG mockups, required artifacts and links')
