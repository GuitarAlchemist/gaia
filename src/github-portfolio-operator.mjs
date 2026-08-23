/**
 * github-portfolio-operator.mjs — the seam that makes the portfolio factory operable
 * without making it self-authorizing.
 *
 * `initOperatorKeypair` is the only writer of operator key material. `runOperatorFactory`
 * is the only path to an authorized advance, and it is deliberately indivisible: the
 * grant it mints is signed, consumed, and dropped inside one call, so no signed grant
 * ever exists as an artifact that something other than the operator who confirmed it
 * could spend. See docs/github-portfolio-operator.md for the interfaces this was chosen
 * against.
 *
 * The terminal readers at the foot of this file live here for the same reason: what a
 * reader does when the operator presses Ctrl-C decides whether authority was refused or
 * merely never asked for, and that is not a detail of plumbing. They take their streams
 * as parameters, so the CLI binds the real terminal and a gate binds a stream that does
 * exactly what a terminal does.
 */

import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createPortfolioFactory } from './github-portfolio.mjs';
import { portfolioGrantPreimage } from './github-portfolio-authority.mjs';

export const OPERATOR_RECEIPT_SCHEMA = 'gaia-github-portfolio-operator-receipt/1';

export class PortfolioOperatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortfolioOperatorError';
    this.code = code;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requiredPath(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PortfolioOperatorError('InvalidArgument', `${field} is required`);
  }
  return resolve(value);
}

// Asked for before anything secret is typed: an operator should never hand over a
// passphrase to a command that was already going to refuse.
function reserveNewPath(supplied, field) {
  if (existsSync(supplied)) {
    throw new PortfolioOperatorError('OutputExists', `${field} already exists and is never overwritten`);
  }
  return supplied;
}

// The passphrase is read from the caller's interactive secret reader and compared. It is
// never a parameter of these functions, so there is no argument list, environment
// variable, or repository file it could have arrived in.
async function readSecret(readPassphrase, prompt) {
  if (typeof readPassphrase !== 'function') {
    throw new PortfolioOperatorError('InvalidArgument', 'readPassphrase must be a function');
  }
  const secret = await readPassphrase({ prompt });
  if (typeof secret !== 'string') {
    throw new PortfolioOperatorError('PassphraseRequired', 'the passphrase reader returned no text');
  }
  return secret;
}

const PASSPHRASE_PROMPT =
  'Operator key passphrase (not echoed; never read from argv or the environment): ';

async function confirmedPassphrase(readPassphrase) {
  const first = await readSecret(readPassphrase, PASSPHRASE_PROMPT);
  const second = await readSecret(readPassphrase, 'Repeat the operator key passphrase: ');
  if (first !== second) {
    throw new PortfolioOperatorError('PassphraseMismatch', 'the two passphrases did not match');
  }
  if (first.trim() === '') {
    throw new PortfolioOperatorError('PassphraseRequired', 'the passphrase must not be blank');
  }
  return first;
}

export async function initOperatorKeypair({ privateKeyPath, publicKeyPath, readPassphrase }) {
  const privatePath = requiredPath(privateKeyPath, 'privateKeyPath');
  const publicPath = requiredPath(publicKeyPath, 'publicKeyPath');
  if (privatePath === publicPath) {
    throw new PortfolioOperatorError(
      'OutputConflict', 'the private and public key paths must be two different files',
    );
  }
  reserveNewPath(privatePath, 'privateKeyPath');
  reserveNewPath(publicPath, 'publicKeyPath');

  const passphrase = await confirmedPassphrase(readPassphrase);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  try {
    writeFileSync(privatePath, privateKey.export({
      type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase,
    }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new PortfolioOperatorError(
        'OutputExists', 'privateKeyPath already exists and is never overwritten',
      );
    }
    throw new PortfolioOperatorError(
      'KeypairPublication', `the private key could not be written: ${error?.code ?? 'unknown'}`,
    );
  }

  // From here the keypair is half published. Either both halves land or neither does: an
  // operator holding a private key whose public half was never published cannot be
  // verified against, and would have no way to tell that from a working key.
  try {
    writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    rmSync(privatePath, { force: true });
    if (error?.code === 'EEXIST') {
      throw new PortfolioOperatorError(
        'OutputExists', 'publicKeyPath already exists and is never overwritten',
      );
    }
    throw new PortfolioOperatorError(
      'KeypairPublication',
      `the public key could not be published (${error?.code ?? 'unknown'}); the private key was withdrawn`,
    );
  }

  return { privateKeyPath: privatePath, publicKeyPath: publicPath };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const TTL_SECONDS_MAX = 900;

// A refusal names a stage and a short code and nothing else. Whatever threw may be a
// provider error carrying a message, a path, or a remote URL with a credential in it, so
// only a token that already looks like an identifier is allowed through.
function refusalCode(error, fallback) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(code)
    ? code
    : fallback;
}

// GitHub-controlled text reaches the operator's terminal here. It is displayed, never
// obeyed: control characters and bidirectional overrides are removed so the line cannot
// redraw the prompt around it, and the line is bounded so it cannot scroll the intent off
// the screen.
export const DISPLAY_MAX = 256;

function displayText(value) {
  const stripped = String(value ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]/gu, ' ');
  return [...stripped].length > DISPLAY_MAX
    ? `${[...stripped].slice(0, DISPLAY_MAX).join('')}…`
    : stripped;
}

