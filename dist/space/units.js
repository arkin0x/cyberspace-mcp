// units.ts: lengths in gibsons and in the SI units people use (arkinox,
// 2026-11-26: "xor didn't know how to convert them. he should").
//
// The spec puts 2^33 gibsons in a metre (CYBERSPACE_V2 §9.2, §9.7), so a
// gibson is 2^-33 m, about 116.4 pm, and 2^34 gibsons are 2 m. A length with
// a unit ("200 nm", "1.5 µm", "3 m") converts to gibsons exactly, in BigInt,
// and is rounded to the nearest whole gibson only at the end, because a
// coordinate is a whole u85.
//
// formatDistance is sno-core v0.1.34's scale.formatDistance, the one ONOSENDAI
// shows every distance with (Nearby, presence, the cursor, stops), ported
// here because this server pins an older sno-core: the same units, the same
// thresholds, three significant digits, and its astronomical unit of
// 1.496e11 m (not the IAU's 149,597,870,700 m), so the agent and its operator
// read the same figure. A unit string in AU uses that same constant.
/** Gibsons in one metre: 2^33 (spec §9.2). */
export const GIBSONS_PER_METRE = 1n << 33n;
/** The astronomical unit ONOSENDAI uses, in metres (sno-core scale.ts): 1.496e11. */
export const AU_METRES = 149600000000n;
/** The length of an axis, 2^85 gibsons: no offset is longer. */
const AXIS = 1n << 85n;
/** ONOSENDAI's units, smallest first: a length is shown in the first whose threshold (in metres) it is below. */
const SHOWN = [
    { threshold: 1e-9, symbol: 'pm', scale: 1e12 },
    { threshold: 1e-6, symbol: 'nm', scale: 1e9 },
    { threshold: 1e-3, symbol: 'μm', scale: 1e6 },
    { threshold: 1e-2, symbol: 'mm', scale: 1e3 },
    { threshold: 1e-1, symbol: 'cm', scale: 1e2 },
    { threshold: 1e3, symbol: 'm', scale: 1 },
    { threshold: 1e6, symbol: 'km', scale: 1e-3 },
    { threshold: 1e9, symbol: 'Mm', scale: 1e-6 },
    { threshold: 1.496e11, symbol: 'AU', scale: 1 / 1.496e11 },
];
/**
 * A gibson count as ONOSENDAI shows it: "116 pm", "200 nm", "1 m", "0.0426 AU".
 * The same figures as sno-core's formatDistance for every count from 0 up
 * (its 0 is "0"); a negative count is the same with a minus sign.
 */
export function formatDistance(gibsons) {
    if (gibsons < 0n)
        return `-${formatDistance(-gibsons)}`;
    if (gibsons === 0n)
        return '0';
    // Below 2^53 a double holds the count exactly; past it, the shift to micrometres is exact and the rest is noise.
    const metres = gibsons < (1n << 53n)
        ? Number(gibsons) / 2 ** 33
        : Number((gibsons * 1000000n) >> 33n) / 1_000_000;
    for (let i = 0; i < SHOWN.length; i++) {
        const u = SHOWN[i];
        if (metres < u.threshold || i === SHOWN.length - 1)
            return `${parseFloat((metres * u.scale).toPrecision(3))} ${u.symbol}`;
    }
    return `${metres} m`;
}
export function distanceData(gibsons) {
    return { gibsons: gibsons.toString(), human: formatDistance(gibsons) };
}
/** "1718 gibsons (200 nm)": how a result says a distance in text. */
export function distanceText(gibsons) {
    const n = gibsons < 0n ? -gibsons : gibsons;
    return `${gibsons.toString()} gibson${n === 1n ? '' : 's'} (${formatDistance(gibsons)})`;
}
const p10 = (n) => 10n ** BigInt(n);
/** Symbols, matched exactly (mm is not Mm). */
const SYMBOLS = {
    pm: { num: 1n, den: p10(12) },
    nm: { num: 1n, den: p10(9) },
    'µm': { num: 1n, den: p10(6) }, // the micro sign
    'μm': { num: 1n, den: p10(6) }, // Greek mu, as ONOSENDAI writes it
    um: { num: 1n, den: p10(6) },
    mm: { num: 1n, den: p10(3) },
    cm: { num: 1n, den: p10(2) },
    m: { num: 1n, den: 1n },
    km: { num: p10(3), den: 1n },
    Mm: { num: p10(6), den: 1n },
    AU: { num: AU_METRES, den: 1n },
    au: { num: AU_METRES, den: 1n },
    G: { num: 1n, den: 1n, gibsons: true },
};
/** Names, matched in any case, singular or plural, metre or meter. */
const NAMES = {
    picometre: SYMBOLS.pm,
    nanometre: SYMBOLS.nm,
    micrometre: SYMBOLS.um,
    micron: SYMBOLS.um,
    millimetre: SYMBOLS.mm,
    centimetre: SYMBOLS.cm,
    metre: SYMBOLS.m,
    kilometre: SYMBOLS.km,
    megametre: SYMBOLS.Mm,
    'astronomical unit': SYMBOLS.AU,
    gibson: SYMBOLS.G,
};
function unitOf(text) {
    // Own keys only: "5 constructor" is no unit.
    if (Object.hasOwn(SYMBOLS, text))
        return SYMBOLS[text];
    const name = text.toLowerCase().replace(/\s+/g, ' ').replace(/meter/g, 'metre').replace(/s$/, '');
    return Object.hasOwn(NAMES, name) ? NAMES[name] : null;
}
/** The units a length may be given in, for the sentence that refuses one. */
export const UNIT_WORDS = 'pm, nm, µm (or μm or um), mm, cm, m, km, Mm, AU, or gibsons';
/** A decimal number, then a unit: "200nm", "-1.5 µm", "3e2 m", ".5 mm". */
const LENGTH = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?\s*(.*)$/;
/**
 * A length with a unit, converted exactly to gibsons; null when the text has
 * no unit (a plain gibson count, which the caller reads as before). Throws a
 * sentence for anything else: no number, an unknown unit, a length that
 * rounds to no gibson at all, or one longer than an axis.
 */
