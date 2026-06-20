import { useEffect, useRef, useState } from "react";

/** True if the user asked the OS to reduce motion — gates all our animation. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    const fn = () => setReduced(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return reduced;
}

/**
 * Tick a number from its previous value to `value` over ~600ms (ease-out) so big
 * figures "arrive". Honors reduced-motion (snaps straight to the value).
 */
export function useCountUp(value: number, ms = 600): number {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(0);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = from + (value - from) * eased;
      setDisplay(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms, reduced]);

  return display;
}

/** True once the page has scrolled past `threshold` — collapses the header. */
export function useScrolled(threshold = 120): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        setScrolled(window.scrollY > threshold);
        raf = 0;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [threshold]);
  return scrolled;
}

/**
 * Fade-up-on-reveal. Returns a ref + the `is-visible` class state. Elements
 * already in view flip visible on the observer's first (async) callback, so the
 * first screenful animates in immediately. Reduced-motion → always visible.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(): {
  ref: (el: T | null) => void;
  shown: boolean;
} {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(false);
  const elRef = useRef<T | null>(null);
  const obsRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (reduced) setShown(true);
  }, [reduced]);

  const ref = (el: T | null) => {
    elRef.current = el;
    if (obsRef.current) {
      obsRef.current.disconnect();
      obsRef.current = null;
    }
    if (!el || reduced) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          obs.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    obs.observe(el);
    obsRef.current = obs;
  };

  return { ref, shown: shown || reduced };
}