// Every field interpolated below is GitHub-derived, so every field goes through the same
// control. Two of them are already safe by other means — `repository` was pinned to the
// operator's own `--repository` before this block could be built, and `intentRevision` is
// a digest this command measured — but naming an exception here is how a field gets added
// later without anyone deciding about it. `itemId` is the one that makes the point: the
// portfolio bounds a *title* to one canonical line at survey and constrains an id no
// further than "it is a string", and these are the lines the operator is being asked to
// judge, so an escape sequence on the id line could repaint the repository and action
// lines while the revision they must type stays genuine.
function confirmationPrompt(intent) {
  const shown = (value) => displayText(value);
  return [
    '',
    'One factory run is about to be authorized with your operator key.',
    `  repository      ${shown(intent.repository)}`,
    `  item            ${shown(intent.itemKind)} #${shown(intent.itemNumber)} `
      + `(${shown(intent.itemId)})`,
    `  action          ${shown(intent.action)}`,
    `  intent revision ${shown(intent.intentRevision)}`,
    `  snapshot        ${shown(intent.snapshotRevision)}`,
    '',
    'The next line is untrusted GitHub-controlled data, shown for your judgement only.',
    `  ${shown(intent.task)}`,
    '',
    'Type the full intent revision to authorize, or anything else to refuse: ',
  ].join('\n');
}

function operatorReceipt(body) {
  const document = {
    schema: OPERATOR_RECEIPT_SCHEMA,
    status: body.status,
    portfolioRevision: body.portfolioRevision ?? null,
    repository: body.repository,
    intent: body.intent ?? null,
    refusal: body.refusal ?? null,
    transition: body.transition ?? null,
  };
  return { ...document, revision: sha256(canonicalJson(document)) };
}

const intentIdentity = (intent) => ({
  action: intent.action,
  repository: intent.repository,
  itemKind: intent.itemKind,
  itemId: intent.itemId,
  itemNumber: intent.itemNumber,
  intentRevision: intent.intentRevision,
});

function expiryAt(now, ttlSeconds) {
  const observed = now();
  if (!(observed instanceof Date) || Number.isNaN(observed.valueOf())) {
    throw new PortfolioOperatorError('OperatorClock', 'the operator clock returned an invalid date');
  }
  return new Date(observed.valueOf() + ttlSeconds * 1000).toISOString();
}

