// Runtime MDX compilation. No `baseUrl` means import/export statements fail
// at compile time — plans can only use the built-in component registry.
import { useEffect, useState } from "react";
import { evaluate } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";

export function useMdx(source) {
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    if (source == null) {
      setState({ status: "loading" });
      return;
    }
    let alive = true;
    (async () => {
      try {
        // plugin-react runs the page on the dev runtime in dev builds; the
        // MDX output must use the same runtime or React 19 warns/mismatches
        const runtime = import.meta.env.DEV
          ? { ...jsxDevRuntime, development: true }
          : { ...jsxRuntime, development: false };
        const mod = await evaluate(source, {
          ...runtime,
          remarkPlugins: [remarkGfm],
          format: "mdx",
        });
        if (alive) setState({ status: "ok", Content: mod.default });
      } catch (error) {
        if (alive) setState({ status: "error", error });
      }
    })();
    return () => {
      alive = false;
    };
  }, [source]);

  return state;
}
