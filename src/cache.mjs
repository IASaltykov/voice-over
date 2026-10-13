/** Decides whether an existing final MP3 is safe to reuse. */
export async function isCurrentOutput({ target, previous, textHash, configHash, filename, probe }) {
  const existing = await probe(target);
  return Boolean(
    existing.valid
      && previous?.textHash === textHash
      && previous?.configHash === configHash
      && previous?.filename === filename,
  );
}
