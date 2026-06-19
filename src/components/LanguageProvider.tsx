import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { Languages } from "lucide-react";
import { getLang, setLangVar, type Lang } from "../lib/i18n";

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
}
const Ctx = createContext<LangCtx>({ lang: "en", setLang: () => {} });

// eslint-disable-next-line react-refresh/only-export-components
export function useLang(): LangCtx {
  return useContext(Ctx);
}

/**
 * Holds the current language and REMOUNTS its children (via key) when it
 * changes, so every module-level t() call re-evaluates in the new language.
 * Placed below FinanceProvider so toggling does not refetch data.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(getLang());
  const change = useCallback((l: Lang) => {
    setLangVar(l);
    try {
      localStorage.setItem("hb-lang", l);
    } catch {
      /* ignore */
    }
    setLang(l);
  }, []);
  return (
    <Ctx.Provider value={{ lang, setLang: change }}>
      <div key={lang}>{children}</div>
    </Ctx.Provider>
  );
}

/** A compact button that flips between English and 中文. */
export function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <button
      onClick={() => setLang(lang === "en" ? "zh" : "en")}
      className="notranslate flex items-center gap-1 rounded-full px-2 py-1.5 text-[12px] font-semibold text-taupe transition hover:bg-raised hover:text-bone"
      aria-label={lang === "en" ? "切换到中文 · Switch to Chinese" : "Switch to English · 切换到英文"}
    >
      <Languages size={14} />
      <span className="notranslate">{lang === "en" ? "中" : "EN"}</span>
    </button>
  );
}
