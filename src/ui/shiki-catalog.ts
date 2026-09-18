import { createRequire } from "node:module";

// Render callbacks are synchronous. Resolve optional catalogs on the first
// preview, not while loading the extension (even metadata has a static graph).
const require = createRequire(import.meta.url);
let languages: typeof import("shiki/langs")["bundledLanguages"] | undefined;
let themeTypes: Map<string, "light" | "dark"> | undefined;

export const shikiLanguages = (): typeof import("shiki/langs")["bundledLanguages"] =>
  languages ??= (require("shiki/langs") as typeof import("shiki/langs")).bundledLanguages;

export const shikiThemeType = (id: string): "light" | "dark" | undefined => {
  themeTypes ??= new Map((require("shiki/themes") as typeof import("shiki/themes")).bundledThemesInfo.map(theme => [theme.id, theme.type]));
  return themeTypes.get(id);
};
