#!/usr/bin/env node
// Re-applies fork-only patches after syncing upstream decolua/9router.
// Two patches, both idempotent:
//   1. NineRemote strip (delegates to strip-nine-remote.mjs logic)
//   2. Stream watchdogs (from fork commit a7c38105): first-chunk prefill
//      watchdog, STREAM_MAX_DURATION_MS lifetime ceiling, clearAll() on
//      terminal paths, PENDING_TIMEOUT_MS tied to the ceiling.
// Markers detect presence; missing markers in a patched file = manual fix.
// Exit 1 on anything unhandled. Exit 0 with "clean" when nothing to do.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

let changed = false;
const problems = [];

// ---------- Patch 1: NineRemote strip ----------
const nineRemoteFiles = [
  'src/shared/components/NineRemoteButton.js',
  'src/shared/components/NineRemotePromoModal.js',
];
for (const f of nineRemoteFiles) {
  if (existsSync(f)) {
    rmSync(f);
    changed = true;
    console.log(`deleted ${f}`);
  }
}
for (const f of ['src/shared/components/index.js', 'src/shared/components/Sidebar.js']) {
  if (!existsSync(f)) continue;
  let src = readFileSync(f, 'utf8');
  const before = src;
  src = src.split('\n').filter((l) => !/NineRemote/.test(l)).join('\n');
  src = src.replace(/^\s*const \[showRemoteModal, setShowRemoteModal\] = useState\(false\);\n/m, '');
  src = src.replace(/[ \t]*\{\/\* Remote \*\/\}[\s\S]*?\n[ \t]*<\/button>\n/, '');
  if (src !== before) {
    writeFileSync(f, src);
    changed = true;
    console.log(`patched ${f}`);
  }
  if (/NineRemote|showRemoteModal/.test(readFileSync(f, 'utf8'))) {
    problems.push(`unhandled NineRemote reference in ${f}`);
  }
}

// ---------- Patch 2: stream watchdogs ----------
const IMPORT_OLD = 'import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";';
const IMPORT_NEW = 'import { STREAM_STALL_TIMEOUT_MS, STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_MAX_DURATION_MS } from "../config/runtimeConfig.js";';

