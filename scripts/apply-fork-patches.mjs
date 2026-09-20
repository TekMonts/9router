#!/usr/bin/env node
// Re-applies fork-only patches after syncing upstream decolua/9router.
//
// This script is IDEMPOTENT: running it twice on the same tree produces no
// additional diff. Every transformation checks for its own marker first and
// skips when already applied. It is also RESILIENT: it re-anchors on the
// *current* upstream structure instead of assuming old fork commits exist.
//
// Patches:
//   1. NineRemote strip - delete the promo files, strip Sidebar references.
//   2. Playground swap - point systemItems at /dashboard/playground instead
//      of /dashboard/skills (fork-only feature page).
//   3. 9English link removal - the external link was removed by the fork.
//   4. Stream watchdogs - first-chunk prefill watchdog, STREAM_MAX_DURATION_MS
//      lifetime ceiling, clearAll() on terminal paths, and PENDING_TIMEOUT_MS
//      tied to the ceiling. Source: fork commit a7c38105.
//
// NOTE: files are read with CRLF normalized to LF so regexes match regardless
// of platform checkout (core.autocrlf). Writes go out as LF; git normalizes
// on commit if the repo uses .gitattributes / autocrlf.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

let changed = false;
const problems = [];

const readLF = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

// ---------- Patch 1a: delete NineRemote promo files ----------
for (const f of [
  'src/shared/components/NineRemoteButton.js',
  'src/shared/components/NineRemotePromoModal.js',
]) {
  if (existsSync(f)) {
    rmSync(f);
    changed = true;
    console.log(`deleted ${f}`);
  }
}

// ---------- Patch 2: Sidebar ----------
const SIDEBAR = 'src/shared/components/Sidebar.js';
if (existsSync(SIDEBAR)) {
  let src = readLF(SIDEBAR);
  const before = src;

  // 2a. Strip NineRemote import line.
  src = src
    .split('\n')
    .filter((l) => !/^\s*import NineRemotePromoModal from "\.\/NineRemotePromoModal";\s*$/.test(l))
    .join('\n');

  // 2b. Strip showRemoteModal state line.
  src = src.replace(/^\s*const \[showRemoteModal, setShowRemoteModal\] = useState\(false\);\s*\n/m, '');

  // 2c. Strip the "Remote" button block (opening comment through </button>).
  src = src.replace(/[ \t]*\{\/\* Remote \*\/\}\n(?:.*\n)*?[ \t]*<\/button>\n/g, '');

  // 2d. Strip the "Remote Promo Modal" comment line and the component render
  //      (markup varies; only the comment is guaranteed, so also match the
  //      <NineRemotePromoModal ... /> render line directly).
  src = src.replace(/[ \t]*\{\/\* Remote Promo Modal \*\/\}\n/g, '');
  src = src.replace(/[ \t]*<NineRemotePromoModal\b[^\n]*\/>\n/g, '');

  // 2e. Strip the 9English external link block.
  src = src.replace(/[ \t]*\{\/\* 9English \*\/\}\n(?:.*\n)*?[ \t]*<\/a>\n/g, '');

  // 2f. Point systemItems at the fork's Playground page. Upstream's entry
    //      shape drifts (may gain extra props like `new: true`) — match the
    //      href/label, not the whole entry.
    src = src
      .replace(/href: "\/dashboard\/skills"/g, 'href: "/dashboard/playground"')
      .replace(/label: "Skills"/g, 'label: "Playground"')
      .replace(/icon: "extension"/g, 'icon: "science"');

  if (src !== before) {
    writeFileSync(SIDEBAR, src);
    changed = true;
    console.log(`patched ${SIDEBAR}`);
  }

  // 2g. Post-conditions: nothing NineRemote / showRemoteModal / 9English left.
  if (/NineRemote|showRemoteModal|9English/.test(src)) {
    problems.push(`unhandled NineRemote/9English reference in ${SIDEBAR}`);
  }
  if (!src.includes('"/dashboard/playground"')) {
    problems.push(`${SIDEBAR}: Playground entry missing`);
  }
}

// ---------- Patch 1b: strip NineRemote from barrel index ----------
const INDEX = 'src/shared/components/index.js';
if (existsSync(INDEX)) {
  let src = readLF(INDEX);
  const before = src;
  src = src
    .split('\n')
    .filter((l) => !/NineRemote/.test(l))
    .join('\n');
  if (src !== before) {
    writeFileSync(INDEX, src);
    changed = true;
    console.log(`patched ${INDEX}`);
  }
  if (/NineRemote/.test(src)) {
    problems.push(`unhandled NineRemote reference in ${INDEX}`);
  }
}

