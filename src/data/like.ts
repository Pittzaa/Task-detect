/** Escapes LIKE/ILIKE metacharacters so user input is matched literally (default escape char is backslash). */
export const escapeLikeValue = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);
