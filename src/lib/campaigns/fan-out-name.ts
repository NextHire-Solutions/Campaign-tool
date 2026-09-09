/**
 * The name for one client's copy of a template campaign.
 *
 * `{client}` is substituted wherever it appears; a template without the token
 * gets the client name prefixed instead. That fallback is the point of this
 * function existing: campaigns are identified by name everywhere in this
 * product — every list, the client filter, and the auto attribution that reads
 * the client out of the campaign name — so a template of "Q3 push" fanned to
 * five clients must not produce five campaigns called "Q3 push".
 *
 * Lives apart from fan-out.ts so it can be tested: that module pulls in the
 * EmailBison client through a `@/` alias, which `node --test` cannot resolve.
 */
export function renderName(template: string, clientName: string): string {
  return template.includes("{client}")
    ? template.replaceAll("{client}", clientName).trim()
    : `${clientName} — ${template}`.trim();
}