export function convertLength(text, name = 'the length') {
    const given = text.trim();
    const fail = (why) => { throw new Error(`${name}: ${why}; got ${JSON.stringify(text)}. Give whole gibsons ("1718") or a length with a unit ("200 nm", "1.5 µm", "3 m"): ${UNIT_WORDS}.`); };
    if (given.length > 64)
        fail('too long to be a length');
    const m = LENGTH.exec(given);
    if (!m)
        return fail('not a length');
    const [, sign, whole, frac = '', exp, rest] = m;
    const unitText = rest.trim();
    if (!unitText) {
        // A plain integer is a gibson count, the caller's to read; a fraction or an exponent of gibsons with no unit is not.
        if (frac !== '' || exp !== undefined || given.includes('.'))
            fail('a gibson count with no unit is a whole number; a fraction or an exponent needs a unit');
        return null;
    }
    if (whole === '' && frac === '')
        fail('no number before the unit');
    const unit = unitOf(unitText);
    if (!unit)
        fail(`"${unitText}" is not a unit this server knows`);
    // value = digits * 10^(e - fraction digits); gibsons = value * metres per unit * 2^33 (or value, for gibsons).
    const digits = BigInt(`${whole}${frac}` || '0');
    const e = Number(exp ?? 0) - frac.length;
    let num = digits * unit.num * (unit.gibsons ? 1n : GIBSONS_PER_METRE);
    let den = unit.den;
    if (e >= 0)
        num *= p10(e);
    else
        den *= p10(-e);
    let q = num / den;
    const r = num % den;
    if (2n * r > den || (2n * r === den && q % 2n === 1n))
        q += 1n;
    if (q === 0n && digits !== 0n)
        fail('that is half a gibson or less (a gibson is 2^-33 m, about 116 pm), so it rounds to no gibson at all');
    if (q > AXIS)
        fail('that is longer than an axis of cyberspace (2^85 gibsons, about 30,100 AU)');
    return { given, gibsons: sign === '-' ? -q : q, exact: r === 0n };
}
/**
 * The gibson offsets given with a unit in a tool's arguments: every dx, dy and
 * dz under target, coordinate, to, origin, by and find's hint.coordinate, with what each came to.
 * Bad text is left for the tool to refuse in its own words.
 */
export function unitConversions(args) {
    const out = [];
    const hint = args.hint && typeof args.hint === 'object' ? args.hint.coordinate : undefined;
    for (const [key, v] of [['target', args.target], ['coordinate', args.coordinate], ['to', args.to], ['origin', args.origin], ['by', args.by], ['hint.coordinate', hint]]) {
        if (!v || typeof v !== 'object' || Array.isArray(v))
            continue;
        for (const axis of ['dx', 'dy', 'dz']) {
            const s = v[axis];
            if (typeof s !== 'string')
                continue;
            let c;
            try {
                c = convertLength(s);
            }
            catch {
                continue;
            }
            if (c)
                out.push({ field: `${key}.${axis}`, given: c.given, gibsons: c.gibsons.toString(), exact: c.exact, human: formatDistance(c.gibsons) });
        }
    }
    return out;
}
/** The conversions as one line at the end of a result. */
export function conversionWords(conversions) {
    return `Units: ${conversions.map((c) => `${c.field} ${JSON.stringify(c.given)} = ${c.gibsons} gibsons${c.exact ? '' : ' (rounded to the nearest gibson)'}`).join('; ')}. A gibson is 2^-33 m, about 116 pm.`;
}
/**
 * The units, as the MCP instructions teach them (a client sends those every
 * session, so this stays short): gibsons in one of each unit, worked out
 * from 2^33 a metre, and an example.
 */
export const UNITS_GUIDE = [
    'Units: a gibson is 2^-33 m, about 116 pm; 2^33 gibsons are 1 m, 2^34 are 2 m. Gibsons in one:',
    '| pm | 0.0085899 |',
    '| nm | 8.5899 |',
    '| μm | 8,589.9 |',
    '| mm | 8,589,934.6 |',
    '| m | 8,589,934,592 |',
    '| km | 8,589,934,592,000 |',
    '| AU (1.496e11 m) | 1,285,054,214,963,200,000,000 |',
    'Example: 200 nm = 200 x 8.5899 = 1,717.98, so 1,718 gibsons. Offsets (dx, dy, dz; move_placed\'s by) also take a length as a string, "200 nm", "1.5 µm" (or "um"), "3 m", and the result says the gibsons. Results give distances in gibsons and in the unit ONOSENDAI shows.',
].join('\n');
//# sourceMappingURL=units.js.map