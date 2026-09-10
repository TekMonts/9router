#!/usr/bin/env node
// Strips NineRemote/9Remote remnants after syncing upstream decolua/9router.
// Idempotent: exits 0 with no changes on a clean tree.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

const componentFiles = ['src/shared/components/index.js', 'src/shared/components/Sidebar.js'];
const nineRemoteFiles = [
  'src/shared/components/NineRemoteButton.js',
  'src/shared/components/NineRemotePromoModal.js',
];
let changed = false;

for (const f of nineRemoteFiles) {
  if (existsSync(f)) {
    rmSync(f);
    changed = true;
    console.log(`deleted ${f}`);
  }
}

for (const f of componentFiles) {
  if (!existsSync(f)) continue;
  let src = readFileSync(f, 'utf8');
  const before = src;
  src = src.split('\n').filter((l) => !/NineRemote/.test(l)).join('\n');
  src = src.replace(/^\s*const \[showRemoteModal, setShowRemoteModal\] = useState\(false\);\n/m, '');
  // JSX span: the sidebar "Remote" button block
  src = src.replace(/[ \t]*\{\/\* Remote \*\/\}[\s\S]*?\n[ \t]*<\/button>\n/, '');
  if (src !== before) {
    writeFileSync(f, src);
    changed = true;
    console.log(`patched ${f}`);
  }
}

for (const f of componentFiles) {
  if (existsSync(f) && /NineRemote|showRemoteModal/.test(readFileSync(f, 'utf8'))) {
    console.error(`unhandled NineRemote reference in ${f} — fix manually`);
    process.exit(1);
  }
}
console.log(changed ? 'patched' : 'clean');