let rc = readFileSync('open-sse/config/runtimeConfig.js', 'utf8');
if (!rc.includes('export const STREAM_MAX_DURATION_MS')) {
  const anchor = /export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs\("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 \* 1000\);\n/;
  if (!anchor.test(rc)) {
    problems.push('runtimeConfig.js: anchor for STREAM_FIRST_CHUNK_TIMEOUT_MS not found');
  } else {
    rc = rc.replace(
      anchor,
      (m) => m +
        '\n// Absolute ceiling on total stream lifetime — the slow-drip guard.\n' +
        '// Env: STREAM_MAX_DURATION_MS. ONE-SHOT from stream start, NEVER re-armed.\n' +
        '// Catches the case the inter-chunk stall timer cannot: an upstream that trickles\n' +
        '// one byte every few minutes so the per-chunk timer keeps resetting but the\n' +
        '// stream would otherwise run forever. Default is intentionally generous.\n' +
        'export const STREAM_MAX_DURATION_MS = envMs("STREAM_MAX_DURATION_MS", 30 * 60 * 1000);\n',
    );
    writeFileSync('open-sse/config/runtimeConfig.js', rc);
    changed = true;
    console.log('patched open-sse/config/runtimeConfig.js (STREAM_MAX_DURATION_MS)');
  }
}

let sh = readFileSync('open-sse/utils/streamHandler.js', 'utf8');
if (!sh.includes('armMaxDuration')) {
  if (sh.includes(IMPORT_OLD)) {
    sh = sh.replace(IMPORT_OLD, IMPORT_NEW);
  } else if (!sh.includes('STREAM_MAX_DURATION_MS')) {
    problems.push('streamHandler.js: import line drifted — patch import manually');
  }

  // clearStall -> clearAll + two one-shot timers
  const stallDecl = /  let stallTimer = null;\n/;
  if (!stallDecl.test(sh)) {
    problems.push('streamHandler.js: stallTimer declaration not found');
  } else {
    sh = sh.replace(
      stallDecl,
      (m) => m + '  let firstChunkTimer = null;\n  let maxDurationTimer = null;\n',
    );
  }

  const clearStallBody = /  const clearStall = \(\) => \{\n    if \(stallTimer\) \{ clearTimeout\(stallTimer\); stallTimer = null; \}\n  \};\n/;
  if (!clearStallBody.test(sh)) {
    problems.push('streamHandler.js: clearStall body not found');
  } else {
    sh = sh.replace(
      clearStallBody,
      '  // Clear every watchdog on any terminal path (complete/error/disconnect/abort).\n' +
      '  const clearAll = () => {\n' +
      '    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }\n' +
      '    if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }\n' +
      '    if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }\n' +
      '  };\n',
    );
  }

  const armStallHead = /  const armStall = \(\) => \{\n    clearStall\(\);\n/;
  if (!armStallHead.test(sh)) {
    problems.push('streamHandler.js: armStall head not found');
  } else {
    sh = sh.replace(
      armStallHead,
      '  const armStall = () => {\n' +
      '    if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }\n' +
      '    if (stallTimer) clearTimeout(stallTimer);\n',
    );
    // Guard the stall timeout body against firing after disconnect (a7c38105).
    sh = sh.replace(
      /(stallTimer = setTimeout\(\(\) => \{\n      stallTimer = null;\n)(      dbg\(tag, `STALL TIMEOUT)/,
      '$1      if (!streamController.isConnected()) return;\n$2',
    );
  }

  // One-shot watchdogs after armStall body
  const armStallEnd = /      streamController\.abort\?\.\(\);\n    \}, stallTimeoutMs\);\n  \};\n/;
  if (!armStallEnd.test(sh)) {
    problems.push('streamHandler.js: armStall end not found');
  } else {
    sh = sh.replace(
      armStallEnd,
      (m) => m +
        '\n' +
        '  // One-shot prefill watchdog: abort if upstream never emits the first byte.\n' +
        '  const armFirstChunk = () => {\n' +
        '    if (firstChunkTimer) return;\n' +
        '    firstChunkTimer = setTimeout(() => {\n' +
        '      firstChunkTimer = null;\n' +
        '      if (!streamController.isConnected()) return;\n' +
        '      dbg(tag, `FIRST-CHUNK TIMEOUT ${STREAM_FIRST_CHUNK_TIMEOUT_MS}ms | chunks=${chunkCount} | bytes=${totalBytes}`);\n' +
        '      streamController.handleError?.(new Error("stream first-chunk timeout (upstream prefill stalled)"));\n' +
        '      streamController.abort?.();\n' +
        '    }, STREAM_FIRST_CHUNK_TIMEOUT_MS);\n' +
        '  };\n' +
        '\n' +
        '  // Hard lifetime ceiling — the slow-drip guard. Set once; never re-armed.\n' +
        '  const armMaxDuration = () => {\n' +
        '    if (maxDurationTimer) return;\n' +
        '    maxDurationTimer = setTimeout(() => {\n' +
        '      maxDurationTimer = null;\n' +
        '      if (!streamController.isConnected()) return;\n' +
        '      dbg(tag, `MAX-DURATION TIMEOUT ${STREAM_MAX_DURATION_MS}ms | chunks=${chunkCount} | bytes=${totalBytes}`);\n' +
        '      streamController.handleError?.(new Error("stream max-duration timeout (slow-drip guard)"));\n' +
        '      streamController.abort?.();\n' +
        '    }, STREAM_MAX_DURATION_MS);\n' +
        '  };\n',
    );
  }

  for (const [pat, repl] of [
    [/clearStall\(\); streamController\.handleComplete\(\);/, 'clearAll(); streamController.handleComplete();'],
    [/clearStall\(\); streamController\.handleError\(e\);/, 'clearAll(); streamController.handleError(e);'],
    [/clearStall\(\); streamController\.handleDisconnect\(r\);/, 'clearAll(); streamController.handleDisconnect(r);'],
    [/abort: \(\) => \{ clearStall\(\); streamController\.abort\(\); \}/, 'abort: () => { clearAll(); streamController.abort(); }'],
    [/flush\(\) \{ dbg\(tag, `upstream EOF.*?\); clearStall\(\); \}/, (m) => m.replace('clearStall();', 'clearAll();')],
  ]) {
    if (!pat.test(sh)) { problems.push(`streamHandler.js: call site not found: ${pat}`); }
    else sh = sh.replace(pat, repl);
  }

  // Arm the one-shots at pipe start
  const pipeStart = /  armStall\(\);\n  dbg\(tag, `pipe start \| stallTimeout=\$\{stallTimeoutMs\}ms`\);/;
  if (!pipeStart.test(sh)) {
    problems.push('streamHandler.js: pipe-start line not found');
  } else {
    sh = sh.replace(
      pipeStart,
      '  armFirstChunk();\n  armMaxDuration();\n' +
      '  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms | firstChunk=${STREAM_FIRST_CHUNK_TIMEOUT_MS}ms | maxDuration=${STREAM_MAX_DURATION_MS}ms`);',
    );
  }

  // Cancel prefill watchdog on first chunk
  const armStallCall = /      armStall\(\);\n      controller\.enqueue\(chunk\);/;
  if (!armStallCall.test(sh)) {
    problems.push('streamHandler.js: transform armStall call not found');
  } else {
    sh = sh.replace(
      armStallCall,
      '      // First real byte cancels the prefill watchdog; stall is re-armed per chunk.\n' +
      '      if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }\n' +
      '      armStall();\n' +
      '      controller.enqueue(chunk);',
    );
  }

  if (problems.filter((p) => p.startsWith('streamHandler')).length === 0) {
    writeFileSync('open-sse/utils/streamHandler.js', sh);
    changed = true;
    console.log('patched open-sse/utils/streamHandler.js (watchdogs)');
  }
}

let ur = readFileSync('src/lib/db/repos/usageRepo.js', 'utf8');
if (!ur.includes('STREAM_MAX_DURATION_MS')) {
  const imp = /^import \{ getMeta, setMeta \} from "\.\.\/helpers\/metaStore\.js";\n/m;
  if (!imp.test(ur)) {
    problems.push('usageRepo.js: metaStore import anchor not found');
  } else {
    ur = ur.replace(imp, (m) => m + 'import { STREAM_MAX_DURATION_MS } from "open-sse/config/runtimeConfig.js";\n');
  }
  const pend = /^const PENDING_TIMEOUT_MS = 60 \* 1000;/m;
  if (!pend.test(ur)) {
    problems.push('usageRepo.js: PENDING_TIMEOUT_MS not found');
  } else {
    ur = ur.replace(pend, 'const PENDING_TIMEOUT_MS = STREAM_MAX_DURATION_MS + 60 * 1000;');
  }
  if (problems.filter((p) => p.startsWith('usageRepo')).length === 0) {
    writeFileSync('src/lib/db/repos/usageRepo.js', ur);
    changed = true;
    console.log('patched src/lib/db/repos/usageRepo.js (PENDING_TIMEOUT_MS)');
  }
}

// ---------- Final verification: markers ----------
const MARKERS = [
  ['open-sse/config/runtimeConfig.js', /export const STREAM_MAX_DURATION_MS/],
  ['open-sse/utils/streamHandler.js', /armMaxDuration/],
  ['open-sse/utils/streamHandler.js', /armFirstChunk/],
  ['src/lib/db/repos/usageRepo.js', /STREAM_MAX_DURATION_MS/],
];
for (const [f, re] of MARKERS) {
  if (!existsSync(f) || !re.test(readFileSync(f, 'utf8'))) {
    problems.push(`marker missing after patch: ${re} in ${f}`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => `PROBLEM: ${p}`).join('\n'));
  process.exit(1);
}
console.log(changed ? 'patched' : 'clean');