export async function runOperatorFactory({
  portfolioPath,
  repository,
  privateKeyPath,
  outPath,
  githubRead,
  authority,
  execution,
  readPassphrase,
  confirm,
  now = () => new Date(),
  grantId = () => `gaia-operator-${randomUUID()}`,
  ttlSeconds = 120,
}) {
  // Everything this block refuses is refused before any path is reserved and before any
  // GitHub read, so a usage error is distinguishable from an operational refusal.
  const pinnedPath = requiredPath(portfolioPath, 'portfolioPath');
  const keyPath = requiredPath(privateKeyPath, 'privateKeyPath');
  const receiptPath = requiredPath(outPath, 'outPath');
  if (typeof repository !== 'string' || !OWNER_NAME.test(repository)) {
    throw new PortfolioOperatorError('InvalidArgument', 'repository must be owner/name');
  }
  if (!githubRead || typeof githubRead.read !== 'function') {
    throw new PortfolioOperatorError('InvalidArgument', 'githubRead.read is required');
  }
  if (!authority || typeof authority.consume !== 'function') {
    throw new PortfolioOperatorError('InvalidArgument', 'authority.consume is required');
  }
  if (!execution || typeof execution.execute !== 'function') {
    throw new PortfolioOperatorError('InvalidArgument', 'execution.execute is required');
  }
  if (typeof confirm !== 'function') {
    throw new PortfolioOperatorError('InvalidArgument', 'confirm must be a function');
  }
  if (typeof readPassphrase !== 'function') {
    throw new PortfolioOperatorError('InvalidArgument', 'readPassphrase must be a function');
  }
  if (typeof grantId !== 'function' || typeof now !== 'function') {
    throw new PortfolioOperatorError('InvalidArgument', 'now and grantId must be functions');
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > TTL_SECONDS_MAX) {
    throw new PortfolioOperatorError(
      'InvalidArgument', `ttlSeconds must be an integer between 1 and ${TTL_SECONDS_MAX}`,
    );
  }
  if (receiptPath === pinnedPath || receiptPath === keyPath) {
    throw new PortfolioOperatorError('OutputConflict', 'outPath must not be an input path');
  }

  // The receipt path is claimed exclusively before authority is consumed, and before
  // anything else can fail. From this line on the command owns that path, so every exit
  // below leaves a structured receipt there rather than a hole where one should be.
  try {
    writeFileSync(receiptPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new PortfolioOperatorError(
      error?.code === 'EEXIST' ? 'OutputExists' : 'OutputReservation',
      `the receipt path could not be reserved: ${error?.code ?? 'unknown'}`,
    );
  }

  const leave = (body) => {
    const receipt = operatorReceipt({ repository, ...body });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8', flag: 'w', mode: 0o600,
    });
    return receipt;
  };
  const refuse = (stage, code, extra = {}) => leave({
    status: 'REFUSED', refusal: { stage, code }, ...extra,
  });

  let portfolio;
  try {
    portfolio = JSON.parse(readFileSync(pinnedPath, 'utf8'));
  } catch (error) {
    return refuse('portfolio', refusalCode(error, 'PortfolioUnreadable'));
  }
  if (!portfolio || typeof portfolio !== 'object' || Array.isArray(portfolio)
      || !/^[a-f0-9]{64}$/u.test(portfolio.revision ?? '')) {
    return refuse('portfolio', 'PortfolioInvalid');
  }
  const portfolioRevision = portfolio.revision;

  const factory = createPortfolioFactory({
    githubRead, authority, factoryExecution: execution,
  });

  // GitHub is re-read here. The pinned file supplies a revision to hold the world to,
  // never the intent that gets executed.
  let preview;
  try {
    preview = await factory.advance({ portfolio });
  } catch (error) {
    return refuse('materialize', refusalCode(error, 'PortfolioAdvanceFailed'), { portfolioRevision });
  }
  if (preview.status !== 'AWAITING_AUTHORITY' || !preview.intent) {
    return refuse('materialize', preview.status === 'NO_READY_WORK' ? 'NoReadyWork' : 'NotAwaitingAuthority',
      { portfolioRevision });
  }
  const intent = preview.intent;
  const identity = intentIdentity(intent);

  // The operator pre-committed to a repository before the intent was known. An intent
  // for a different one is refused here rather than shown for confirmation.
  if (intent.repository !== repository) {
    return refuse('scope', 'RepositoryScopeMismatch', { portfolioRevision, intent: identity });
  }

  let answer;
  try {
    answer = await confirm({ prompt: confirmationPrompt(intent), intent });
  } catch (error) {
    return refuse('confirm', refusalCode(error, 'ConfirmationUnavailable'),
      { portfolioRevision, intent: identity });
  }
  // The digest the operator types is compared against the one just measured, not against
  // anything they were allowed to supply.
  if (typeof answer !== 'string' || answer.trim() !== intent.intentRevision) {
    return refuse('confirm', 'ConfirmationMismatch', { portfolioRevision, intent: identity });
  }

  let privateKey;
  try {
    const passphrase = await readSecret(readPassphrase, PASSPHRASE_PROMPT);
    privateKey = createPrivateKey({
      key: readFileSync(keyPath, 'utf8'), format: 'pem', passphrase,
    });
  } catch (error) {
    // Deliberately not the thrown message: an OpenSSL decode failure is not worth
    // quoting, and quoting it is how inputs end up in logs.
    return refuse('key', error instanceof PortfolioOperatorError
      ? refusalCode(error, 'PrivateKeyUnreadable')
      : 'PrivateKeyUnreadable', { portfolioRevision, intent: identity });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    return refuse('key', 'PrivateKeyNotEd25519', { portfolioRevision, intent: identity });
  }

  let grant;
  try {
    const payload = {
      schema: 'gaia-github-portfolio-grant/1',
      grantId: grantId(),
      intentRevision: intent.intentRevision,
      action: intent.action,
      repository: intent.repository,
      itemKind: intent.itemKind,
      itemId: intent.itemId,
      itemNumber: intent.itemNumber,
      snapshotRevision: intent.snapshotRevision,
      expiresAt: expiryAt(now, ttlSeconds),
    };
    grant = {
      ...payload,
      signature: sign(null, portfolioGrantPreimage(payload), privateKey).toString('base64url'),
    };
  } catch (error) {
    return refuse('grant', refusalCode(error, 'GrantUnsignable'),
      { portfolioRevision, intent: identity });
  }

  // The grant exists only inside this call. It is handed straight to the authority the
  // caller composed, which verifies it against the published public half and spends it
  // exactly once; it is never written, returned, or logged.
  let transition;
  try {
    transition = await factory.advance({ portfolio, grant });
  } catch (error) {
    return refuse('authority', refusalCode(error, 'GrantRejected'),
      { portfolioRevision, intent: identity });
  }

  return leave({
    status: 'AUTHORIZED',
    portfolioRevision,
    intent: identity,
    transition,
  });
}


