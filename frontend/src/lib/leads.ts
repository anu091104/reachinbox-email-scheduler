/**
 * Pulls email addresses out of an uploaded CSV / TXT lead list.
 * Works whether the file has a header row, one address per line, or several
 * columns (name,email,company). Duplicates are removed, case-insensitively.
 */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function extractEmails(text: string): string[] {
  const found = text.match(EMAIL_IN_TEXT) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/^['"]|['"]$/g, '')))];
}

export async function readLeadFile(file: File): Promise<string[]> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Lead file must be under 5 MB');
  return extractEmails(await file.text());
}
