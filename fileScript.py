import os, re

root = r"force-app\main\default\customMetadata"
pattern = re.compile(
    r'(<values>\s*<field>\s*DD_inbound__c\s*</field>\s*<value\b[^>]*?>)\s*(true|false)?\s*(</value>\s*</values>)',
    re.IGNORECASE | re.DOTALL
)

def fix_attrs(value_open_tag: str) -> str:
    # Ensure xsi:type="xsd:boolean" and drop any xsi:nil
    # add type if missing; replace nil if present
    tag = re.sub(r'\s+xsi:nil="true"', '', value_open_tag)
    if re.search(r'\sxsi:type="xsd:boolean"', tag, re.IGNORECASE) is None:
        if tag.endswith('>'):
            tag = tag[:-1] + ' xsi:type="xsd:boolean">'
    return tag

def update_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        txt = f.read()

    def repl(m):
        open_tag = fix_attrs(m.group(1))
        return f"{open_tag}true{m.group(3)}"

    new = pattern.sub(repl, txt)
    if new != txt:
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(new)
        print(f"Updated: {path}")
    else:
        print(f"No change: {path}")

for name in os.listdir(root):
    if name.startswith("DD_integrationEndPoint.") and name.endswith("__md-meta.xml"):
        update_file(os.path.join(root, name))