// ---------------------------------------------------------------------------
// the terminal end
// ---------------------------------------------------------------------------

/**
 * Both readers below are *total*: every way a terminal can end — a line, end of input,
 * Ctrl-C, or the stream breaking underneath — settles the promise exactly once.
 *
 * That is a property about authority, not about ergonomics. `runOperatorFactory` has
 * already reserved the receipt path by the time it asks either of these questions, so a
 * reader that can decline to settle is worse than one that refuses: it leaves the
 * operator a zero-byte file where the receipt should be, nothing on stdout, an exit code
 * that says the factory ran, and an `--out` path that the next attempt is refused for.
 * Refusing is cheap and it is written down; not answering is neither.
 *
 * Neither reader has a timeout, and neither may grow one. Waiting for a person is not a
 * failure, and a deadline at this prompt would be a way for the command to decide
 * something the operator did not.
 */

// What survives a broken terminal is a code, never the diagnostic: whatever the runtime
// threw may carry a device path or a console name, and nothing typed at either prompt is
// ever quoted back — a cancelled read that echoed the half-typed secret into an error
// message would defeat the point of not echoing it in the first place.
const terminalDiagnostic = (what, error) =>
  `the ${what} could not be read from the terminal: ${refusalCode(error, 'unknown')}`;

const WINDOWS_SECRET_PROMPT = fileURLToPath(
  new URL('../scripts/windows-secret-prompt.ps1', import.meta.url),
);

export function readSecretFromWindowsDialog({
  prompt,
  spawnProcess = spawn,
  scriptPath = WINDOWS_SECRET_PROMPT,
}) {
  return new Promise((answer, refuse) => {
    let child;
    try {
      child = spawnProcess('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', scriptPath,
        '-PromptBase64', Buffer.from(prompt, 'utf8').toString('base64'),
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: false,
      });
    } catch (error) {
      refuse(new PortfolioOperatorError(
        'PassphraseUnreadable', terminalDiagnostic('Windows secret prompt', error),
      ));
      return;
    }

    let encoded = '';
    let settled = false;
    const settle = (callback) => {
      if (settled) return false;
      settled = true;
      callback();
      return true;
    };
    const terminateAndRefuse = (error) => {
      if (!settle(() => refuse(error))) return;
      try { child.kill(); } catch { /* the typed refusal is already authoritative */ }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      encoded += chunk;
      if (encoded.length > 32_768) {
        terminateAndRefuse(new PortfolioOperatorError(
          'PassphraseUnreadable', 'the Windows passphrase prompt returned no valid answer',
        ));
      }
    });
    child.stdout.on('error', (error) => terminateAndRefuse(new PortfolioOperatorError(
      'PassphraseUnreadable', terminalDiagnostic('Windows secret prompt', error),
    )));
    child.on('error', (error) => settle(() => refuse(new PortfolioOperatorError(
      'PassphraseUnreadable', terminalDiagnostic('Windows secret prompt', error),
    ))));
    child.on('close', (code) => {
      if (settled) return;
      if (code === 3) {
        settle(() => refuse(new PortfolioOperatorError(
          'PassphraseCancelled', 'the Windows passphrase prompt was cancelled',
        )));
        return;
      }
      if (code !== 0 || encoded.includes('\r') || encoded.includes('\n')) {
        settle(() => refuse(new PortfolioOperatorError(
          'PassphraseUnreadable', 'the Windows passphrase prompt returned no valid answer',
        )));
        return;
      }
      try {
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw new Error('non-canonical base64');
        settle(() => answer(bytes.toString('utf8')));
      } catch {
        settle(() => refuse(new PortfolioOperatorError(
          'PassphraseUnreadable', 'the Windows passphrase prompt returned no valid answer',
        )));
      }
    });
  });
}

