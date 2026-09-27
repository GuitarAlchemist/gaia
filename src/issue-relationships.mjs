// Parse the relationship lines an issue body declares. Pure: no I/O, no GitHub port.
//
// `Depends-On`, `Blocked-By` and `Duplicate-Of` name another issue or assert `NONE`.
// The read adapter and the read-only candidate ranker share this one parser, so they
// cannot disagree about what an issue declares.

function qualifiedReference(reference, repository) {
  return reference.startsWith('#') ? `${repository}${reference}` : reference;
}

export function declaredRelationships(body, repository) {
  const dependencies = [];
  const duplicates = [];
  let dependenciesAreEmpty = false;
  let duplicatesAreEmpty = false;
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const match = line.match(/^\s*(Depends-On|Blocked-By|Duplicate-Of):\s*(NONE|(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9]\d*)\s*$/iu);
    if (!match) continue;
    const relationship = match[1].toLowerCase();
    const isDuplicate = relationship === 'duplicate-of';
    if (match[2].toUpperCase() === 'NONE') {
      if (relationship === 'blocked-by') {
        throw new TypeError('NONE is supported only for Depends-On and Duplicate-Of');
      }
      if (isDuplicate) duplicatesAreEmpty = true;
      else if (relationship === 'depends-on') dependenciesAreEmpty = true;
      continue;
    }
    const reference = qualifiedReference(match[2], repository);
    if (isDuplicate) duplicates.push(reference);
    else dependencies.push(reference);
  }
  const uniqueDuplicates = [...new Set(duplicates)];
  if (uniqueDuplicates.length > 1) dependencies.push(...uniqueDuplicates);
  if ((dependenciesAreEmpty && dependencies.length > 0)
      || (duplicatesAreEmpty && duplicates.length > 0)) {
    throw new TypeError('NONE cannot be combined with a concrete relationship');
  }
  return {
    dependencies: dependenciesAreEmpty ? []
      : dependencies.length > 0 ? [...new Set(dependencies)] : 'UNKNOWN',
    duplicateOf: duplicatesAreEmpty ? null
      : uniqueDuplicates.length === 1 ? uniqueDuplicates[0] : 'UNKNOWN',
  };
}