// ---------- Patch 4: stream watchdogs ----------
// Runtime config: add the lifetime ceiling constant.
const RUNTIME = 'open-sse/config/runtimeConfig.js';
{
  let rc = readLF(RUNTIME);
  const before = rc;
  if (!rc.includes('export const STREAM_MAX_DURATION_MS')) {
    const anchor = /export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs\("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 \* 1000\);\n/;
    if (!anchor.test(rc)) {
      problems.push(`${RUNTIME}: anchor for STREAM_FIRST_CHUNK_TIMEOUT_MS not found`);
    } else {
      rc = rc.replace(
        anchor,
        (m) =>
          m +
          '\n// Absolute ceiling on total stream lifetime - the slow-drip guard.\n' +
          '// Env: STREAM_MAX_DURATION_MS. ONE-SHOT from stream start, NEVER re-armed.\n' +
          '// Catches the case the inter-chunk stall timer cannot: an upstream that trickles\n' +
          '// one byte every few minutes so the per-chunk timer keeps resetting but the\n' +
          '// stream would otherwise run forever. Default is intentionally generous.\n' +
          'export const STREAM_MAX_DURATION_MS = envMs("STREAM_MAX_DURATION_MS", 30 * 60 * 1000);\n',
      );
    }
  }
  if (rc !== before) {
    writeFileSync(RUNTIME, rc);
    changed = true;
    console.log(`patched ${RUNTIME} (STREAM_MAX_DURATION_MS)`);
  }
}

// Stream handler: add watchdogs (only when missing), rewire terminal paths.
const STREAM = 'open-sse/utils/streamHandler.js';
{
  let sh = readLF(STREAM);
  const before = sh;

  if (!sh.includes('armMaxDuration')) {
    // Import line (idempotent: only add names not yet present).
    const impOld = 'import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";';
    const impNew = 'import { STREAM_STALL_TIMEOUT_MS, STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_MAX_DURATION_MS } from "../config/runtimeConfig.js";';
    if (!sh.includes('STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_MAX_DURATION_MS')) {
      if (sh.includes(impOld)) {
        sh = sh.replace(impOld, impNew);
      } else if (sh.includes('from "../config/runtimeConfig.js"')) {
        problems.push(`${STREAM}: import line drifted, patch manually`);
      } else {
        problems.push(`${STREAM}: import anchor not found`);
      }
    }

    // Timer declarations.
    const stallDecl = /  let stallTimer = null;\n/;
    if (!stallDecl.test(sh)) {
      problems.push(`${STREAM}: stallTimer declaration not found`);
    } else {
      sh = sh.replace(
        stallDecl,
        (m) => m + '  let firstChunkTimer = null;\n  let maxDurationTimer = null;\n',
      );
    }

    // clearStall -> clearAll + one-shot timers.
    const clearStallBody = /  const clearStall = \(\) => \{\n    if \(stallTimer\) \{ clearTimeout\(stallTimer\); stallTimer = null; \}\n  \};\n/;
    if (!clearStallBody.test(sh)) {
      problems.push(`${STREAM}: clearStall body not found`);
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

    // armStall head: clear first-chunk timer too.
    const armStallHead = /  const armStall = \(\) => \{\n    clearStall\(\);\n/;
    if (!armStallHead.test(sh)) {
      problems.push(`${STREAM}: armStall head not found`);
    } else {
      sh = sh.replace(
        armStallHead,
        '  const armStall = () => {\n' +
          '    if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }\n' +
          '    if (stallTimer) clearTimeout(stallTimer);\n',
      );
    }

    // One-shot watchdogs appended after armStall body.
    const armStallEnd = /      streamController\.abort\?\.\(\);\n    \}, stallTimeoutMs\);\n  \};\n/;
    if (!armStallEnd.test(sh)) {
      problems.push(`${STREAM}: armStall end not found`);
    } else {
      sh = sh.replace(
        armStallEnd,
        (m) =>
          m +
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
          '  // Hard lifetime ceiling - the slow-drip guard. Set once; never re-armed.\n' +
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

    // Rewire call sites: clearStall() -> clearAll() ONLY when still clearStall.
    for (const pat of [
      /clearStall\(\); streamController\.handleComplete\(\);/,
      /clearStall\(\); streamController\.handleError\(e\);/,
      /clearStall\(\); streamController\.handleDisconnect\(r\);/,
      /abort: \(\) => \{ clearStall\(\); streamController\.abort\(\); \}/,
      /flush\(\) \{ dbg\(tag, `upstream EOF.*?\); clearStall\(\); \}/,
    ]) {
      if (pat.test(sh)) {
        sh = sh.replace(pat, (m) => m.replace('clearStall();', 'clearAll();'));
      }
    }

    // Arm the one-shots at pipe start.
    const pipeStart = /  armStall\(\);\n  dbg\(tag, `pipe start \| stallTimeout=\$\{stallTimeoutMs\}ms`\);/;
    if (pipeStart.test(sh)) {
      sh = sh.replace(
        pipeStart,
        '  armFirstChunk();\n  armMaxDuration();\n' +
          '  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms | firstChunk=${STREAM_FIRST_CHUNK_TIMEOUT_MS}ms | maxDuration=${STREAM_MAX_DURATION_MS}ms`);',
      );
    }

    // Cancel prefill watchdog on first real byte.
    const armStallCall = /      armStall\(\);\n      controller\.enqueue\(chunk\);/;
    if (armStallCall.test(sh)) {
      sh = sh.replace(
        armStallCall,
        '      // First real byte cancels the prefill watchdog; stall is re-armed per chunk.\n' +
          '      if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }\n' +
          '      armStall();\n' +
          '      controller.enqueue(chunk);',
      );
    }
  }

  if (sh !== before) {
    writeFileSync(STREAM, sh);
    changed = true;
    console.log(`patched ${STREAM} (watchdogs)`);
  }
}

// usageRepo: tie PENDING_TIMEOUT_MS to the stream ceiling.
const USAGE = 'src/lib/db/repos/usageRepo.js';
{
  let ur = readLF(USAGE);
  const before = ur;
  if (!ur.includes('STREAM_MAX_DURATION_MS')) {
    const imp = /^import \{ getMeta, setMeta \} from "\.\.\/helpers\/metaStore\.js";\n/m;
    if (!imp.test(ur)) {
      problems.push(`${USAGE}: metaStore import anchor not found`);
    } else {
      ur = ur.replace(
        imp,
        'import { getMeta, setMeta } from "../helpers/metaStore.js";\n' +
          'import { STREAM_MAX_DURATION_MS } from "open-sse/config/runtimeConfig.js";\n',
      );
    }
    const pend = /^const PENDING_TIMEOUT_MS = 60 \* 1000;/m;
    if (!pend.test(ur)) {
      problems.push(`${USAGE}: PENDING_TIMEOUT_MS not found`);
    } else {
      ur = ur.replace(pend, 'const PENDING_TIMEOUT_MS = STREAM_MAX_DURATION_MS + 60 * 1000;');
    }
  }
  if (ur !== before) {
    writeFileSync(USAGE, ur);
    changed = true;
    console.log(`patched ${USAGE} (PENDING_TIMEOUT_MS)`);
  }
}

// ---------- Final verification: markers ----------
// Positive markers must be PRESENT; negative markers must be ABSENT.
const POSITIVE = [
  ['src/shared/components/Sidebar.js', new RegExp('"/dashboard/playground"')],
  ['open-sse/config/runtimeConfig.js', /export const STREAM_MAX_DURATION_MS/],
  ['open-sse/utils/streamHandler.js', /armMaxDuration/],
  ['open-sse/utils/streamHandler.js', /armFirstChunk/],
  ['src/lib/db/repos/usageRepo.js', /STREAM_MAX_DURATION_MS/],
];
for (const [f, re] of POSITIVE) {
  if (!existsSync(f) || !re.test(readFileSync(f, 'utf8'))) {
    problems.push(`marker missing after patch: ${re} in ${f}`);
  }
}
const NEGATIVE = [
  ['src/shared/components/Sidebar.js', /NineRemote|showRemoteModal|9English/],
  ['src/shared/components/index.js', /NineRemote/],
];
for (const [f, re] of NEGATIVE) {
  if (existsSync(f) && re.test(readFileSync(f, 'utf8'))) {
    problems.push(`fork-strip marker still present after patch: ${re} in ${f}`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => `PROBLEM: ${p}`).join('\n'));
  process.exit(1);
}
console.log(changed ? 'patched' : 'clean');