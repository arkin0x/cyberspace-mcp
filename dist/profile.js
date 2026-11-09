// profile.ts: the agent's kind 0, and reading other people's. The profile
// says the agent is a bot (NIP-24 "bot": true) and names the human it acts
// for in a p tag marked operator (brief, ruling 5). An agent never hides
// what it is.
export function profileTemplate(fields, createdAt) {
    const content = { bot: true };
    if (fields.name)
        content.name = fields.name;
    if (fields.about)
        content.about = fields.about;
    if (fields.picture)
        content.picture = fields.picture;
    const tags = [];
    if (fields.operator)
        tags.push(['p', fields.operator, '', 'operator']);
    return { kind: 0, created_at: createdAt, content: JSON.stringify(content), tags };
}
/** What a kind 0 says: the name, whether it claims to be a bot (null when it does not say), its operator. */
export function readProfile(ev) {
    if (!ev || ev.kind !== 0)
        return { name: null, bot: null, operator: null };
    let content = {};
    try {
        content = JSON.parse(ev.content);
    }
    catch {
        content = {};
    }
    const name = typeof content.display_name === 'string' && content.display_name.trim() ? content.display_name.trim()
        : typeof content.name === 'string' && content.name.trim() ? content.name.trim() : null;
    const bot = typeof content.bot === 'boolean' ? content.bot : null;
    const operator = ev.tags.find((t) => t[0] === 'p' && t[3] === 'operator')?.[1] ?? null;
    return { name: name ? name.slice(0, 64) : null, bot, operator };
}
/** The longest picture URL a profile carries. */
export const MAX_PICTURE_URL = 2048;
/** A picture URL the profile may carry: https only, no spaces, bounded; null when it is not one. */
export function pictureUrl(raw) {
    const v = raw.trim();
    if (!v || v.length > MAX_PICTURE_URL || /\s/.test(v))
        return null;
    try {
        const u = new URL(v);
        return u.protocol === 'https:' ? u.toString() : null;
    }
    catch {
        return null;
    }
}
/** The name, about and picture a published kind 0 content carried, for fields a later call leaves out. */
export function publishedFields(content) {
    if (!content)
        return {};
    try {
        const c = JSON.parse(content);
        const str = (v) => (typeof v === 'string' && v ? v : undefined);
        return { name: str(c.name), about: str(c.about), picture: str(c.picture) };
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=profile.js.map