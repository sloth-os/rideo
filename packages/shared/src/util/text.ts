/**
 * A word with its indefinite article, "an audio" or "a video": by the word's first letter, which is how every kind
 * name a message puts after an article reads (resource, library, element and track kinds; none starts with a vowel
 * letter read as a consonant, like "unit", or with a silent consonant, like "hour").
 */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}
