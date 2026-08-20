import { writeFileSync } from 'node:fs';

import { createPortfolioFactory } from '../src/github-portfolio.mjs';
import { createGitHubReadAdapter } from '../src/github-read-adapter.mjs';

function parseArgs(argv) {
  const result = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`expected --name value, received ${flag}`);
    }
    const name = flag.slice(2);
    if (Object.hasOwn(result, name)) throw new Error(`duplicate option: ${flag}`);
    result[name] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'survey' || !args.organization || !args['policy-revision']) {
    throw new Error('usage: github-portfolio.mjs survey --organization OWNER '
      + '--policy-revision REVISION [--out NEW_FILE]');
  }
  const factory = createPortfolioFactory({ githubRead: createGitHubReadAdapter() });
  const portfolio = await factory.survey({
    organization: args.organization,
    policyRevision: args['policy-revision'],
  });
  const document = `${JSON.stringify(portfolio, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, document, { encoding: 'utf8', flag: 'wx' });
  else process.stdout.write(document);
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
  process.exitCode = 1;
});
