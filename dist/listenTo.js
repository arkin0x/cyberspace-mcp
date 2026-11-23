// listenTo.ts: whose words reach the model (arkinox, 2026-11-23: "XOR should
// ignore all input from any pubkey that isn't the operator, full stop. No
// interaction. No banter. Nothing. Totally drop it unless the operator/owner
// sends it.").
//
// With listenTo "operator", text authored by any pubkey but the agent's own
// and its operator's is dropped where it comes in, so no tool shows it and no
// turn wakes for it:
//   - chat lines (chat.ts): not stored, not listened to, not counted, no wake;
//     say names nobody else;
//   - DMs and gift wraps (operator.ts): never orders already; not even counted;
//   - profile text (presence.ts): a stranger has no name, only a pubkey;
//   - what strangers hid or published (bags, chests, doors, objects, comments,
//     riddles and hints): where it is, its kind and ids still show (the world),
//     its words (names, messages, descriptions, riddles, comments) never do.
// "everyone" (the default) is the old behavior. The operator may be the one
// the profile names or the one the human configured; with neither, only the
// agent's own words remain.
/** What stands in for a stranger's words in a tool's answer. */
export const WITHHELD = '(withheld: written by someone other than your operator)';
export class Listener {
    mode;
    me;
    operators;
    constructor(mode, me, 
    /** The operators the human chose (the profile's and the configured one), any of them null. */
    operators) {
        this.mode = mode;
        this.me = me;
        this.operators = operators;
    }
    /** Only the operator's words (and the agent's own) reach the model. */
    get operatorOnly() {
        return this.mode === 'operator';
    }
    /** Whether words this pubkey wrote may reach the model. */
    hears(pubkey) {
        if (this.mode === 'everyone')
            return true;
        if (!pubkey)
            return false;
        const p = pubkey.toLowerCase();
        if (p === this.me)
            return true;
        return this.operators().some((o) => !!o && o.toLowerCase() === p);
    }
    /** The text as written when its author is heard; WITHHELD (or the fallback) when not. */
    text(author, value, fallback = WITHHELD) {
        if (value === null || value === undefined || value === '')
            return value;
        return this.hears(author) ? value : fallback;
    }
}
/** Everyone is heard: the default, and what the parts of the server built without a Listener use. */
export const EVERYONE = new Listener('everyone', '', () => []);
/**
 * The item with its author's words withheld: a message's text, a shard's
 * name, a key's name, about and model address, a chest's name and what it
 * says it requires, an audio's title and about. Everything else (ids, kinds,
 * keys, geometry, places) is the world and is kept. Never changes the object
 * it is given.
 */
export function withholdWords(item) {
    const out = { ...item };
    if (out.text !== undefined)
        out.text = WITHHELD;
    if (out.shard)
        out.shard = { ...out.shard, name: WITHHELD };
    if (out.key) {
        const { model: _model, ...key } = out.key;
        out.key = { ...key, name: WITHHELD, about: '' };
    }
    if (out.chest)
        out.chest = { ...out.chest, name: WITHHELD, requires: out.chest.requires ? WITHHELD : out.chest.requires };
    if (out.audio)
        out.audio = { ...out.audio, title: WITHHELD, about: '' };
    return out;
}
/**
 * What the state directory kept from before listenTo became "operator", with
 * every word another author wrote withheld, in memory: bags read by find
 * (riddles, labels, key sentences, chest words), held items, contents taken
 * from chests and chests seen. Each record is replaced only when it changes,
 * and the store writes it as it is the next time it saves that file, so a
 * stranger's words are dropped from the state too, never brought back.
 */
export function scrubSaved(keys, l) {
    if (!l.operatorOnly)
        return;
    const chestHeard = (id) => {
        const c = id ? keys.chests.get(id) : undefined;
        return !!c && l.hears(c.author);
    };
    for (const [id, b] of keys.bags) {
        const entries = b.entries.map((e) => {
            if (l.hears(e.author) && !e.chest?.contents?.some((c) => !(c.verified && l.hears(c.author))))
                return e;
            const heard = l.hears(e.author);
            return {
                ...e,
                label: heard ? e.label : WITHHELD,
                ...(e.key ? { key: { ...e.key, about: heard ? e.key.about : '' } } : {}),
                ...(e.chest ? {
                    chest: {
                        ...e.chest,
                        requires: heard ? e.chest.requires : (e.chest.requires ? WITHHELD : e.chest.requires),
                        ...(e.chest.contents ? { contents: e.chest.contents.map((c) => (c.verified && l.hears(c.author) ? c : { ...c, label: WITHHELD })) } : {}),
                    },
                } : {}),
            };
        });
        const riddle = l.hears(b.author) ? b.riddle : (b.riddle ? WITHHELD : b.riddle);
        if (riddle !== b.riddle || entries.some((e, i) => e !== b.entries[i]))
            keys.bags.set(id, { ...b, riddle, entries });
    }
    for (const [id, i] of keys.items) {
        const heard = l.hears(i.hider);
        const fromHeard = !i.from || chestHeard(i.from.chestId);
        if (heard && fromHeard)
            continue;
        const { model: _m, animation: _a, carried: _c, ...rest } = i;
        keys.items.set(id, {
            ...(heard ? i : { ...rest, name: WITHHELD, about: '' }),
            ...(i.from ? { from: { ...i.from, chestName: fromHeard ? i.from.chestName : WITHHELD } } : {}),
        });
    }
    for (const [id, t] of keys.taken) {
        const heard = t.verified && l.hears(t.author);
        const fromHeard = chestHeard(t.from.chestId);
        if (heard && fromHeard)
            continue;
        keys.taken.set(id, {
            ...t,
            ...(heard ? {} : { name: WITHHELD, ...(t.text !== undefined ? { text: WITHHELD } : {}) }),
            from: { ...t.from, chestName: fromHeard ? t.from.chestName : WITHHELD },
        });
    }
    for (const [id, c] of keys.chests) {
        if (l.hears(c.author))
            continue;
        keys.chests.set(id, { ...c, name: WITHHELD, requires: c.requires ? WITHHELD : c.requires });
    }
}
//# sourceMappingURL=listenTo.js.map