export function readSecretForPlatform({
  platform = process.platform,
  prompt,
  input,
  output,
  windowsReader = readSecretFromWindowsDialog,
}) {
  if (platform === 'win32') return windowsReader({ prompt });
  return readSecretFromTerminal({ prompt, input, output });
}

export function readSecretFromTerminal({ prompt, input, output }) {
  output.write(prompt);
  return new Promise((answer, refuse) => {
    const wasRaw = input.isRaw === true;
    let secret = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      try {
        if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
        input.pause();
      } catch {
        // A terminal that broke under the read cannot also be restored. The answer below
        // is what the caller needs; failing to tidy up must not turn a refusal into a
        // promise that never settles.
      }
      output.write('\n');
      if (error) refuse(error);
      else answer(secret);
    };

    const onEnd = () => finish(new PortfolioOperatorError(
      'PassphraseClosed', 'the passphrase prompt reached end of input before an answer',
    ));
    const onError = (error) => finish(new PortfolioOperatorError(
      'PassphraseUnreadable', terminalDiagnostic('passphrase', error),
    ));
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          finish();
          return;
        }
        // Cancelling is a refusal that names itself, so the receipt does not have to
        // report a key it could not open when what happened is that the operator
        // changed their mind.
        if (character === '\u0003') {
          finish(new PortfolioOperatorError(
            'PassphraseCancelled', 'the passphrase prompt was cancelled',
          ));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += character;
      }
    };

    input.setEncoding('utf8');
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.on('error', onError);
    input.on('end', onEnd);
    input.on('close', onEnd);
  });
}

// The intent revision is public data, so it is echoed: an operator must be able to see
// that what they typed is what they meant to type. That is why the interface is given an
// output stream rather than left without one.
export function readConfirmationFromTerminal({ prompt, input, output }) {
  output.write(prompt);
  const terminal = createInterface({ input, output, terminal: true });
  return new Promise((answer, refuse) => {
    let settled = false;
    const finish = (act) => {
      if (settled) return;
      settled = true;
      input.removeListener('error', broke);
      terminal.close();
      act();
    };

    // A line the operator typed but did not terminate is still their answer: readline
    // flushes it at end of input, and it arrives here before the close that follows it.
    terminal.on('line', (line) => finish(() => answer(line)));

    // The two ways an operator leaves this prompt without answering it, at the prompt
    // whose own text invites them to. Neither is an empty answer and neither is success,
    // and they are kept apart so the receipt can say which one happened.
    terminal.on('close', () => finish(() => refuse(new PortfolioOperatorError(
      'ConfirmationClosed', 'the confirmation prompt reached end of input before an answer',
    ))));
    terminal.on('SIGINT', () => finish(() => refuse(new PortfolioOperatorError(
      'ConfirmationCancelled', 'the confirmation prompt was cancelled',
    ))));

    const broke = (error) => finish(() => refuse(new PortfolioOperatorError(
      'ConfirmationUnreadable', terminalDiagnostic('confirmation', error),
    )));
    terminal.on('error', broke);
    input.on('error', broke);
  });
}

// The transitions that mean what the documented exit code `0` means: the factory ran and
// returned a verdict. A refusal, a spent grant whose execution failed, and an authorized
// receipt with no transition to read are all exit `1`.
const SETTLED_TRANSITIONS = ['CANDIDATE_READY', 'CANDIDATE_REJECTED'];

export function summarizeOperatorReceipt(receipt, receiptPath) {
  const authorized = receipt.status === 'AUTHORIZED';
  // Deliberately defensive. This is the one thing the command says after authority may
  // already have been spent, so it must not be the place that throws.
  const transition = authorized ? receipt.transition?.status ?? 'UNKNOWN' : null;
  const outcome = authorized
    ? transition
    : `${receipt.refusal?.stage ?? 'unknown'}/${receipt.refusal?.code ?? 'Unrecorded'}`;
  return {
    // stdout restates the receipt's identity, never its contents: everything worth
    // reading is in the file the command reserved. Nothing here is GitHub-derived.
    text: `${receipt.status} ${outcome}\n`
      + `  receipt ${receiptPath}\n`
      + `  revision ${receipt.revision}\n`,
    exitCode: authorized && SETTLED_TRANSITIONS.includes(transition) ? 0 : 1,
  };
}
