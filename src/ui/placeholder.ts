/** UI text that waits for the owner's wording. */
export const placeholderTexts = new Set<string>();

/** Marks UI text as a placeholder: it shows as is and is listed in placeholderTexts. */
export function placeholder(text: string): string {
  placeholderTexts.add(text);
  return text;
}
