/**
 * A word with its indefinite article, "an audio" or "a video": by the word's first letter, which is how every kind
 * name a message puts after an article reads (resource, library, element, desk unit and track kinds, and recipe
 * parameter types such as "an id"; none starts with a vowel letter read as a consonant, like "unit", or with a silent
 * consonant, like "hour").
 */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

/**
 * A count with its noun, agreeing with it: "1 shot", "0 shots", "3 shots" (`many` for a plural that is not the noun
 * with an s: "1 person", "2 people"). Every count a message shows is written this way (docs/brand.md#voice): never
 * "shot(s)", never "1 shots".
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The word that agrees with a count, for the verb or pronoun after it: `one` for exactly 1, `many` for any other count
 * ("1 line is", "2 lines are"; `${plural(n, 'shot')} ${byCount(n, 'needs', 'need')} review`).
 */
export function byCount(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
