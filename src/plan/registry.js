// The one component registry available to plan MDX. Anything not here does
// not exist for plan authors (imports are disabled by the compiler).
import { createElement } from "react";
import { Code, AnnotatedCode, Diff } from "./blocks/Code";
import { Diagram } from "./blocks/Diagram";
import { FileTree } from "./blocks/FileTree";
import { Callout } from "./blocks/Callout";
import { ApiEndpoint } from "./blocks/ApiEndpoint";
import { DataModel } from "./blocks/DataModel";
import { QuestionForm } from "./blocks/QuestionForm";
import { Checklist } from "./blocks/Checklist";
import { Options } from "./blocks/Options";
import { Canvas, Artboard, Note } from "./blocks/canvas/Canvas";
import {
  Row,
  Col,
  Box,
  Text,
  Button,
  Input,
  Img,
  Pill,
  Divider,
} from "./blocks/canvas/primitives";

// Route markdown fences (<pre><code class="language-x">) into the shiki block
function Pre(props) {
  const child = props.children?.props;
  if (child && typeof child.children === "string") {
    const lang = (child.className || "").replace("language-", "") || "text";
    return createElement(Code, { code: child.children, lang });
  }
  return createElement("pre", props);
}

export const registry = {
  // blocks
  Diagram,
  FileTree,
  Code,
  AnnotatedCode,
  Diff,
  Callout,
  ApiEndpoint,
  DataModel,
  QuestionForm,
  Checklist,
  Options,
  Canvas,
  Artboard,
  Note,
  Row,
  Col,
  Box,
  Text,
  Button,
  Input,
  Img,
  Pill,
  Divider,
  // markdown element overrides
  pre: Pre,
};
