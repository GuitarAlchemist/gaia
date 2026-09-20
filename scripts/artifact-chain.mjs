#!/usr/bin/env node
/**
 * artifact-chain.mjs — create a digest-pinned artifact chain from real files, or ask whether one
 * still applies to the revision in front of you.
 *
 * Usage
 *   node scripts/artifact-chain.mjs create --root <dir> --descriptor <file.json>
 *                                          [--manifest <out.json>] [--json]
 *
 *   node scripts/artifact-chain.mjs validate --root <dir> --manifest <file.json>
 *                                            --subject <text>
 *                                            --root-revision <40-hex> [--root-revision ...] [--json]
 *
 * `create` hashes every artifact the descriptor names through the file adapter. Every dependency
 * must already carry its producer-recorded historical `pinnedDigest`; creation preserves that pin
 * and never derives it from the predecessor's current measurement. Writing is immutable: identical
 * bytes are UNCHANGED, different bytes are refused, and existing evidence is never overwritten.
 *
 * `validate` re-measures every artifact and evaluates the chain against the expectation given on
 * THIS command line. The manifest never supplies its own subject or root revision to itself, which
 * is what stops a self-consistent old chain from blessing itself as current. It writes nothing.
 *
 * CHAIN_FRESH is a statement about digests and edges. It does not say tests passed, a reviewer
 * approved, or a publication happened: every claim in a manifest is unauthenticated text and is
 * reported as asserted. A stage with no node is reported NOT_PROVIDED, never as a pass.
 *
 * Exit codes: 0 created/unchanged or CHAIN_FRESH, 1 CHAIN_STALE, 2 usage error, 3 typed refusal.
 * A publication-boundary synchronization refusal may retain a complete destination; identical
 * retry re-synchronizes it. A refusal prints `REFUSED: <code>` and nothing else.
 */

import {
  ArtifactChainError, buildArtifactChain, canonicalArtifactChainJson, evaluateArtifactChain,
  validateArtifactChain, validateArtifactChainDescriptor,
} from '../src/artifact-chain.mjs';
import {
  ArtifactChainFileError, measureArtifactChainFiles, persistArtifactChainManifest,
  readArtifactChainJson,
} from '../src/artifact-chain-files.mjs';

const USAGE = 'usage: node scripts/artifact-chain.mjs create --root <dir> --descriptor <file> '
  + '[--manifest <file>] [--json]\n'
  + '       node scripts/artifact-chain.mjs validate --root <dir> --manifest <file> '
  + '--subject <text> --root-revision <40-hex> [--root-revision <40-hex>]... [--json]\n'
  + 'create descriptors require producer-recorded historical dependency pinnedDigest values.\n';

const VALUED = new Set(['root', 'descriptor', 'manifest', 'subject', 'root-revision']);
const REPEATED = new Set(['root-revision']);
const ALLOWED = {
  create: ['root', 'descriptor', 'manifest', 'json'],
  validate: ['root', 'manifest', 'subject', 'root-revision', 'json'],
};

const usageError = message => { throw Object.assign(new Error(message), { usage: true }); };

function parse(argv) {
  const command = argv[0];
  if (!Object.hasOwn(ALLOWED, command)) usageError(`unknown command: ${command ?? '(none)'}`);
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) usageError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!ALLOWED[command].includes(name)) usageError(`unknown flag: ${token}`);
    if (!VALUED.has(name)) { flags[name] = true; continue; }
    const value = argv[index += 1];
    if (value === undefined || value.startsWith('--')) usageError(`${token} needs a value`);
    if (REPEATED.has(name)) (flags[name] ??= []).push(value);
    else if (flags[name] !== undefined) usageError(`${token} given more than once`);
    else flags[name] = value;
  }
  return { command, flags };
}

function create(flags) {
  if (flags.root === undefined || flags.descriptor === undefined) {
    usageError('create needs --root and --descriptor');
  }
  const descriptor = validateArtifactChainDescriptor(readArtifactChainJson(flags.descriptor));
  const manifest = buildArtifactChain({ descriptor,
    measured: measureArtifactChainFiles({ root: flags.root, nodes: descriptor.nodes }) });
  const status = flags.manifest === undefined
    ? 'BUILT'
    : persistArtifactChainManifest({ path: flags.manifest, manifest }).status;
  if (flags.json) {
    process.stdout.write(`${canonicalArtifactChainJson(manifest)}\n`);
    return 0;
  }
  process.stdout.write(`status=${status}\n`
    + `subject=${manifest.subject}\n`
    + `nodes=${manifest.nodes.length}\n`
    + `pending=${manifest.pendingStages.join(',')}\n`);
  return 0;
}

function validate(flags) {
  if (flags.root === undefined || flags.manifest === undefined || flags.subject === undefined
    || flags['root-revision'] === undefined) {
    usageError('validate needs --root, --manifest, --subject, and at least one --root-revision');
  }
  const manifest = validateArtifactChain(readArtifactChainJson(flags.manifest));
  const report = evaluateArtifactChain({ manifest,
    observed: measureArtifactChainFiles({ root: flags.root, nodes: manifest.nodes }),
    expectation: { subject: flags.subject, requiredRootRevisions: flags['root-revision'] } });
  if (flags.json) process.stdout.write(`${canonicalArtifactChainJson(report)}\n`);
  else {
    process.stdout.write(`verdict=${report.verdict}\n`
      + `subject=${report.subject}\n`
      + report.nodes.map(node => `node=${node.id} ${node.freshness}\n`).join('')
      + report.stages.map(stage => `stage=${stage.stage} ${stage.status}\n`).join('')
      + 'claims=ASSERTED_NOT_VERIFIED\n');
  }
  return report.verdict === 'CHAIN_FRESH' ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--help')) { process.stdout.write(USAGE); return 0; }
  const { command, flags } = parse(argv);
  return command === 'create' ? create(flags) : validate(flags);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ArtifactChainError || error instanceof ArtifactChainFileError) {
    process.stderr.write(`REFUSED: ${error.code}\n`);
    process.exitCode = 3;
  } else {
    process.stderr.write(`usage error: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
  }
}
