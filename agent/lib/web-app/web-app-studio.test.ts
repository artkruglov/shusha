/** The Studio's recipes: the prompt is built by the server from the recipe and the person's own words. */
import { describe, expect, it } from "vitest";

import { STUDIO_RECIPES, studioDescription, studioPrompt } from "./web-app-studio.js";

describe("Studio recipes", () => {
  it("uses the person's words when given and the recipe's default otherwise", () => {
    expect(studioPrompt(STUDIO_RECIPES.interior!, "зелёный бархатный диван")).toContain("зелёный бархатный диван");
    expect(studioPrompt(STUDIO_RECIPES.interior!, "  ")).toContain("a grey sofa");
    expect(studioPrompt(STUDIO_RECIPES.enhance!, undefined)).toContain("Keep the people, their faces");
  });

  it("asks for a photo where a recipe edits one, and a description where it draws from nothing", () => {
    for (const id of ["enhance", "story", "golden", "background", "colorize", "interior"]) expect(STUDIO_RECIPES[id]!.source).toBe("required");
    expect(STUDIO_RECIPES.image!.source).toBe("none");
    expect(STUDIO_RECIPES.card!.source).toBe("optional");
    expect(STUDIO_RECIPES.story!.size).toBe("1024x1536");
  });

  it("captions the gallery in Russian from the recipe and the person's words", () => {
    expect(studioDescription(STUDIO_RECIPES.golden!, undefined)).toBe("Золотой час");
    expect(studioDescription(STUDIO_RECIPES.card!, "бабушке Ирине")).toBe("Открытка к поводу: бабушке Ирине");
  });
});
