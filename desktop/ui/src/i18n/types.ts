// Shapes shared by every language pack (see i18n/index.ts).

/** Plural forms, picked with Intl.PluralRules. English and Spanish use one/other. */
export interface Plural { one: string; few?: string; many?: string; other: string }
/** Ukrainian needs all of them: 1 людина, 2 людини, 5 людей, 1,5 людини. */
export interface UkPlural { one: string; few: string; many: string; other: string }

/**
 * A translation of the English pack `T`: same keys, strings stay strings,
 * plural entries stay plural. A missing or extra key fails `tsc`.
 */
export type Pack<T, P = Plural> = { [K in keyof T]: T[K] extends string ? string : P };
