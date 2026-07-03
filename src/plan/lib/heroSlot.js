// The plan's top visual surface. The first <Canvas> in a plan claims this
// slot and portals itself above the doc/TOC columns, full-bleed; `inline`
// canvases stay in the document flow.
import { createContext } from "react";

export const HeroSlotCtx = createContext(null); // { el, claim() }
