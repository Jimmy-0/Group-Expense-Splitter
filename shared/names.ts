/** Case- and form-insensitive identity of a member name: "Émile", "émile" and "E\u0301mile" collide. */
export function memberNameKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase();
}
